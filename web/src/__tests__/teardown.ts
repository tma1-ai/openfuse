export default async function teardown() {
  const { redis, logger } = await import("@langfuse/shared/src/server");

  logger.debug(`Redis status ${redis?.status}`);
  if (redis && redis.status !== "end" && redis.status !== "close") {
    redis.disconnect();
  }

  logger.debug("Teardown complete");
}
