/**
 * Schema bootstrap CLI for GreptimeDB.
 *
 * `applyGreptimeMigrations` otherwise only runs from the test harness, so a
 * fresh deploy starts with zero tables. Run this once per environment (and
 * after pulling new `packages/shared/greptime/migrations/*.sql`) to create the
 * target database and apply every migration over the MySQL wire.
 *
 * The migrations are idempotent (`CREATE TABLE IF NOT EXISTS`, `CREATE DATABASE
 * IF NOT EXISTS`), so re-running is safe. After the schema is in place,
 * `applyGreptimeMigrations` also applies the database-level retention TTL
 * (idempotent `ALTER DATABASE ... SET 'ttl'`, default 730d via
 * LANGFUSE_GREPTIME_TTL); see `retention.ts`.
 *
 * Connection target comes from the GREPTIME_* env vars (see
 * packages/shared/src/env.ts); all have local-dev defaults, so this runs
 * against the local stack with no extra config.
 *
 * Run via: `pnpm --filter=@langfuse/shared run greptime:migrate`
 */
import { env } from "../src/env";
import {
  applyGreptimeMigrations,
  closeGreptimeConnections,
  logger,
} from "../src/server";

const main = async (): Promise<void> => {
  const database = env.GREPTIME_DB;
  logger.info(
    `[greptime:migrate] applying schema to '${database}' at ${env.GREPTIME_SQL_HOST}:${env.GREPTIME_SQL_PORT}`,
  );

  await applyGreptimeMigrations(database);

  logger.info(`[greptime:migrate] schema applied to '${database}'`);
};

main()
  .then(async () => {
    // applyGreptimeMigrations uses its own short-lived connection, but release
    // any shared pools defensively so the process exits without lingering
    // sockets.
    await closeGreptimeConnections();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error("[greptime:migrate] failed to apply schema", error);
    await closeGreptimeConnections().catch(() => undefined);
    process.exit(1);
  });
