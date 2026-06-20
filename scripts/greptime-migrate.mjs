// Self-contained GreptimeDB schema migration runner for production images.
//
// The app-side source of truth is `packages/shared/src/server/greptime/applyMigrations.ts` (used by
// the test harness and the `greptime:migrate` tsx CLI). Production images have no tsx and must not
// pull the whole `@langfuse/shared` server graph just to migrate — importing it would also trigger
// the full zod env validation. So this runner is deliberately decoupled: it depends only on
// `mysql2` and `pg`, reads the same `.sql` files, and inlines the same idempotency contract. The
// `.sql` files remain the single schema source of truth; keep the splitStatements / errno-1060
// logic here in sync with applyMigrations.ts.
//
// What it does, in order:
//   1. Acquire a Postgres advisory lock (serialises concurrent web replicas; GreptimeDB has no
//      GET_LOCK, but Postgres is a hard dependency and has a real session-scoped advisory lock).
//   2. Create + select the target GreptimeDB database and apply every migration over the MySQL wire,
//      tolerating only errno 1060 (column already exists) so re-runs across restarts are no-ops.
//   3. Apply the database-level retention TTL (idempotent `ALTER DATABASE ... SET 'ttl'`).
//   4. Release the advisory lock and close both connections.
//
// Config comes from env (same names/defaults as packages/shared/src/env.ts):
//   GREPTIME_SQL_HOST (localhost), GREPTIME_SQL_PORT (4002), GREPTIME_USER (root if empty),
//   GREPTIME_PASSWORD, GREPTIME_DB (openfuse), LANGFUSE_GREPTIME_TTL (730d),
//   GREPTIME_MIGRATIONS_DIR (defaults to ./packages/shared/greptime/migrations from cwd),
//   DIRECT_URL || DATABASE_URL (Postgres, for the advisory lock).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import mysql from "mysql2/promise";
import pg from "pg";

const env = process.env;

// A fixed application-defined advisory-lock key. Distinct from any other advisory lock the app
// might take; the exact value only needs to be stable across replicas.
const ADVISORY_LOCK_KEY = "8147390256127364";

const GREPTIME_UNQUOTED_DB = /^[a-z_][a-z0-9_]*$/;
// Conservative humantime subset (no spaces/quotes) so the value is injection-safe inside the
// `SET 'ttl'='...'` literal. The full grammar lives in greptimeRetentionDuration.ts.
const GREPTIME_TTL = /^[0-9]+[0-9a-z]*$/;

const config = {
  host: env.GREPTIME_SQL_HOST || "localhost",
  port: Number(env.GREPTIME_SQL_PORT || 4002),
  user: env.GREPTIME_USER || "root",
  password: env.GREPTIME_PASSWORD || undefined,
  database: env.GREPTIME_DB || "openfuse",
  ttl: (env.LANGFUSE_GREPTIME_TTL || "730d").trim().toLowerCase(),
  migrationsDir:
    env.GREPTIME_MIGRATIONS_DIR ||
    path.resolve(process.cwd(), "packages/shared/greptime/migrations"),
  postgresUrl: env.DIRECT_URL || env.DATABASE_URL || "",
};

const log = (msg) => console.log(`[greptime-migrate] ${msg}`);
const warn = (msg) => console.warn(`[greptime-migrate] ${msg}`);

if (!GREPTIME_UNQUOTED_DB.test(config.database)) {
  throw new Error(
    `GREPTIME_DB '${config.database}' must be an unquoted identifier (a lowercase letter or underscore, then lowercase letters, digits, or underscores).`,
  );
}

// Mirror of splitStatements in applyMigrations.ts: strip line + trailing `-- ...` comments (column
// definitions carry trailing `-- ...; ...` notes whose `;` would otherwise split a CREATE mid-
// statement), then split on `;`. The migration files contain no `--`/`;` inside string literals.
const splitStatements = (sql) =>
  sql
    .split("\n")
    .map((line) => {
      const commentStart = line.indexOf("--");
      return commentStart >= 0 ? line.slice(0, commentStart) : line;
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

// Mirror of isIdempotentReapplyError: tolerate only errno 1060 (column already exists), so a future
// `ALTER TABLE ... ADD COLUMN` re-run is a no-op while every other error still fails the startup.
const isIdempotentReapplyError = (error) =>
  typeof error === "object" && error !== null && error.errno === 1060;

const applyMigrations = async () => {
  // Bootstrap against GreptimeDB's always-present `public` schema: the MySQL handshake rejects an
  // empty database, and the target db may not exist yet.
  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: "public",
  });
  try {
    const quoted = `\`${config.database.replace(/`/g, "``")}\``;
    await connection.query(`CREATE DATABASE IF NOT EXISTS ${quoted}`);
    await connection.query(`USE ${quoted}`);

    const files = readdirSync(config.migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();
    if (files.length === 0) {
      throw new Error(`no .sql migrations found in ${config.migrationsDir}`);
    }

    for (const file of files) {
      const statements = splitStatements(
        readFileSync(path.join(config.migrationsDir, file), "utf8"),
      );
      for (const statement of statements) {
        try {
          await connection.query(statement);
        } catch (error) {
          if (isIdempotentReapplyError(error)) {
            warn(`tolerated idempotent re-apply in ${file}: ${error.message}`);
            continue;
          }
          throw error;
        }
      }
      if (statements.length > 0) {
        log(`applied ${file} (${statements.length} statements)`);
      }
    }

    // Database-level retention TTL (idempotent). Skip rather than fail the whole bootstrap on a
    // malformed value — retention is a policy knob, not schema correctness.
    if (GREPTIME_TTL.test(config.ttl)) {
      // ALTER DATABASE must use the UNQUOTED, regex-validated identifier: GreptimeDB forwards a
      // backtick-quoted ObjectName here as the literal schema name (the quotes become part of the
      // name), so `openfuse` fails with errno 1210 "Failed to find schema". Verified against v1.1.1;
      // same contract as retention.ts. (CREATE/USE DATABASE above do accept the quoted form.)
      await connection.query(
        `ALTER DATABASE ${config.database} SET 'ttl'='${config.ttl}'`,
      );
      log(`retention: database '${config.database}' ttl=${config.ttl}`);
    } else {
      warn(
        `skipping retention: LANGFUSE_GREPTIME_TTL='${config.ttl}' is not a plain duration`,
      );
    }
  } finally {
    await connection.end();
  }
};

const main = async () => {
  log(
    `applying schema to '${config.database}' at ${config.host}:${config.port} (from ${config.migrationsDir})`,
  );

  if (!config.postgresUrl) {
    // No Postgres URL: run unserialised. The app always provides DATABASE_URL, so this only happens
    // in odd standalone setups; a single runner still migrates correctly, just without the
    // cross-replica mutex.
    warn(
      "no DATABASE_URL/DIRECT_URL set; running migrations without a cross-replica advisory lock",
    );
    await applyMigrations();
    return;
  }

  const pgClient = new pg.Client({ connectionString: config.postgresUrl });
  await pgClient.connect();
  try {
    await pgClient.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
    await applyMigrations();
  } finally {
    await pgClient
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
      .catch(() => undefined);
    // If the process crashes mid-migration the Postgres session ends and the lock releases
    // automatically, so it never leaks.
    await pgClient.end().catch(() => undefined);
  }
};

main()
  .then(() => {
    log("schema applied");
    process.exit(0);
  })
  .catch((error) => {
    console.error("[greptime-migrate] failed to apply schema:", error);
    process.exit(1);
  });
