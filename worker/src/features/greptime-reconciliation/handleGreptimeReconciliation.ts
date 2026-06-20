import { randomUUID } from "crypto";
import {
  getGreptimeIngestClient,
  getProjectDeletedAt,
  GREPTIME_RECONCILIATION_MAX_BATCH_SIZE,
  GreptimeReconciliationEventType,
  GreptimeReconciliationQueue,
  type IngestionEntityTypes,
  listRawEventEntities,
  logger,
  parseRawEventHistory,
  QueueJobs,
  readRawEventsForEntity,
  recordIncrement,
  traceException,
} from "@langfuse/shared/src/server";
import { redis } from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";

import { env } from "../../env";
import { IngestionService } from "../../services/IngestionService";
import {
  GreptimeWriter,
  type GreptimeProjectionSink,
} from "../../services/GreptimeWriter";
import { GreptimeBulkWriter } from "../../services/GreptimeBulkWriter";

/**
 * Reconciliation = re-run the existing per-entity rebuild over every entity of a project. raw_events
 * is the source of truth; replaying an entity's full history idempotently writes back the correct
 * projection, so any drift between raw_events and the projection is self-healed. This is rebuild-only:
 * it does not read the current projection, so it cannot diff how many divergences it actually
 * repaired — the metrics report entities attempted/rebuilt, not divergences fixed.
 *
 * One job processes a single keyset page (batchSize entities), flushes the rebuilt projections, and
 * re-enqueues itself with the next cursor until the project is exhausted, so an arbitrarily large
 * project drains without holding a single long-running job.
 */
export async function handleGreptimeReconciliation(
  payload: GreptimeReconciliationEventType,
): Promise<void> {
  const { projectId } = payload;
  // Clamp to [1, ceiling] so neither an oversized env default / forged payload blows one job into a
  // huge scan + rebuild batch, nor a zero/negative value leaves `pageRefs` empty while `hasMore` is
  // true (which would crash on the next-cursor computation). The queue/admin schemas also reject
  // out-of-range values; this is the single resolution point and stays robust regardless.
  const batchSize = Math.max(
    1,
    Math.min(
      payload.batchSize ?? env.LANGFUSE_GREPTIME_RECONCILIATION_BATCH_SIZE,
      GREPTIME_RECONCILIATION_MAX_BATCH_SIZE,
    ),
  );

  if (!redis) throw new Error("Redis not available");
  if (!prisma) throw new Error("Prisma not available");

  // Probe one extra ref (batchSize + 1) so we can tell whether a next page exists without a second
  // round-trip; the extra ref is not rebuilt this job, it only seeds the next cursor.
  const refs = await listRawEventEntities({
    projectId,
    limit: batchSize + 1,
    cursor: payload.cursor,
  });
  const hasMore = refs.length > batchSize;
  const pageRefs = hasMore ? refs.slice(0, batchSize) : refs;

  recordIncrement(
    "langfuse.greptime_reconciliation.raw_events_entities_seen",
    pageRefs.length,
    { projectId },
  );

  // Project-level deletion guard, queried once per page (cheap MAX over the tiny project_tombstones
  // table). Mirrors the per-entity rebuild guard in ingestionQueue: a deleted project has no
  // re-create semantics, so every entity rebuild remains soft-deleted.
  const projectDeletedAt = await getProjectDeletedAt(projectId);

  // Backfill fast path: write decimal-free projections through bulk Arrow Flight, keeping the
  // observation projection unary and gating its EAV on projection success (GreptimeBulkWriter). The
  // bulk writer owns a dedicated manual unary lane so backfill writes never interleave with the live
  // singleton's queue. Off by default -> the unary singleton, identical to before.
  const sink: GreptimeProjectionSink = env.LANGFUSE_GREPTIME_BULK_BACKFILL_ENABLED
    ? new GreptimeBulkWriter({
        client: getGreptimeIngestClient(),
        unary: GreptimeWriter.createManual({
          write: (tables) => getGreptimeIngestClient().write(tables),
        }),
        batchSize: env.LANGFUSE_GREPTIME_BULK_BATCH_SIZE,
      })
    : GreptimeWriter.getInstance();
  const ingestionService = new IngestionService(redis, prisma, sink);

  let reconciled = 0;
  let failures = 0;
  for (const ref of pageRefs) {
    try {
      await rebuildEntity({
        ingestionService,
        projectId,
        entityType: ref.entity_type as IngestionEntityTypes,
        entityId: ref.entity_id,
        projectDeletedAt,
      });
      reconciled++;
    } catch (e) {
      failures++;
      logger.error(
        `Greptime reconciliation rebuild failed for project ${projectId} entity ${ref.entity_type}/${ref.entity_id}`,
        e,
      );
      traceException(e);
    }
  }

  recordIncrement(
    "langfuse.greptime_reconciliation.reconciled_entities",
    reconciled,
    { projectId },
  );
  recordIncrement(
    "langfuse.greptime_reconciliation.rebuild_failures",
    failures,
    { projectId },
  );

  await sink.flushAll(true);

  if (failures > 0) {
    throw new Error(
      `Greptime reconciliation failed to rebuild ${failures} entity/entities for project ${projectId}`,
    );
  }

  if (hasMore) {
    const lastRef = pageRefs[pageRefs.length - 1]!;
    const queue = GreptimeReconciliationQueue.getInstance();
    if (!queue) {
      throw new Error("Greptime reconciliation queue not available");
    }
    await queue.add(QueueJobs.GreptimeReconciliationJob, {
      timestamp: new Date(),
      id: randomUUID(),
      name: QueueJobs.GreptimeReconciliationJob,
      payload: {
        projectId,
        cursor: {
          entityType: lastRef.entity_type,
          entityId: lastRef.entity_id,
        },
        batchSize: payload.batchSize,
      },
    });
  }
}

/**
 * Read an entity's full raw_events history and rebuild its projection from scratch. This is the
 * reconciliation counterpart of ingestionQueue's rebuild core (minus the S3 fallback / seen-cache):
 * read -> parse -> project-delete guard -> mergeAndWrite.
 */
async function rebuildEntity(params: {
  ingestionService: IngestionService;
  projectId: string;
  entityType: IngestionEntityTypes;
  entityId: string;
  projectDeletedAt: number | null;
}): Promise<void> {
  const {
    ingestionService,
    projectId,
    entityType,
    entityId,
    projectDeletedAt,
  } = params;

  const rawRows = await readRawEventsForEntity({
    projectId,
    entityType,
    entityId,
  });
  const { events, minIngestedAtMs, deleted } = parseRawEventHistory(rawRows);

  if (events.length === 0) return;

  const isDeleted = deleted || projectDeletedAt !== null;

  await ingestionService.mergeAndWrite(
    entityType,
    projectId,
    entityId,
    new Date(minIngestedAtMs),
    events,
    isDeleted,
  );
}
