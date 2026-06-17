import {
  type Observation,
  type EventsObservation,
  ObservationLevel,
  paginationMetaResponseZod,
  publicApiPaginationZod,
  singleFilter,
  InvalidRequestError,
} from "@langfuse/shared";
import {
  reduceUsageOrCostDetails,
  stringDateTime,
  type ObservationPriceFields,
} from "@langfuse/shared/src/server";
import {
  OBSERVATION_FIELD_GROUPS_PUBLIC_API,
  type ObservationFieldGroupPublicApi,
} from "@langfuse/shared";
import { z } from "zod";
import { useEventsTableSchema } from "@langfuse/shared/query";

// Re-export for convenience
export {
  OBSERVATION_FIELD_GROUPS_PUBLIC_API,
  type ObservationFieldGroupPublicApi,
};

/**
 * Objects
 */

const ObservationType = z.enum([
  "GENERATION",
  "SPAN",
  "EVENT",
  "AGENT",
  "TOOL",
  "CHAIN",
  "RETRIEVER",
  "EVALUATOR",
  "EMBEDDING",
  "GUARDRAIL",
]);

export const APIObservation = z
  .object({
    id: z.string(),
    projectId: z.string(),
    traceId: z.string().nullable(),
    parentObservationId: z.string().nullable(),
    name: z.string().nullable(),
    type: ObservationType,
    environment: z.string().default("default"),
    startTime: z.coerce.date(),
    endTime: z.coerce.date().nullable(),
    version: z.string().nullable(),
    release: z.string().nullable().optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
    input: z.any(),
    output: z.any(),
    metadata: z.any(),
    level: z.enum(["DEBUG", "DEFAULT", "WARNING", "ERROR"]),
    statusMessage: z.string().nullable(),

    model: z.string().nullable(),
    modelParameters: z.any(),
    completionStartTime: z.coerce.date().nullable(),

    // prompt
    promptId: z.string().nullable(),
    promptName: z.string().nullable(),
    promptVersion: z.number().int().positive().nullable(),

    // usage
    usageDetails: z.record(z.string(), z.number().nonnegative()),
    costDetails: z.record(z.string(), z.number().nonnegative()),
    usage: z.object({
      unit: z.string().nullable(),
      input: z.number(),
      output: z.number(),
      total: z.number(),
    }), // backwards compatibility
    unit: z.string().nullable(), // backwards compatibility
    promptTokens: z.number(), // backwards compatibility
    completionTokens: z.number(), // backwards compatibility
    totalTokens: z.number(), // backwards compatibility
    usagePricingTierName: z.string().nullable(),
    usagePricingTierId: z.string().nullable(),

    // matched model
    modelId: z.string().nullable(),
    inputPrice: z.number().nullable(),
    outputPrice: z.number().nullable(),
    totalPrice: z.number().nullable(),

    // costs
    calculatedInputCost: z.number().nullable(),
    calculatedOutputCost: z.number().nullable(),
    calculatedTotalCost: z.number().nullable(),

    // metrics
    latency: z.number().nullable(),

    // generation metrics
    timeToFirstToken: z.number().nullable(),
  })
  .strict();

/**
 * Transforms
 */

/**
 *
 * @param observation - DB Observation (may include EventsObservation with userId/sessionId, which are excluded from public API)
 * @returns API Observation as defined in the public API
 */
export const transformDbToApiObservation = (
  observation: (Observation | EventsObservation) & ObservationPriceFields,
): z.infer<typeof APIObservation> => {
  const reducedUsageDetails = reduceUsageOrCostDetails(
    observation.usageDetails,
  );
  const reducedCostDetails = reduceUsageOrCostDetails(observation.costDetails);

  const unit = "TOKENS";

  const promptTokens = reducedUsageDetails.input ?? 0;
  const completionTokens = reducedUsageDetails.output ?? 0;
  const totalTokens = reducedUsageDetails.total ?? 0;

  const {
    providedUsageDetails,
    providedCostDetails,

    internalModelId,

    inputCost,

    outputCost,

    totalCost,

    inputUsage,

    outputUsage,

    totalUsage,
    // Exclude userId and sessionId from public API (security/privacy)

    userId,

    sessionId,

    // exclude trace name, this will only be available on events api
    traceName,

    // exclude release, this will only be available on events api
    release,

    // Exclude tags
    tags,
    traceTags,

    // Exclude tool data from public API (not yet released)

    toolDefinitions,

    toolCalls,

    toolCallNames,

    // Exclude publish/bookmark flags from V1 public observations API.
    // V2 observations already exposes these on the events-based contract.
    bookmarked,

    public: _public,
    ...rest
  } = observation as EventsObservation &
    ObservationPriceFields & {
      // The `tags` field is sometimes renamed to `traceTags` depending on context.
      // Since `transformDbToApiObservation` is called from multiple sources,
      // either `tags` or `traceTags` may exist on the input observation.
      // This is not part of the standard `EventsObservation` type.
      traceTags?: string[];
    };

  return {
    ...rest,
    calculatedInputCost: reducedCostDetails.input,
    calculatedOutputCost: reducedCostDetails.output,
    calculatedTotalCost: reducedCostDetails.total,
    unit: unit,
    inputPrice: observation.inputPrice?.toNumber() ?? null,
    outputPrice: observation.outputPrice?.toNumber() ?? null,
    totalPrice: observation.totalPrice?.toNumber() ?? null,
    promptTokens,
    completionTokens,
    totalTokens,
    modelId: observation.internalModelId ?? null,
    usage: {
      unit,
      input: promptTokens,
      output: completionTokens,
      total: totalTokens,
    },
  };
};

/**
 * Endpoints
 */

// GET /observations
export const GetObservationsV1Query = z.object({
  ...publicApiPaginationZod,
  type: ObservationType.nullish(),
  name: z.string().nullish(),
  userId: z.string().nullish(),
  level: z.enum(ObservationLevel).nullish(),
  traceId: z.string().nullish(),
  version: z.string().nullish(),
  parentObservationId: z.string().nullish(),
  environment: z.union([z.array(z.string()), z.string()]).nullish(),
  fromStartTime: stringDateTime,
  toStartTime: stringDateTime,
  useEventsTable: useEventsTableSchema,
  filter: z
    .string()
    .optional()
    .transform((str) => {
      if (!str) return undefined;
      try {
        const parsed = JSON.parse(str);
        return parsed;
      } catch (e) {
        if (e instanceof InvalidRequestError) throw e;
        throw new InvalidRequestError("Invalid JSON in filter parameter");
      }
    })
    .pipe(z.array(singleFilter).optional()),
});
export const GetObservationsV1Response = z
  .object({
    data: z.array(APIObservation),
    meta: paginationMetaResponseZod,
  })
  .strict();

// GET /observations/{observationId}
export const GetObservationV1Query = z.object({
  observationId: z.string(),
  useEventsTable: useEventsTableSchema,
});
export const GetObservationV1Response = APIObservation;
