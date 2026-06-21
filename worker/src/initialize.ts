import { prisma } from "@langfuse/shared/src/db";
import { logger } from "@langfuse/shared/src/server";

import { env } from "./env";
import { upsertDefaultModelPrices } from "./scripts/upsertDefaultModelPrices";
import { upsertManagedEvaluators } from "./scripts/upsertManagedEvaluators";
import { upsertLangfuseDashboards } from "./scripts/upsertLangfuseDashboards";

/**
 * The web container applies Postgres migrations; the worker does not, and does not depend on the web.
 * If the worker reaches the seeds below before those migrations have created the tables they need
 * (pricing_tiers, dashboard_widgets), each seed throws "relation does not exist" — and each swallows
 * that error internally, so `initializeWorker` resolves anyway and the worker starts consuming
 * ingestion with NO model prices. Generations then match a model but compute empty cost (total_cost
 * NULL, cost_details {}). Upstream masked this race with an `initializeClickhouseCompatibility()` step
 * that ran first; replacing ClickHouse with GreptimeDB removed that delay and exposed it. So gate the
 * seeds (and, since this is awaited before the queue consumers start, ingestion) on the schema being
 * present. Bounded so a genuinely broken/unreachable DB still surfaces instead of hanging forever.
 */
const waitForSeedSchema = async (): Promise<void> => {
  const deadline = Date.now() + env.LANGFUSE_WORKER_INIT_SCHEMA_WAIT_TIMEOUT_MS;
  let logged = false;
  for (;;) {
    try {
      await prisma.$queryRaw`SELECT 1 FROM pricing_tiers LIMIT 1`;
      await prisma.$queryRaw`SELECT 1 FROM dashboard_widgets LIMIT 1`;
      return;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(
          `Database schema not ready for worker initialization within ${env.LANGFUSE_WORKER_INIT_SCHEMA_WAIT_TIMEOUT_MS}ms ` +
            `(are migrations applied?): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!logged) {
        logger.info(
          "Worker init: waiting for database migrations to be applied before seeding...",
        );
        logged = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
};

export const initializeWorker = async (): Promise<void> => {
  await waitForSeedSchema();

  await Promise.all([
    upsertDefaultModelPrices(),
    upsertManagedEvaluators(),
    upsertLangfuseDashboards(),
  ]);
};
