vi.mock("@/src/features/media/server/getMediaStorageClient", () => ({
  getMediaStorageServiceClient: () => ({
    getSignedUrl: vi.fn().mockResolvedValue("https://media.example/download"),
  }),
}));

// Skip the LLM model preflight so llm_as_judge evaluators don't require a
// provisioned default eval model.
vi.mock(
  "@/src/features/evals/server/evaluator-preflight",
  async (importActual) => ({
    ...(await importActual<object>()),
    getEvaluatorDefinitionPreflightError: vi.fn(async () => null),
  }),
);

import { nanoid } from "nanoid";
import { createHash, randomUUID } from "crypto";
import { z } from "zod";
import { prisma } from "@langfuse/shared/src/db";
import {
  createScoresGreptime,
  createTraceScore,
} from "@langfuse/shared/src/server";

import { ScoreConfigDataType } from "@langfuse/shared";
import {
  createMcpTestSetup,
  createPromptInDb,
  mcpEvalOutputDefinition,
  mockServerContext,
  verifyAuditLog,
  verifyToolAnnotations,
} from "./mcp-helpers";
import "@/src/features/mcp/server/bootstrap";
import { toolRegistry } from "@/src/features/mcp/server/registry";

// Import MCP tool handlers directly
import {
  getPromptTool,
  handleGetPrompt,
} from "@/src/features/mcp/features/prompts/tools/getPrompt";
import {
  getPromptUnresolvedTool,
  handleGetPromptUnresolved,
} from "@/src/features/mcp/features/prompts/tools/getPromptUnresolved";
import {
  listPromptsTool,
  handleListPrompts,
} from "@/src/features/mcp/features/prompts/tools/listPrompts";
import {
  createScoreConfigTool,
  handleCreateScoreConfig,
} from "@/src/features/mcp/features/scores/tools/createScoreConfig";
import {
  createScoreTool,
  handleCreateScore,
} from "@/src/features/mcp/features/scores/tools/createScore";
import {
  deleteScoreConfigTool,
  handleDeleteScoreConfig,
} from "@/src/features/mcp/features/scores/tools/deleteScoreConfig";
import {
  getScoreTool,
  handleGetScore,
} from "@/src/features/mcp/features/scores/tools/getScore";
import {
  getScoreConfigTool,
  handleGetScoreConfig,
} from "@/src/features/mcp/features/scores/tools/getScoreConfig";
import {
  listScoreConfigsTool,
  handleListScoreConfigs,
} from "@/src/features/mcp/features/scores/tools/listScoreConfigs";
import {
  listScoresTool,
  handleListScores,
} from "@/src/features/mcp/features/scores/tools/listScores";
import {
  updateScoreConfigTool,
  handleUpdateScoreConfig,
} from "@/src/features/mcp/features/scores/tools/updateScoreConfig";
import {
  getMediaTool,
  handleGetMedia,
} from "@/src/features/mcp/features/media/tools/getMedia";
import {
  getEvaluatorTool,
  handleGetEvaluator,
} from "@/src/features/mcp/features/evals/tools/getEvaluator";
import {
  listEvaluatorsTool,
  handleListEvaluators,
} from "@/src/features/mcp/features/evals/tools/listEvaluators";
import {
  getEvaluationRuleTool,
  handleGetEvaluationRule,
} from "@/src/features/mcp/features/evals/tools/getEvaluationRule";
import {
  listEvaluationRulesTool,
  handleListEvaluationRules,
} from "@/src/features/mcp/features/evals/tools/listEvaluationRules";
import { handleUpsertEvaluator } from "@/src/features/mcp/features/evals/tools/upsertEvaluator";
import { handleCreateEvaluationRule } from "@/src/features/mcp/features/evals/tools/createEvaluationRule";
import {
  GetDatasetItemsMcpInput,
  GetDatasetMcpInput,
  GetDatasetRunMcpInput,
  GetDatasetRunsMcpInput,
  GetDatasetsMcpInput,
} from "@/src/features/mcp/features/datasets/schema";

const createLlmEvaluatorForMcpReadTest = async (
  setup: Awaited<ReturnType<typeof createMcpTestSetup>>,
  name = `mcp-eval-${nanoid()}`,
) => {
  return (await handleUpsertEvaluator(
    {
      name,
      type: "llm_as_judge",
      prompt: "Judge {{input}} against {{output}}",
      outputDefinition: mcpEvalOutputDefinition,
      modelConfig: null,
    },
    setup.context,
  )) as { id: string; name: string };
};

const createEvaluationRuleForMcpReadTest = async (
  setup: Awaited<ReturnType<typeof createMcpTestSetup>>,
) => {
  const evaluatorName = `mcp-eval-${nanoid()}`;
  const evaluator = await createLlmEvaluatorForMcpReadTest(
    setup,
    evaluatorName,
  );
  const ruleName = `mcp-rule-${nanoid()}`;
  const rule = (await handleCreateEvaluationRule(
    {
      name: ruleName,
      evaluator: {
        name: evaluatorName,
        scope: "project",
        type: "llm_as_judge",
      },
      enabled: false,
      sampling: 1,
      target: "observation",
      filter: [
        { column: "version", operator: "=", value: "1.0.0", type: "string" },
      ],
      mapping: [
        { variable: "input", source: "input" },
        { variable: "output", source: "output" },
      ],
    },
    setup.context,
  )) as { id: string; name: string };

  return { evaluator, rule };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const containsStringValue = (value: unknown, expected: string): boolean => {
  if (typeof value === "string") {
    return value.includes(expected);
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsStringValue(item, expected));
  }

  if (isRecord(value)) {
    return Object.values(value).some((item) =>
      containsStringValue(item, expected),
    );
  }

  return false;
};

const containsPropertyName = (value: unknown, expected: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => containsPropertyName(item, expected));
  }

  if (isRecord(value)) {
    return (
      Object.keys(value).includes(expected) ||
      Object.values(value).some((item) => containsPropertyName(item, expected))
    );
  }

  return false;
};

describe("MCP Read Tools", () => {
  describe("dataset tool schemas", () => {
    it("uses dataset IDs for existing dataset read addressing", () => {
      for (const schema of [
        GetDatasetMcpInput,
        GetDatasetItemsMcpInput,
        GetDatasetRunsMcpInput,
        GetDatasetRunMcpInput,
      ]) {
        const jsonSchema = z.toJSONSchema(schema, { unrepresentable: "any" });
        const properties = jsonSchema.properties as Record<string, unknown>;

        expect(properties).toHaveProperty("datasetId");
        expect(properties).not.toHaveProperty("datasetName");
        expect(properties).not.toHaveProperty("name");
      }
    });

    it("keeps dataset names only as a listDatasets discovery filter", () => {
      const jsonSchema = z.toJSONSchema(GetDatasetsMcpInput, {
        unrepresentable: "any",
      });
      const properties = jsonSchema.properties as Record<string, unknown>;

      expect(properties).toHaveProperty("name");
      expect(properties).not.toHaveProperty("datasetId");
    });
  });

  describe("listEvaluators tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(listEvaluatorsTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(listEvaluatorsTool.name, context),
      ).resolves.toMatchObject({
        definition: expect.objectContaining({ name: listEvaluatorsTool.name }),
      });
    });

    it("should list evaluators for the current project", async () => {
      const setup = await createMcpTestSetup();
      const { context } = setup;
      const evaluator = await createLlmEvaluatorForMcpReadTest(setup);

      const result = (await handleListEvaluators(
        { page: 1, limit: 50 },
        context,
      )) as { data: Array<{ id: string }> };

      expect(result.data.map((item) => item.id)).toContain(evaluator.id);
    });
  });

  describe("getEvaluator tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getEvaluatorTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(getEvaluatorTool.name, context),
      ).resolves.toMatchObject({
        definition: expect.objectContaining({ name: getEvaluatorTool.name }),
      });
    });

    it("should fetch an evaluator by id", async () => {
      const setup = await createMcpTestSetup();
      const evaluator = await createLlmEvaluatorForMcpReadTest(setup);

      await expect(
        handleGetEvaluator({ evaluatorId: evaluator.id }, setup.context),
      ).resolves.toMatchObject({ id: evaluator.id, name: evaluator.name });
    });
  });

  describe("listEvaluationRules tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(listEvaluationRulesTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(listEvaluationRulesTool.name, context),
      ).resolves.toMatchObject({
        definition: expect.objectContaining({
          name: listEvaluationRulesTool.name,
        }),
      });
    });

    it("should list evaluation rules for the current project", async () => {
      const setup = await createMcpTestSetup();
      const { rule } = await createEvaluationRuleForMcpReadTest(setup);

      const result = (await handleListEvaluationRules(
        { page: 1, limit: 50 },
        setup.context,
      )) as { data: Array<{ id: string }> };

      expect(result.data.map((item) => item.id)).toContain(rule.id);
    });
  });

  describe("getEvaluationRule tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getEvaluationRuleTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(getEvaluationRuleTool.name, context),
      ).resolves.toMatchObject({
        definition: expect.objectContaining({
          name: getEvaluationRuleTool.name,
        }),
      });
    });

    it("should fetch an evaluation rule by id", async () => {
      const setup = await createMcpTestSetup();
      const { rule } = await createEvaluationRuleForMcpReadTest(setup);

      await expect(
        handleGetEvaluationRule({ evaluationRuleId: rule.id }, setup.context),
      ).resolves.toMatchObject({ id: rule.id, name: rule.name });
    });
  });

  describe("getMedia tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getMediaTool, { readOnlyHint: true });
    });

    it("should return media metadata and a signed download URL", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const mediaId = `mcp-media-${nanoid()}`;
      const uploadedAt = new Date("2026-01-01T00:00:00.000Z");

      await prisma.media.create({
        data: {
          id: mediaId,
          projectId,
          sha256Hash: createHash("sha256").update(mediaId).digest("base64"),
          bucketPath: `${projectId}/${mediaId}.png`,
          bucketName: "media-test-bucket",
          contentType: "image/png",
          contentLength: 123n,
          uploadedAt,
          uploadHttpStatus: 200,
        },
      });

      const result = (await handleGetMedia({ mediaId }, context)) as {
        mediaId: string;
        contentType: string;
        contentLength: number;
        uploadedAt: Date;
        url: string;
        urlExpiry: string;
      };

      expect(result).toMatchObject({
        mediaId,
        contentType: "image/png",
        contentLength: 123,
        url: "https://media.example/download",
      });
      expect(result.uploadedAt).toEqual(uploadedAt);
      expect(new Date(result.urlExpiry).getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("listScores tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(listScoresTool, { readOnlyHint: true });
    });

    it("should return paginated scores with object-shaped filters", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const matchingScore = createTraceScore({
        project_id: projectId,
        id: randomUUID(),
        name: `mcp-score-${nanoid()}`,
        data_type: "NUMERIC",
        value: 0.9,
      });
      const otherScore = createTraceScore({
        project_id: projectId,
        id: randomUUID(),
        name: `mcp-score-${nanoid()}`,
        data_type: "BOOLEAN",
        value: 1,
        string_value: "True",
      });

      await createScoresGreptime([matchingScore, otherScore]);

      const result = (await handleListScores(
        {
          limit: 10,
          page: 1,
          scoreIds: [matchingScore.id, otherScore.id],
          dataType: "NUMERIC",
          fields: ["score"],
        },
        context,
      )) as any;
      const data = result.data;

      expect(Object.keys(result).sort()).toEqual(["data", "meta"]);
      expect(result.meta).toMatchObject({
        page: 1,
        limit: 10,
        totalItems: 1,
      });
      expect(data).toHaveLength(1);
      expect(data).toEqual([
        expect.objectContaining({
          id: matchingScore.id,
          dataType: "NUMERIC",
        }),
      ]);
      expect(data).toEqual([
        expect.not.objectContaining({ trace: expect.anything() }),
      ]);
    });

    it("should enforce public v2 score field validation", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleListScores({ fields: ["trace"], limit: 10, page: 1 }, context),
      ).rejects.toThrow(/Scores needs to be selected always/i);

      await expect(
        handleListScores(
          { fields: ["score"], userId: "user-1", limit: 10, page: 1 },
          context,
        ),
      ).rejects.toThrow(/Cannot filter by trace properties/i);

      await expect(
        handleListScores(
          { fields: ["score"], traceTags: [], limit: 10, page: 1 },
          context,
        ),
      ).resolves.toMatchObject({ data: [] });
    });
  });

  describe("getScore tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getScoreTool, { readOnlyHint: true });
    });

    it("should fetch a score by id", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const score = createTraceScore({
        project_id: projectId,
        id: randomUUID(),
        name: `mcp-get-score-${nanoid()}`,
        data_type: "NUMERIC",
        value: 0.8,
      });

      await createScoresGreptime([score]);

      const result = await handleGetScore({ scoreId: score.id }, context);

      expect(result).toMatchObject({
        id: score.id,
        name: score.name,
        dataType: "NUMERIC",
        value: 0.8,
      });
    });

    it("should reject missing and cross-project scores", async () => {
      const { projectId } = await createMcpTestSetup();
      const { context: otherContext } = await createMcpTestSetup();
      const score = createTraceScore({
        project_id: projectId,
        id: randomUUID(),
      });

      await createScoresGreptime([score]);

      await expect(
        handleGetScore({ scoreId: randomUUID() }, otherContext),
      ).rejects.toThrow(/Score not found/i);
      await expect(
        handleGetScore({ scoreId: score.id }, otherContext),
      ).rejects.toThrow(/Score not found/i);
    });
  });

  describe("createScore tool", () => {
    it("should have destructiveHint annotation", () => {
      verifyToolAnnotations(createScoreTool, { destructiveHint: true });
    });

    it("should create a score using v1 route semantics", async () => {
      const { context, projectId, apiKeyId } = await createMcpTestSetup();
      const scoreId = randomUUID();

      const result = await handleCreateScore(
        {
          id: scoreId,
          traceId: randomUUID(),
          name: `mcp-create-score-${nanoid(8)}`,
          value: 1,
          dataType: "NUMERIC",
          environment: "default",
          source: "API",
        },
        context,
      );

      expect(result).toEqual({ id: scoreId });
      await expect(
        verifyAuditLog({
          projectId,
          apiKeyId,
          resourceType: "score",
          resourceId: scoreId,
          action: "create",
        }),
      ).resolves.toMatchObject({
        resourceType: "score",
        resourceId: scoreId,
        action: "create",
      });
    });
  });

  describe("listScoreConfigs tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(listScoreConfigsTool, { readOnlyHint: true });
    });

    it("should return paginated score configs for the current project", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const { context: otherContext, projectId: otherProjectId } =
        await createMcpTestSetup();
      const name = `mcp-config-${nanoid()}`;

      await prisma.scoreConfig.createMany({
        data: [
          {
            id: randomUUID(),
            projectId,
            name,
            dataType: ScoreConfigDataType.NUMERIC,
            minValue: 0,
            maxValue: 1,
          },
          {
            id: randomUUID(),
            projectId: otherProjectId,
            name,
            dataType: ScoreConfigDataType.NUMERIC,
            minValue: 0,
            maxValue: 1,
          },
        ],
      });

      const result = (await handleListScoreConfigs(
        { limit: 10, page: 1 },
        context,
      )) as any;
      const otherResult = (await handleListScoreConfigs(
        { limit: 10, page: 1 },
        otherContext,
      )) as any;

      expect(Object.keys(result).sort()).toEqual(["data", "meta"]);
      expect(result.data).toEqual(
        expect.arrayContaining([expect.objectContaining({ projectId, name })]),
      );
      expect(result.data).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ projectId: otherProjectId, name }),
        ]),
      );
      expect(otherResult.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ projectId: otherProjectId, name }),
        ]),
      );
    });

    it("should paginate score configs deterministically when createdAt timestamps tie", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const sharedCreatedAt = new Date("2100-05-12T00:00:00.000Z");
      const configIDs = [randomUUID(), randomUUID(), randomUUID()];

      await prisma.scoreConfig.createMany({
        data: configIDs.map((id, index) => ({
          id,
          projectId,
          name: `mcp-tie-score-config-${index}-${id.slice(0, 8)}`,
          dataType: ScoreConfigDataType.NUMERIC,
          minValue: index,
          maxValue: index + 1,
          createdAt: sharedCreatedAt,
          updatedAt: sharedCreatedAt,
        })),
      });

      const firstPage = (await handleListScoreConfigs(
        { limit: 2, page: 1 },
        context,
      )) as any;
      const secondPage = (await handleListScoreConfigs(
        { limit: 2, page: 2 },
        context,
      )) as any;

      const tiedIDs = [...firstPage.data, ...secondPage.data]
        .filter((config) => config.id && configIDs.includes(config.id))
        .map((config) => config.id);

      expect(tiedIDs).toEqual(configIDs.slice().sort());
      expect(new Set(tiedIDs).size).toBe(configIDs.length);
    });
  });

  describe("getScoreConfig tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getScoreConfigTool, { readOnlyHint: true });
    });

    it("should fetch a score config by id", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const config = await prisma.scoreConfig.create({
        data: {
          id: randomUUID(),
          projectId,
          name: `mcp-get-${nanoid(8)}`,
          dataType: ScoreConfigDataType.BOOLEAN,
          categories: [
            { label: "True", value: 1 },
            { label: "False", value: 0 },
          ],
        },
      });

      const result = await handleGetScoreConfig(
        { configId: config.id },
        context,
      );

      expect(result).toMatchObject({
        id: config.id,
        name: config.name,
        dataType: ScoreConfigDataType.BOOLEAN,
      });
    });

    it("should reject missing and cross-project score configs", async () => {
      const { projectId } = await createMcpTestSetup();
      const { context: otherContext } = await createMcpTestSetup();
      const config = await prisma.scoreConfig.create({
        data: {
          id: randomUUID(),
          projectId,
          name: `mcp-cross-${nanoid(8)}`,
          dataType: ScoreConfigDataType.TEXT,
        },
      });

      await expect(
        handleGetScoreConfig({ configId: randomUUID() }, otherContext),
      ).rejects.toThrow(/Score config not found/i);
      await expect(
        handleGetScoreConfig({ configId: config.id }, otherContext),
      ).rejects.toThrow(/Score config not found/i);
    });
  });

  describe("createScoreConfig tool", () => {
    it("should have destructiveHint annotation", () => {
      verifyToolAnnotations(createScoreConfigTool, { destructiveHint: true });
    });

    it("should describe allowed score config name characters in the input schema", () => {
      expect(
        containsStringValue(
          createScoreConfigTool.inputSchema,
          "Allowed characters: letters, numbers, spaces, underscores, periods, parentheses, and hyphens.",
        ),
      ).toBe(true);
    });

    it.each([
      [
        "numeric",
        {
          name: `mcp-num-${nanoid(8)}`,
          dataType: "NUMERIC" as const,
          numericMinValue: 0,
          numericMaxValue: 1,
        },
      ],
      [
        "categorical",
        {
          name: `mcp-cat-${nanoid(8)}`,
          dataType: "CATEGORICAL" as const,
          categoricalCategories: [
            { label: "High", value: 1 },
            { label: "Low", value: 0 },
          ],
        },
      ],
      [
        "text",
        {
          name: `mcp-text-${nanoid(8)}`,
          dataType: "TEXT" as const,
        },
      ],
    ])("should create %s score configs", async (_type, input) => {
      const { context, projectId, apiKeyId } = await createMcpTestSetup();

      const result = (await handleCreateScoreConfig(input, context)) as any;

      expect(result).toMatchObject({
        projectId,
        name: input.name,
        dataType: input.dataType,
      });

      await expect(
        verifyAuditLog({
          projectId,
          resourceType: "scoreConfig",
          resourceId: result.id,
          action: "create",
          apiKeyId,
        }),
      ).resolves.toMatchObject({ action: "create" });
    });

    it("should create boolean configs with inferred categories", async () => {
      const { context } = await createMcpTestSetup();

      const result = await handleCreateScoreConfig(
        {
          name: `mcp-bool-${nanoid(8)}`,
          dataType: "BOOLEAN",
        },
        context,
      );

      expect(result).toMatchObject({
        dataType: ScoreConfigDataType.BOOLEAN,
        categories: [
          { label: "True", value: 1 },
          { label: "False", value: 0 },
        ],
      });
    });

    it("should reject invalid categories", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleCreateScoreConfig(
          {
            name: `mcp-invalid-${nanoid(8)}`,
            dataType: "CATEGORICAL",
            categoricalCategories: [
              { label: "Duplicate", value: 1 },
              { label: "Duplicate", value: 2 },
            ],
          },
          context,
        ),
      ).rejects.toThrow(/Category labels must be unique/i);
    });

    it("should validate normalized numeric range fields even when another field is invalid", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleCreateScoreConfig(
          {
            name: "invalid/name",
            dataType: "NUMERIC",
            numericMinValue: "not-a-number",
          } as any,
          context,
        ),
      ).rejects.toThrow(/minValue/i);
    });
  });

  describe("updateScoreConfig tool", () => {
    it("should have destructiveHint annotation", () => {
      verifyToolAnnotations(updateScoreConfigTool, { destructiveHint: true });
    });

    it("should describe allowed score config name characters in the input schema", () => {
      expect(
        containsStringValue(
          updateScoreConfigTool.inputSchema,
          "Allowed characters: letters, numbers, spaces, underscores, periods, parentheses, and hyphens.",
        ),
      ).toBe(true);
    });

    it("should not expose archive state in the input schema", () => {
      expect(
        containsPropertyName(updateScoreConfigTool.inputSchema, "isArchived"),
      ).toBe(false);
    });

    it("should update allowed fields and write an audit log", async () => {
      const { context, projectId, apiKeyId } = await createMcpTestSetup();
      const config = await prisma.scoreConfig.create({
        data: {
          id: randomUUID(),
          projectId,
          name: `mcp-update-${nanoid(8)}`,
          dataType: ScoreConfigDataType.NUMERIC,
          minValue: 0,
          maxValue: 1,
        },
      });

      const result = await handleUpdateScoreConfig(
        {
          configId: config.id,
          name: "mcp-updated",
          description: "Updated through MCP",
          numericMinValue: -1,
        },
        context,
      );

      expect(result).toMatchObject({
        id: config.id,
        name: "mcp-updated",
        description: "Updated through MCP",
        minValue: -1,
      });

      await expect(
        verifyAuditLog({
          projectId,
          resourceType: "scoreConfig",
          resourceId: config.id,
          action: "update",
          apiKeyId,
        }),
      ).resolves.toMatchObject({ action: "update" });
    });

    it("should reject empty update bodies", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleUpdateScoreConfig({ configId: randomUUID() }, context),
      ).rejects.toThrow(/Request body cannot be empty/i);
    });

    it("should validate normalized update fields even when another field is invalid", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleUpdateScoreConfig(
          {
            configId: randomUUID(),
            name: "invalid/name",
            numericMinValue: "not-a-number",
          } as any,
          context,
        ),
      ).rejects.toThrow(/minValue/i);
    });

    it("should not archive score configs through update", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const config = await prisma.scoreConfig.create({
        data: {
          id: randomUUID(),
          projectId,
          name: `mcp-update-no-archive-${nanoid(8)}`,
          dataType: ScoreConfigDataType.NUMERIC,
          minValue: 0,
          maxValue: 1,
        },
      });

      const result = await handleUpdateScoreConfig(
        {
          configId: config.id,
          name: "mcp-still-active",
          isArchived: true,
        } as unknown as Parameters<typeof handleUpdateScoreConfig>[0],
        context,
      );

      expect(result).toMatchObject({
        id: config.id,
        name: "mcp-still-active",
        isArchived: false,
      });
    });
  });

  describe("deleteScoreConfig tool", () => {
    it("should have destructiveHint annotation", () => {
      verifyToolAnnotations(deleteScoreConfigTool, { destructiveHint: true });
    });

    it("should archive the score config", async () => {
      const { context, projectId, apiKeyId } = await createMcpTestSetup();
      const config = await prisma.scoreConfig.create({
        data: {
          id: randomUUID(),
          projectId,
          name: `mcp-delete-config-${nanoid(8)}`,
          dataType: ScoreConfigDataType.NUMERIC,
          minValue: 0,
          maxValue: 1,
        },
      });

      const result = await handleDeleteScoreConfig(
        { configId: config.id },
        context,
      );

      expect(result).toMatchObject({
        id: config.id,
        isArchived: true,
      });

      await expect(
        verifyAuditLog({
          projectId,
          resourceType: "scoreConfig",
          resourceId: config.id,
          action: "update",
          apiKeyId,
        }),
      ).resolves.toMatchObject({ action: "update" });
    });
  });

  describe("getPrompt tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getPromptTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(getPromptTool.name, context),
      ).resolves.toBeDefined();
    });

    it("should fetch prompt by name only (defaults to latest label)", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Production prompt",
        projectId,
        labels: ["production"],
        version: 1,
      });

      await createPromptInDb({
        name: promptName,
        prompt: "Latest prompt",
        projectId,
        labels: ["latest"],
        version: 2,
      });

      const result = (await handleGetPrompt({ name: promptName }, context)) as {
        name: string;
        version: number;
        prompt: string;
        labels: string[];
      };

      expect(result.name).toBe(promptName);
      expect(result.version).toBe(2);
      expect(result.prompt).toBe("Latest prompt");
      expect(result.labels).toContain("latest");
    });

    it("should fetch production prompt when production label is explicit", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Production prompt",
        projectId,
        labels: ["production"],
        version: 1,
      });

      await createPromptInDb({
        name: promptName,
        prompt: "Latest prompt",
        projectId,
        labels: ["latest"],
        version: 2,
      });

      const result = (await handleGetPrompt(
        { name: promptName, label: "production" },
        context,
      )) as {
        version: number;
        prompt: string;
        labels: string[];
      };

      expect(result.version).toBe(1);
      expect(result.prompt).toBe("Production prompt");
      expect(result.labels).toContain("production");
    });

    it("should fetch prompt by name and specific label", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      // Create v1 with staging label
      await createPromptInDb({
        name: promptName,
        prompt: "Version 1",
        projectId,
        labels: ["staging"],
        version: 1,
      });

      // Create v2 with production label
      await createPromptInDb({
        name: promptName,
        prompt: "Version 2",
        projectId,
        labels: ["production"],
        version: 2,
      });

      const result = (await handleGetPrompt(
        { name: promptName, label: "staging" },
        context,
      )) as { version: number; prompt: string };

      expect(result.version).toBe(1);
      expect(result.prompt).toBe("Version 1");
    });

    it("should fetch prompt by name and specific version", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Version 1",
        projectId,
        version: 1,
      });

      await createPromptInDb({
        name: promptName,
        prompt: "Version 2",
        projectId,
        version: 2,
      });

      const result = (await handleGetPrompt(
        { name: promptName, version: 2 },
        context,
      )) as { version: number; prompt: string };

      expect(result.version).toBe(2);
      expect(result.prompt).toBe("Version 2");
    });

    it("should throw error when both label and version are specified", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Test",
        projectId,
      });

      // The input schema refinement should reject this
      await expect(
        handleGetPrompt(
          { name: promptName, label: "production", version: 1 },
          context,
        ),
      ).rejects.toThrow();
    });

    it("should return error for non-existent prompt", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleGetPrompt({ name: "non-existent-prompt" }, context),
      ).rejects.toThrow(/not found/i);
    });

    it("should return error for non-existent label", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Test",
        projectId,
        labels: ["staging"],
      });

      await expect(
        handleGetPrompt({ name: promptName, label: "production" }, context),
      ).rejects.toThrow(/not found/i);
    });

    it("should return error for non-existent version", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Test",
        projectId,
        version: 1,
      });

      await expect(
        handleGetPrompt({ name: promptName, version: 999 }, context),
      ).rejects.toThrow(/not found/i);
    });

    it("should use context.projectId for tenant isolation", async () => {
      const { context: context1, projectId: projectId1 } =
        await createMcpTestSetup();
      const { context: context2, projectId: projectId2 } =
        await createMcpTestSetup();

      const promptName = `shared-name-${nanoid()}`;

      // Create same-named prompt in both projects
      await createPromptInDb({
        name: promptName,
        prompt: "Project 1 content",
        projectId: projectId1,
        labels: ["production", "latest"],
      });

      await createPromptInDb({
        name: promptName,
        prompt: "Project 2 content",
        projectId: projectId2,
        labels: ["production", "latest"],
      });

      // Each context should only see its own project's prompt
      const result1 = (await handleGetPrompt(
        { name: promptName },
        context1,
      )) as { prompt: string };
      expect(result1.prompt).toBe("Project 1 content");

      const result2 = (await handleGetPrompt(
        { name: promptName },
        context2,
      )) as { prompt: string };
      expect(result2.prompt).toBe("Project 2 content");
    });

    it("should handle special characters in prompt name", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-special!@#$%${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Special chars test",
        projectId,
        labels: ["production", "latest"],
      });

      const result = (await handleGetPrompt({ name: promptName }, context)) as {
        name: string;
      };
      expect(result.name).toBe(promptName);
    });

    it("should include prompt config in response", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Test",
        projectId,
        labels: ["production", "latest"],
        config: { model: "gpt-4", temperature: 0.7 },
      });

      const result = (await handleGetPrompt({ name: promptName }, context)) as {
        config: Record<string, unknown>;
      };

      expect(result.config).toEqual({ model: "gpt-4", temperature: 0.7 });
    });

    it("should include tags in response", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Test",
        projectId,
        labels: ["production", "latest"],
        tags: ["experimental", "v2"],
      });

      const result = (await handleGetPrompt({ name: promptName }, context)) as {
        tags: string[];
      };

      expect(result.tags).toEqual(["experimental", "v2"]);
    });
  });

  describe("listPrompts tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(listPromptsTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(listPromptsTool.name, context),
      ).resolves.toBeDefined();
    });

    it("should list all prompts for project", async () => {
      const { context, projectId } = await createMcpTestSetup();

      // Create multiple prompts
      const prompt1Name = `list-test-1-${nanoid()}`;
      const prompt2Name = `list-test-2-${nanoid()}`;

      await createPromptInDb({
        name: prompt1Name,
        prompt: "First prompt",
        projectId,
      });

      await createPromptInDb({
        name: prompt2Name,
        prompt: "Second prompt",
        projectId,
      });

      const result = (await handleListPrompts(
        { page: 1, limit: 100 },
        context,
      )) as {
        data: Array<{ name: string }>;
        meta: { totalItems: number };
      };

      // Should include our prompts (may include others from setup)
      const names = result.data.map((p) => p.name);
      expect(names).toContain(prompt1Name);
      expect(names).toContain(prompt2Name);
      expect(result.meta.totalItems).toBeGreaterThanOrEqual(2);
      expect(Object.keys(result).sort()).toEqual(["data", "meta"]);
    });

    it("should filter by name", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const uniquePrefix = `filter-name-${nanoid()}`;

      await createPromptInDb({
        name: `${uniquePrefix}-match`,
        prompt: "Match",
        projectId,
      });

      await createPromptInDb({
        name: `other-${nanoid()}`,
        prompt: "No match",
        projectId,
      });

      const result = (await handleListPrompts(
        { name: `${uniquePrefix}-match`, page: 1, limit: 100 },
        context,
      )) as {
        data: Array<{ name: string }>;
      };

      expect(result.data.length).toBe(1);
      expect(result.data[0].name).toBe(`${uniquePrefix}-match`);
    });

    it("should filter by label", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `filter-label-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Production version",
        projectId,
        labels: ["production"],
        version: 1,
      });

      await createPromptInDb({
        name: `other-${nanoid()}`,
        prompt: "Staging version",
        projectId,
        labels: ["staging"],
        version: 1,
      });

      const result = (await handleListPrompts(
        { label: "production", page: 1, limit: 100 },
        context,
      )) as {
        data: Array<{ name: string; labels: string[] }>;
      };

      // All returned prompts should have production label
      for (const prompt of result.data) {
        expect(prompt.labels).toContain("production");
      }
    });

    it("should filter by tag", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `filter-tag-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Tagged prompt",
        projectId,
        tags: ["experimental"],
      });

      await createPromptInDb({
        name: `untagged-${nanoid()}`,
        prompt: "Untagged prompt",
        projectId,
        tags: [],
      });

      const result = (await handleListPrompts(
        { tag: "experimental", page: 1, limit: 100 },
        context,
      )) as {
        data: Array<{ name: string; tags: string[] }>;
      };

      // Should only return prompts with experimental tag
      expect(result.data.length).toBeGreaterThan(0);
      for (const prompt of result.data) {
        expect(prompt.tags).toContain("experimental");
      }
    });

    it("should filter by fromUpdatedAt", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const oldPrompt = `filter-from-updated-${nanoid()}`;
      const newPrompt = `filter-from-updated-${nanoid()}`;

      const oldDate = new Date("2026-01-01T00:00:00.000Z");
      const newDate = new Date("2026-02-01T00:00:00.000Z");

      await prisma.prompt.create({
        data: {
          name: oldPrompt,
          prompt: "old",
          labels: [],
          tags: [],
          type: "text",
          version: 1,
          config: {},
          createdBy: "test-user",
          createdAt: oldDate,
          updatedAt: oldDate,
          project: { connect: { id: projectId } },
        },
      });

      await prisma.prompt.create({
        data: {
          name: newPrompt,
          prompt: "new",
          labels: [],
          tags: [],
          type: "text",
          version: 1,
          config: {},
          createdBy: "test-user",
          createdAt: newDate,
          updatedAt: newDate,
          project: { connect: { id: projectId } },
        },
      });

      const result = (await handleListPrompts(
        {
          fromUpdatedAt: "2026-01-15T00:00:00.000Z",
          page: 1,
          limit: 100,
        },
        context,
      )) as { data: Array<{ name: string }> };

      const names = result.data.map((p) => p.name);
      expect(names).toContain(newPrompt);
      expect(names).not.toContain(oldPrompt);
    });

    it("should filter by toUpdatedAt", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const oldPrompt = `filter-to-updated-${nanoid()}`;
      const newPrompt = `filter-to-updated-${nanoid()}`;

      const oldDate = new Date("2026-01-01T00:00:00.000Z");
      const newDate = new Date("2026-02-01T00:00:00.000Z");

      await prisma.prompt.create({
        data: {
          name: oldPrompt,
          prompt: "old",
          labels: [],
          tags: [],
          type: "text",
          version: 1,
          config: {},
          createdBy: "test-user",
          createdAt: oldDate,
          updatedAt: oldDate,
          project: { connect: { id: projectId } },
        },
      });

      await prisma.prompt.create({
        data: {
          name: newPrompt,
          prompt: "new",
          labels: [],
          tags: [],
          type: "text",
          version: 1,
          config: {},
          createdBy: "test-user",
          createdAt: newDate,
          updatedAt: newDate,
          project: { connect: { id: projectId } },
        },
      });

      const result = (await handleListPrompts(
        {
          toUpdatedAt: "2026-01-15T00:00:00.000Z",
          page: 1,
          limit: 100,
        },
        context,
      )) as { data: Array<{ name: string }> };

      const names = result.data.map((p) => p.name);
      expect(names).toContain(oldPrompt);
      expect(names).not.toContain(newPrompt);
    });

    it("should return error when fromUpdatedAt is after toUpdatedAt", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleListPrompts(
          {
            fromUpdatedAt: "2026-02-02T00:00:00.000Z",
            toUpdatedAt: "2026-02-01T00:00:00.000Z",
            page: 1,
            limit: 50,
          },
          context,
        ),
      ).rejects.toThrow(/fromUpdatedAt.*<=.*toUpdatedAt/i);
    });

    it("should handle pagination with page and limit", async () => {
      const { context, projectId } = await createMcpTestSetup();

      // Create enough prompts to test pagination
      for (let i = 0; i < 5; i++) {
        await createPromptInDb({
          name: `pagination-test-${i}-${nanoid()}`,
          prompt: `Prompt ${i}`,
          projectId,
        });
      }

      const result = (await handleListPrompts(
        { page: 1, limit: 2 },
        context,
      )) as {
        data: Array<{ name: string }>;
        meta: { page: number; limit: number; totalPages: number };
      };

      expect(result.data.length).toBeLessThanOrEqual(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBe(2);
      expect(result.meta.totalPages).toBeGreaterThanOrEqual(1);
    });

    it("should return empty results for no matches", async () => {
      const { context } = await createMcpTestSetup();

      const result = (await handleListPrompts(
        { name: `non-existent-${nanoid()}`, page: 1, limit: 100 },
        context,
      )) as {
        data: Array<unknown>;
        meta: { totalItems: number };
      };

      expect(result.data).toEqual([]);
      expect(result.meta.totalItems).toBe(0);
    });

    it("should use context.projectId for tenant isolation", async () => {
      const { context: context1, projectId: projectId1 } =
        await createMcpTestSetup();
      const { context: context2 } = await createMcpTestSetup();

      const uniqueName = `isolation-test-${nanoid()}`;

      // Create prompt only in project 1
      await createPromptInDb({
        name: uniqueName,
        prompt: "Project 1 only",
        projectId: projectId1,
      });

      // Project 1 should see it
      const result1 = (await handleListPrompts(
        { name: uniqueName, page: 1, limit: 100 },
        context1,
      )) as { data: Array<unknown> };
      expect(result1.data.length).toBe(1);

      // Project 2 should not see it
      const result2 = (await handleListPrompts(
        { name: uniqueName, page: 1, limit: 100 },
        context2,
      )) as { data: Array<unknown> };
      expect(result2.data.length).toBe(0);
    });

    it("should respect default pagination values", async () => {
      const { context } = await createMcpTestSetup();

      const result = (await handleListPrompts(
        { page: 1, limit: 100 },
        context,
      )) as {
        meta: { page: number; limit: number };
      };

      // Default values from validation schema
      expect(result.meta.page).toBe(1);
      expect(result.meta.limit).toBeLessThanOrEqual(100); // Max limit
    });

    it("should include prompt metadata in list results", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `metadata-test-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "Test",
        projectId,
        labels: ["production"],
        tags: ["important"],
        version: 1,
      });

      const result = (await handleListPrompts(
        { name: promptName, page: 1, limit: 100 },
        context,
      )) as {
        data: Array<{
          name: string;
          version: number;
          labels: string[];
          tags: string[];
        }>;
      };

      expect(result.data[0].name).toBe(promptName);
      expect(result.data[0].labels).toContain("production");
      expect(result.data[0].tags).toContain("important");
    });
  });

  describe("getPromptUnresolved tool", () => {
    it("should have readOnlyHint annotation", () => {
      verifyToolAnnotations(getPromptUnresolvedTool, { readOnlyHint: true });
    });

    it("should be available to in-app agent keys", async () => {
      const context = mockServerContext({ isInAppAgentKey: true });

      await expect(
        toolRegistry.getEnabledTool(getPromptUnresolvedTool.name, context),
      ).resolves.toBeDefined();
    });

    it("should fetch latest prompt without resolving dependencies by default", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-unresolved-${nanoid()}`;

      const rawPromptContent =
        "You are a helpful assistant. @@@langfusePrompt:name=base-instructions|label=production@@@";

      await createPromptInDb({
        name: promptName,
        prompt: "Production prompt",
        projectId,
        labels: ["production"],
        version: 1,
      });

      await createPromptInDb({
        name: promptName,
        prompt: rawPromptContent,
        projectId,
        labels: ["latest"],
        version: 2,
      });

      const result = (await handleGetPromptUnresolved(
        { name: promptName },
        context,
      )) as {
        name: string;
        version: number;
        prompt: string;
        labels: string[];
      };

      expect(result.name).toBe(promptName);
      expect(result.version).toBe(2);
      expect(result.labels).toContain("latest");
      // Verify dependency tags are NOT resolved
      expect(result.prompt).toBe(rawPromptContent);
      expect(result.prompt).toContain(
        "@@@langfusePrompt:name=base-instructions|label=production@@@",
      );
    });

    it("should fetch prompt by name and specific label without resolution", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-unresolved-${nanoid()}`;

      // Create v1 with staging label
      await createPromptInDb({
        name: promptName,
        prompt: "Version 1 @@@langfusePrompt:name=helper|label=staging@@@",
        projectId,
        labels: ["staging"],
        version: 1,
      });

      // Create v2 with production label
      await createPromptInDb({
        name: promptName,
        prompt: "Version 2 @@@langfusePrompt:name=helper|label=production@@@",
        projectId,
        labels: ["production"],
        version: 2,
      });

      const result = (await handleGetPromptUnresolved(
        { name: promptName, label: "staging" },
        context,
      )) as { version: number; prompt: string };

      expect(result.version).toBe(1);
      expect(result.prompt).toBe(
        "Version 1 @@@langfusePrompt:name=helper|label=staging@@@",
      );
    });

    it("should fetch prompt by name and specific version without resolution", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-prompt-unresolved-${nanoid()}`;

      await createPromptInDb({
        name: promptName,
        prompt: "V1 content @@@langfusePrompt:name=dep|label=v1@@@",
        projectId,
        labels: ["staging"],
        version: 1,
      });

      await createPromptInDb({
        name: promptName,
        prompt: "V2 content @@@langfusePrompt:name=dep|label=v2@@@",
        projectId,
        labels: ["production"],
        version: 2,
      });

      const result = (await handleGetPromptUnresolved(
        { name: promptName, version: 1 },
        context,
      )) as { version: number; prompt: string };

      expect(result.version).toBe(1);
      expect(result.prompt).toBe(
        "V1 content @@@langfusePrompt:name=dep|label=v1@@@",
      );
    });

    it("should throw error if prompt not found", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleGetPromptUnresolved(
          { name: "non-existent-prompt-12345" },
          context,
        ),
      ).rejects.toThrow("Prompt 'non-existent-prompt-12345' not found");
    });

    it("should throw error when both label and version are specified", async () => {
      const { context } = await createMcpTestSetup();

      await expect(
        handleGetPromptUnresolved(
          { name: "test", label: "production", version: 1 },
          context,
        ),
      ).rejects.toThrow(
        "Cannot specify both label and version - they are mutually exclusive",
      );
    });

    it("should return raw chat prompt without resolving dependencies", async () => {
      const { context, projectId } = await createMcpTestSetup();
      const promptName = `test-chat-unresolved-${nanoid()}`;

      const chatMessages = [
        {
          role: "system",
          content:
            "You are helpful @@@langfusePrompt:name=system-base|label=production@@@",
        },
        {
          role: "user",
          content: "@@@langfusePrompt:name=user-template|label=production@@@",
        },
      ];

      await createPromptInDb({
        name: promptName,
        prompt: chatMessages,
        projectId,
        labels: ["production", "latest"],
        version: 1,
        type: "chat",
      });

      const result = (await handleGetPromptUnresolved(
        { name: promptName },
        context,
      )) as {
        name: string;
        type: string;
        prompt: Array<{ role: string; content: string }>;
      };

      expect(result.type).toBe("chat");
      expect(result.prompt).toEqual(chatMessages);
      expect(result.prompt[0].content).toContain(
        "@@@langfusePrompt:name=system-base|label=production@@@",
      );
    });
  });
});
