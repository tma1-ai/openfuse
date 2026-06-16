import { randomUUID } from "node:crypto";
import { describe, expect, it, afterAll, vi } from "vitest";
import type * as SharedEnvModule from "@langfuse/shared/src/env";

vi.hoisted(() => {
  process.env.LANGFUSE_CODE_EVAL_DISPATCHER = "insecure-local";
});

vi.mock("@langfuse/shared/src/env", async (importOriginal) => {
  const actual = await importOriginal<typeof SharedEnvModule>();

  return {
    ...actual,
    env: {
      ...actual.env,
      LANGFUSE_CODE_EVAL_DISPATCHER: "insecure-local",
      NEXT_PUBLIC_LANGFUSE_CLOUD_REGION: undefined,
    },
  };
});

import type { Session } from "next-auth";
import {
  EvalTemplateSourceCodeLanguage,
  EvalTemplateType,
} from "@prisma/client";
import { env } from "@/src/env.mjs";
import { appRouter } from "@/src/server/api/root";
import { createInnerTRPCContext } from "@/src/server/api/trpc";
import { prisma } from "@langfuse/shared/src/db";
import {
  createEvent,
  createEventsAsGreptime,
  createExperimentEventsAsGreptime,
  createObservation,
  createObservationsGreptime,
  createOrgProjectAndApiKey,
  createTrace,
  createTracesGreptime,
  getScoresUiTable,
  getTracesByIds,
} from "@langfuse/shared/src/server";
import { EvalTargetObject } from "@langfuse/shared";

// events_full is gone: seed the GreptimeDB observations projection plus a
// synthesized denormalised trace so the eval target observation resolves.
const seedObservationEvents = (
  events: Parameters<typeof createEventsAsGreptime>[0],
) => createEventsAsGreptime(events, { synthesizeTraces: true });

const orgIds: string[] = [];

const maybe =
  env.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN === "true"
    ? describe
    : describe.skip;

async function prepare() {
  const { project, org } = await createOrgProjectAndApiKey();

  const session: Session = {
    expires: "1",
    user: {
      id: "user-1",
      canCreateOrganizations: true,
      name: "Demo User",
      organizations: [
        {
          id: org.id,
          name: org.name,
          role: "OWNER",
          plan: "cloud:hobby",
          cloudConfig: undefined,
          metadata: {},
          aiFeaturesEnabled: true,
          aiTelemetryEnabled: true,
          projects: [
            {
              id: project.id,
              role: "ADMIN",
              retentionDays: 30,
              deletedAt: null,
              name: project.name,
              hasTraces: false,
              metadata: {},
              createdAt: project.createdAt.toISOString(),
            },
          ],
        },
      ],
      featureFlags: {
        excludeClickhouseRead: false,
        templateFlag: true,
        v4BetaToggleVisible: false,
        observationEvals: false,
        experimentsV4Enabled: false,
        monitors: false,
        inAppAgent: false,
      },
      admin: true,
    },
    environment: {
      enableExperimentalFeatures: false,
      selfHostedInstancePlan: "cloud:hobby",
    },
  };

  const ctx = createInnerTRPCContext({ session, headers: {} });
  const caller = appRouter.createCaller({ ...ctx, prisma });

  orgIds.push(org.id);

  return { project, caller };
}

maybe("evals.testRunCodeEval", () => {
  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: {
        id: { in: orgIds },
      },
    });
  });

  it("runs a saved code template against unsaved evaluator config without persisting eval state", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();
    const savedSource = `
      function evaluate(ctx) {
        const matched =
          ctx.observation.input.question === "2+2" &&
          ctx.observation.output === "4" &&
          ctx.observation.metadata.rubric === "math";

        return { scores: [{ name: "saved-test-score", value: matched, dataType: "BOOLEAN" }] };
      }
    `;

    const template = await prisma.evalTemplate.create({
      data: {
        projectId: project.id,
        name: "Saved code evaluator",
        version: 1,
        type: EvalTemplateType.CODE,
        prompt: null,
        outputDefinition: undefined,
        sourceCode: savedSource,
        sourceCodeLanguage: EvalTemplateSourceCodeLanguage.TYPESCRIPT,
      },
    });

    await seedObservationEvents([
      createEvent({
        project_id: project.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
        input: JSON.stringify({ question: "2+2" }),
        output: "4",
        metadata_names: ["quality"],
        metadata_values: [JSON.stringify({ rubric: "math" })],
      }),
    ]);

    const jobConfigCountBefore = await prisma.jobConfiguration.count({
      where: { projectId: project.id },
    });
    const jobExecutionCountBefore = await prisma.jobExecution.count({
      where: { projectId: project.id },
    });

    const response = await caller.evals.testRunCodeEval({
      projectId: project.id,
      evalTemplateId: template.id,
      target: EvalTargetObject.EVENT,
      scoreName: "unsaved-score",
      observationId,
      traceId,
      startTime,
      mapping: [
        {
          templateVariable: "input",
          selectedColumnId: "input",
          jsonSelector: null,
        },
        {
          templateVariable: "output",
          selectedColumnId: "output",
          jsonSelector: null,
        },
        {
          templateVariable: "metadata",
          selectedColumnId: "metadata",
          jsonSelector: "$.quality",
        },
      ],
    });

    expect(response).toEqual({
      success: true,
      result: {
        scores: [
          {
            name: "saved-test-score",
            value: 1,
            dataType: "BOOLEAN",
          },
        ],
      },
      executionTraceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      executionTraceFromTimestamp: expect.any(Date),
    });

    await expect(
      prisma.jobConfiguration.count({ where: { projectId: project.id } }),
    ).resolves.toBe(jobConfigCountBefore);
    await expect(
      prisma.jobExecution.count({ where: { projectId: project.id } }),
    ).resolves.toBe(jobExecutionCountBefore);

    const persistedScores = await getScoresUiTable({
      projectId: project.id,
      filter: [],
      orderBy: null,
    });

    expect(persistedScores.length).toBe(0);
  });

  it("runs against legacy observations when events table evals are disabled", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();
    const template = await createCodeTemplate(
      project.id,
      `
        function evaluate(ctx) {
          const matched =
            ctx.observation.input === "legacy input" &&
            ctx.observation.output === "legacy output" &&
            ctx.observation.metadata === "legacy";

          return { scores: [{ name: "legacy-observation-score", value: matched ? 1 : 0, dataType: "BOOLEAN" }] };
        }
      `,
    );

    await createTracesGreptime([
      createTrace({
        id: traceId,
        project_id: project.id,
        timestamp: startTime.getTime(),
      }),
    ]);
    await createObservationsGreptime([
      createObservation({
        id: observationId,
        trace_id: traceId,
        project_id: project.id,
        start_time: startTime.getTime(),
        input: "legacy input",
        output: "legacy output",
        metadata: { quality: "legacy" },
      }),
    ]);

    const mutableEnv = env as unknown as {
      LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN: "true" | "false";
    };
    const originalEventsTableFlagsFlag =
      mutableEnv.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN;

    try {
      mutableEnv.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN = "false";

      const response = await caller.evals.testRunCodeEval({
        projectId: project.id,
        evalTemplateId: template.id,
        target: EvalTargetObject.EVENT,
        scoreName: "unsaved-score",
        observationId,
        traceId,
        startTime,
        mapping: [
          {
            templateVariable: "input",
            selectedColumnId: "input",
            jsonSelector: null,
          },
          {
            templateVariable: "output",
            selectedColumnId: "output",
            jsonSelector: null,
          },
          {
            templateVariable: "metadata",
            selectedColumnId: "metadata",
            jsonSelector: "$.quality",
          },
        ],
      });

      expect(response).toEqual({
        success: true,
        result: {
          scores: [
            {
              name: "legacy-observation-score",
              value: 1,
              dataType: "BOOLEAN",
            },
          ],
        },
        executionTraceId: expect.stringMatching(/^[0-9a-f]{32}$/),
        executionTraceFromTimestamp: expect.any(Date),
      });
    } finally {
      mutableEnv.LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN =
        originalEventsTableFlagsFlag;
    }
  });

  it("returns user-code dispatcher failures as structured failures", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();
    const template = await createCodeTemplate(
      project.id,
      `function evaluate() {
        throw new Error("User code raised ValueError");
      }`,
    );

    await seedObservationEvents([
      createEvent({
        project_id: project.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
      }),
    ]);

    const response = await caller.evals.testRunCodeEval({
      projectId: project.id,
      evalTemplateId: template.id,
      target: EvalTargetObject.EVENT,
      scoreName: "unsaved-score",
      observationId,
      traceId,
      startTime,
      mapping: [],
    });

    expect(response).toEqual({
      success: false,
      error: {
        code: "USER_CODE_ERROR",
        message: "User code raised ValueError",
      },
      executionTraceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      executionTraceFromTimestamp: expect.any(Date),
    });
  });

  it("returns invalid evaluator results for test-run debugging", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();
    const template = await createCodeTemplate(
      project.id,
      `function evaluate() {
        return { score: 1 };
      }`,
    );

    await seedObservationEvents([
      createEvent({
        project_id: project.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
      }),
    ]);

    const response = await caller.evals.testRunCodeEval({
      projectId: project.id,
      evalTemplateId: template.id,
      target: EvalTargetObject.EVENT,
      scoreName: "unsaved-score",
      observationId,
      traceId,
      startTime,
      mapping: [],
    });

    expect(response).toEqual({
      success: false,
      error: {
        code: "INVALID_RESULT",
        message: expect.stringContaining(
          "The evaluator returned an invalid result.",
        ),
        returnedResult: { score: 1 },
      },
      executionTraceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      executionTraceFromTimestamp: expect.any(Date),
    });
  });

  // EXPERIMENT-target evals read the observation via getEventsStreamForEvalGreptime, which now LEFT
  // JOINs the deduped dataset_run_items projection to populate experiment_id /
  // experiment_item_expected_output / experiment_item_metadata (experiment_item_root_span_id ==
  // dataset_run_items.observation_id). The seed below writes the run-item projection accordingly.
  it("passes experiment context to test runs", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();
    const expectedOutput = "expected answer";
    const template = await createCodeTemplate(
      project.id,
      `
        function evaluate(ctx) {
          if (!ctx.experiment) {
            throw new Error("missing experiment context");
          }

          const matched =
            ctx.observation.output === ctx.experiment.itemExpectedOutput &&
            ctx.experiment.itemMetadata.difficulty === "easy";

          return { scores: [{ name: "experiment-test-score", value: matched, dataType: "BOOLEAN" }] };
        }
      `,
    );

    // EXPERIMENT-target evals read experiment_item_* via the eval stream's
    // dataset_run_items LEFT JOIN, so seed the run-item projection (not the bare
    // observation) for the experiment context to resolve.
    await createExperimentEventsAsGreptime([
      createEvent({
        project_id: project.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
        output: expectedOutput,
        experiment_id: randomUUID(),
        experiment_item_expected_output: expectedOutput,
        experiment_item_metadata_names: ["difficulty"],
        experiment_item_metadata_values: ["easy"],
      }),
    ]);

    const response = await caller.evals.testRunCodeEval({
      projectId: project.id,
      evalTemplateId: template.id,
      target: EvalTargetObject.EXPERIMENT,
      scoreName: "experiment-score",
      observationId,
      traceId,
      startTime,
      mapping: [
        {
          templateVariable: "output",
          selectedColumnId: "output",
          jsonSelector: null,
        },
        {
          templateVariable: "experimentItemExpectedOutput",
          selectedColumnId: "experimentItemExpectedOutput",
          jsonSelector: null,
        },
        {
          templateVariable: "experimentItemMetadata",
          selectedColumnId: "experimentItemMetadata",
          jsonSelector: null,
        },
      ],
    });

    expect(response).toEqual({
      success: true,
      result: {
        scores: [
          {
            name: "experiment-test-score",
            value: 1,
            dataType: "BOOLEAN",
          },
        ],
      },
      executionTraceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      executionTraceFromTimestamp: expect.any(Date),
    });
  });

  // TODO(P7): the execution trace is written via processEventBatch, which writes
  // raw_events synchronously but defers the traces-projection build to the worker
  // ingestion consumer. A web-only servertest has no worker, so getTracesByIds
  // (projection read) never resolves. Re-enable once the servertest harness runs
  // the ingestion consumer (or processEventBatch flushes the projection inline).
  it.skip("persists an internal trace for the test run", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();
    const template = await createCodeTemplate(project.id);

    await seedObservationEvents([
      createEvent({
        project_id: project.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
      }),
    ]);

    const response = await caller.evals.testRunCodeEval({
      projectId: project.id,
      evalTemplateId: template.id,
      target: EvalTargetObject.EVENT,
      scoreName: "unsaved-score",
      observationId,
      traceId,
      startTime,
      mapping: [],
    });

    if (!response.success) {
      throw new Error("Expected successful test run");
    }

    const executionTraceId = response.executionTraceId;

    const findTrace = async () => {
      const traces = await getTracesByIds([executionTraceId], project.id);
      return traces[0];
    };

    let trace = await findTrace();
    const deadline = Date.now() + 5_000;
    while (!trace && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      trace = await findTrace();
    }

    expect(trace).toBeDefined();
    expect(trace?.environment).toBe("langfuse-code-eval");
    expect(trace?.metadata?.code_eval_source_code).toBe(template.sourceCode);
  });

  it("does not return observations from other projects", async () => {
    const { project: callerProject, caller } = await prepare();
    const { project: otherProject } = await prepare();
    const template = await createCodeTemplate(callerProject.id);

    const otherProjectObservationId = randomUUID();
    const otherProjectTraceId = randomUUID();
    const otherProjectStartTime = new Date();
    await seedObservationEvents([
      createEvent({
        project_id: otherProject.id,
        trace_id: otherProjectTraceId,
        span_id: otherProjectObservationId,
        id: otherProjectObservationId,
        start_time: otherProjectStartTime.getTime() * 1000,
      }),
    ]);

    await expect(
      caller.evals.testRunCodeEval({
        projectId: callerProject.id,
        evalTemplateId: template.id,
        target: EvalTargetObject.EVENT,
        scoreName: "unsaved-score",
        observationId: otherProjectObservationId,
        traceId: otherProjectTraceId,
        startTime: otherProjectStartTime,
        mapping: [],
      }),
    ).rejects.toThrow(/Observation not found/);
  });

  it("does not allow running templates owned by other projects", async () => {
    const { project: callerProject, caller } = await prepare();
    const { project: otherProject } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();

    const otherProjectTemplate = await createCodeTemplate(otherProject.id);

    await seedObservationEvents([
      createEvent({
        project_id: callerProject.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
      }),
    ]);

    await expect(
      caller.evals.testRunCodeEval({
        projectId: callerProject.id,
        evalTemplateId: otherProjectTemplate.id,
        target: EvalTargetObject.EVENT,
        scoreName: "unsaved-score",
        observationId,
        traceId,
        startTime,
        mapping: [],
      }),
    ).rejects.toThrow(/Evaluator template not found/);
  });

  it("rejects Python templates for the insecure-local dispatcher", async () => {
    const { project, caller } = await prepare();
    const observationId = randomUUID();
    const traceId = randomUUID();
    const startTime = new Date();

    const template = await createCodeTemplate(
      project.id,
      'def evaluate(ctx):\n    return { "scores": [{ "name": "python-score", "value": 1 }] }',
      EvalTemplateSourceCodeLanguage.PYTHON,
    );

    await seedObservationEvents([
      createEvent({
        project_id: project.id,
        trace_id: traceId,
        span_id: observationId,
        id: observationId,
        start_time: startTime.getTime() * 1000,
      }),
    ]);

    await expect(
      caller.evals.testRunCodeEval({
        projectId: project.id,
        evalTemplateId: template.id,
        target: EvalTargetObject.EVENT,
        scoreName: "unsaved-score",
        observationId,
        traceId,
        startTime,
        mapping: [],
      }),
    ).rejects.toThrow(
      "This code evaluator language is not supported by the configured dispatcher.",
    );
  });
});

async function createCodeTemplate(
  projectId: string,
  sourceCode?: string,
  sourceCodeLanguage: EvalTemplateSourceCodeLanguage = EvalTemplateSourceCodeLanguage.TYPESCRIPT,
) {
  return prisma.evalTemplate.create({
    data: {
      projectId,
      name: `Saved code evaluator ${randomUUID()}`,
      version: 1,
      type: EvalTemplateType.CODE,
      prompt: null,
      outputDefinition: undefined,
      sourceCode:
        sourceCode ??
        'function evaluate() { return { scores: [{ name: "test-score", value: 1 }] }; }',
      sourceCodeLanguage,
    },
  });
}
