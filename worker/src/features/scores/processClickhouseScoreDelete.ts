import {
  deleteEntitiesFromGreptime,
  logger,
  traceException,
} from "@langfuse/shared/src/server";

export const processClickhouseScoreDelete = async (
  projectId: string,
  scoreIds: string[],
) => {
  logger.info(
    `Deleting scores ${JSON.stringify(scoreIds)} in project ${projectId} from Clickhouse and S3`,
  );

  try {
    await deleteEntitiesFromGreptime({
      projectId,
      entityType: "score",
      entityIds: scoreIds,
    });
  } catch (e) {
    logger.error(
      `Error deleting scores ${JSON.stringify(scoreIds)} in project ${projectId} from Clickhouse`,
      e,
    );
    traceException(e);
    throw e;
  }
};
