import { readFileSync, readdirSync } from "fs";
import path from "path";

import mysql from "mysql2/promise";

import { env } from "../../env";
import { logger } from "../logger";
import { applyGreptimeRetention } from "./retention";

/**
 * Apply the GreptimeDB schema migrations (`packages/shared/greptime/migrations/*.sql`) to a
 * database over the MySQL wire. Used by the test harness (vitest globalSetup) and any bootstrap
 * that needs a schema-ready GreptimeDB; production deployments apply the same files out of band.
 *
 * The migrations were authored for manual `mysql ... <db> < NNNN.sql` application and contain no
 * `CREATE DATABASE`, so we create + select the target database first. Statements are separated by
 * stripping comments (`-- ...`, including trailing comments that contain `;`) and splitting on
 * `;` — the migration files are plain DDL with no `--` or `;` inside string literals, so this is
 * safe. `0002_retention.sql` is fully commented (operator documentation), so it contributes no
 * statements; the database-level retention TTL is instead applied programmatically by
 * `applyGreptimeRetention` after the migrations run (see the end of this function).
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../../../greptime/migrations");

const splitStatements = (sql: string): string[] =>
  sql
    .split("\n")
    .map((line) => {
      // Strip line + trailing comments. Column definitions carry trailing `-- ...; ...` notes
      // whose embedded `;` would otherwise split a CREATE TABLE mid-statement.
      const commentStart = line.indexOf("--");
      return commentStart >= 0 ? line.slice(0, commentStart) : line;
    })
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

export const applyGreptimeMigrations = async (
  database: string = env.GREPTIME_DB,
): Promise<void> => {
  // Bootstrap against GreptimeDB's always-present `public` schema: the MySQL handshake rejects an
  // empty database, and the target db may not exist yet (we create it below).
  const connection = await mysql.createConnection({
    host: env.GREPTIME_SQL_HOST,
    port: env.GREPTIME_SQL_PORT,
    user: env.GREPTIME_USER || "root",
    password: env.GREPTIME_PASSWORD || undefined,
    database: "public",
  });

  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, "``")}\``,
    );
    await connection.query(`USE \`${database.replace(/`/g, "``")}\``);

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
      const statements = splitStatements(sql);
      for (const statement of statements) {
        await connection.query(statement);
      }
      if (statements.length > 0) {
        logger.info(
          `[greptime-migrations] applied ${file} (${statements.length} statements)`,
        );
      }
    }

    // Database-level retention. Idempotent `ALTER DATABASE ... SET 'ttl'`; one shared horizon for
    // every table (raw_events, projections, EAV). Default 730d via LANGFUSE_GREPTIME_TTL.
    await applyGreptimeRetention(connection, database);
  } finally {
    await connection.end();
  }
};
