import {
  deleteProjectFromGreptime,
  getDeletedProjects,
  logger,
  recordIncrement,
  traceException,
} from "@langfuse/shared/src/server";
import { env } from "../../env";
import { PeriodicExclusiveRunner } from "../../utils/PeriodicExclusiveRunner";

export const BATCH_PROJECT_CLEANER_LOCK_KEY = "langfuse:batch-project-cleaner";

/**
 * BatchProjectCleaner purges GreptimeDB data for soft-deleted projects.
 *
 * A single instance covers every entity: deleteProjectFromGreptime() removes all projection
 * tables + EAV subtables + dataset_run_items for a project in one call, so the per-table fan-out
 * the ClickHouse cleaner needed is gone. Workers coordinate via a Redis lock so only one deletes
 * at a time.
 *
 * Flow:
 * 1. Query PG for soft-deleted projects (no lock)
 * 2. Under lock, delete each project from GreptimeDB (per-project failures are isolated)
 */
export class BatchProjectCleaner extends PeriodicExclusiveRunner {
  protected get defaultIntervalMs(): number {
    return env.LANGFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS;
  }

  constructor() {
    // TTL = DELETE timeout + 5 minutes buffer
    const lockTtlSeconds =
      Math.ceil(env.LANGFUSE_BATCH_PROJECT_CLEANER_DELETE_TIMEOUT_MS / 1000) +
      300;

    super({
      name: "BatchProjectCleaner",
      lockKey: BATCH_PROJECT_CLEANER_LOCK_KEY,
      lockTtlSeconds,
    });
  }

  /**
   * Start the batch cleaner service
   */
  public override start(): void {
    logger.info(`Starting ${this.instanceName}`, {
      checkIntervalMs: env.LANGFUSE_BATCH_PROJECT_CLEANER_CHECK_INTERVAL_MS,
      sleepOnEmptyMs: env.LANGFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS,
      projectLimit: env.LANGFUSE_BATCH_PROJECT_CLEANER_PROJECT_LIMIT,
      deleteTimeoutMs: env.LANGFUSE_BATCH_PROJECT_CLEANER_DELETE_TIMEOUT_MS,
    });
    super.start();
  }

  /**
   * Process a batch of deleted projects. Returns the delay until next run.
   */
  public override async processBatch(): Promise<number> {
    return this.execute();
  }

  protected async execute(): Promise<number> {
    // Step 1: Query PG for soft-deleted projects (no lock needed)
    let deletedProjects: Array<{ id: string }>;
    try {
      deletedProjects = await getDeletedProjects(
        env.LANGFUSE_BATCH_PROJECT_CLEANER_PROJECT_LIMIT,
      );
    } catch (error) {
      logger.error(`${this.instanceName}: Failed to query deleted projects`, {
        error,
      });
      traceException(error);
      return env.LANGFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS;
    }

    if (deletedProjects.length === 0) {
      return env.LANGFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS;
    }

    // Step 2: Delete each project from GreptimeDB under a distributed lock
    return (
      (await this.withLock(
        async () => {
          let cleaned = 0;
          for (const project of deletedProjects) {
            try {
              await deleteProjectFromGreptime(project.id);
              cleaned += 1;
            } catch (error) {
              recordIncrement(
                "langfuse.batch_project_cleaner.delete_failures",
                1,
              );
              logger.error(
                `${this.instanceName}: Failed to delete project from GreptimeDB`,
                { projectId: project.id, error },
              );
              traceException(error);
            }
          }

          logger.info(`${this.instanceName}: Batch deletion completed`, {
            projectsProcessed: cleaned,
            projectsTargeted: deletedProjects.length,
          });

          return env.LANGFUSE_BATCH_PROJECT_CLEANER_CHECK_INTERVAL_MS;
        },
        async (error) => {
          recordIncrement("langfuse.batch_project_cleaner.delete_failures", 1);
          logger.error(`${this.instanceName}: Batch deletion failed`, {
            error: (error as Error).message,
          });
          return env.LANGFUSE_BATCH_PROJECT_CLEANER_CHECK_INTERVAL_MS;
        },
      )) ?? env.LANGFUSE_BATCH_PROJECT_CLEANER_SLEEP_ON_EMPTY_MS
    );
  }
}
