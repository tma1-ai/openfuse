import type {
  EventRecordInsertType,
  InternalEventsWriter,
  InternalTraceEventInput,
  InternalTraceExperimentContext,
} from "@langfuse/shared/src/server";
import { clickhouseClient, redis } from "@langfuse/shared/src/server";
import { prisma } from "@langfuse/shared/src/db";
import { ClickhouseWriter } from "../../services/ClickhouseWriter";
import { IngestionService } from "../../services/IngestionService";

let internalTraceIngestionService: IngestionService | undefined;

function getInternalTraceIngestionService(): IngestionService {
  if (!internalTraceIngestionService) {
    internalTraceIngestionService = new IngestionService(
      redis as any,
      prisma,
      ClickhouseWriter.getInstance(),
      clickhouseClient(),
    );
  }

  return internalTraceIngestionService;
}

async function writeInternalEventInputs(params: {
  rootSpanId: string;
  eventInputs: InternalTraceEventInput[];
}): Promise<{ rootEventRecord?: EventRecordInsertType }> {
  const service = getInternalTraceIngestionService();

  const eventRecords = await Promise.all(
    params.eventInputs.map((eventInput) =>
      service.createNormalizedEventRecord(eventInput, ""),
    ),
  );

  return {
    rootEventRecord: eventRecords.find(
      (record) => record.span_id === params.rootSpanId,
    ),
  };
}

/**
 * Materialize internal trace event records so experiment eval scheduling can
 * consume the normalized root event record via the ready callback. The records
 * are not persisted on their own; they exist purely as the normalization
 * boundary feeding eval scheduling.
 */
export function createInternalEventsWriter(params?: {
  experimentContext?: InternalTraceExperimentContext;
  onRootEventRecordReady?: (
    rootEventRecord: EventRecordInsertType,
  ) => Promise<void>;
}): InternalEventsWriter {
  return {
    experimentContext: params?.experimentContext,
    write: async (writeParams: {
      rootSpanId: string;
      eventInputs: InternalTraceEventInput[];
    }) => {
      const { rootSpanId, eventInputs } = writeParams;
      const { rootEventRecord } = await writeInternalEventInputs({
        rootSpanId,
        eventInputs,
      });

      if (rootEventRecord && params?.onRootEventRecordReady) {
        await params.onRootEventRecordReady(rootEventRecord);
      }
    },
  };
}
