import { beforeEach, describe, expect, it, vi } from "vitest";

import { LLMAdapter } from "../../../packages/shared/src/server/llm/types";
import { VERTEXAI_USE_DEFAULT_CREDENTIALS } from "../../../packages/shared/src/interfaces/customLLMProviderConfigSchemas";

// Capture constructor arguments so we can assert routing + credential handling
// without reaching a real Vertex endpoint.
const invokeMock = vi.fn();
const chatAnthropicConstructorMock = vi.fn();
const chatGoogleConstructorMock = vi.fn();
const anthropicVertexConstructorMock = vi.fn();

function chatModelStub() {
  return {
    invoke: invokeMock,
    pipe: vi.fn().mockReturnValue({ invoke: invokeMock }),
    withStructuredOutput: vi.fn().mockReturnValue({ invoke: invokeMock }),
    // normalizeAnthropicSamplingParams reads/writes these on some models.
    topP: undefined as number | undefined,
    temperature: undefined as number | undefined,
  };
}

process.env.LANGFUSE_S3_EVENT_UPLOAD_BUCKET ??= "test-bucket";
process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const CLAUDE_VERTEX_MODEL = "claude-3-haiku@20240307";

describe("fetchLLMCompletion Vertex Claude routing", () => {
  let encrypt: typeof import("../../../packages/shared/src/encryption").encrypt;
  let fetchLLMCompletion: typeof import("../../../packages/shared/src/server/llm/fetchLLMCompletion").fetchLLMCompletion;

  beforeEach(async () => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ content: "4" });
    chatAnthropicConstructorMock.mockReset();
    // Plain function (not an arrow) so `new ChatAnthropic(...)` can construct it.
    chatAnthropicConstructorMock.mockImplementation(chatModelStub);
    chatGoogleConstructorMock.mockReset();
    chatGoogleConstructorMock.mockImplementation(chatModelStub);
    anthropicVertexConstructorMock.mockReset();
    vi.resetModules();

    vi.doMock(
      "../../../packages/shared/node_modules/@langchain/anthropic",
      () => ({ ChatAnthropic: chatAnthropicConstructorMock }),
    );
    vi.doMock(
      "../../../packages/shared/node_modules/@langchain/google",
      () => ({ ChatGoogle: chatGoogleConstructorMock }),
    );
    vi.doMock(
      "../../../packages/shared/node_modules/@anthropic-ai/vertex-sdk",
      () => ({ AnthropicVertex: anthropicVertexConstructorMock }),
    );
    vi.doMock(
      "../../../packages/shared/node_modules/google-auth-library",
      () => ({ GoogleAuth: vi.fn() }),
    );

    ({ encrypt } = await import("../../../packages/shared/src/encryption"));
    ({ fetchLLMCompletion } =
      await import("../../../packages/shared/src/server/llm/fetchLLMCompletion"));
  });

  const runVertex = (
    overrides: {
      model?: string;
      location?: string;
      providerOptions?: Record<string, unknown>;
    } = {},
  ) =>
    fetchLLMCompletion({
      streaming: false,
      messages: [
        { role: "user", content: "What is 2+2?", type: "public-api-created" },
      ],
      modelParams: {
        provider: "google-vertex-ai",
        adapter: LLMAdapter.VertexAI,
        model: overrides.model ?? CLAUDE_VERTEX_MODEL,
        temperature: 0,
        max_tokens: 10,
        ...(overrides.providerOptions
          ? { providerOptions: overrides.providerOptions }
          : {}),
      },
      llmConnection: {
        secretKey: encrypt(VERTEXAI_USE_DEFAULT_CREDENTIALS),
        config: { location: overrides.location ?? "us-east5" },
      },
    });

  it("routes Claude models through ChatAnthropic, not ChatGoogle", async () => {
    await runVertex();

    expect(chatAnthropicConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatGoogleConstructorMock).not.toHaveBeenCalled();
  });

  it("routes non-Claude Vertex models through ChatGoogle", async () => {
    await runVertex({ model: "gemini-2.5-flash" });

    expect(chatGoogleConstructorMock).toHaveBeenCalledTimes(1);
    expect(chatAnthropicConstructorMock).not.toHaveBeenCalled();
  });

  it("forces apiKey/authToken to null and pins region on the Vertex client", async () => {
    await runVertex({ location: "us-east5" });

    const { createClient } = chatAnthropicConstructorMock.mock.calls[0][0];
    // langchain calls createClient with its own base options; emulate that.
    createClient({ baseURL: "https://should-be-overridden.example" });

    expect(anthropicVertexConstructorMock).toHaveBeenCalledTimes(1);
    const vertexOptions = anthropicVertexConstructorMock.mock.calls[0][0];
    expect(vertexOptions.apiKey).toBeNull();
    expect(vertexOptions.authToken).toBeNull();
    expect(vertexOptions.region).toBe("us-east5");
    expect(vertexOptions.maxRetries).toBe(0);
  });

  it("defaults the Vertex region to global when no location is configured", async () => {
    await fetchLLMCompletion({
      streaming: false,
      messages: [
        { role: "user", content: "What is 2+2?", type: "public-api-created" },
      ],
      modelParams: {
        provider: "google-vertex-ai",
        adapter: LLMAdapter.VertexAI,
        model: CLAUDE_VERTEX_MODEL,
        temperature: 0,
        max_tokens: 10,
      },
      llmConnection: {
        secretKey: encrypt(VERTEXAI_USE_DEFAULT_CREDENTIALS),
      },
    });

    const { createClient } = chatAnthropicConstructorMock.mock.calls[0][0];
    createClient({});
    expect(anthropicVertexConstructorMock.mock.calls[0][0].region).toBe(
      "global",
    );
  });

  it("strips a user-supplied providerOptions.model from invocation kwargs", async () => {
    await runVertex({
      providerOptions: { model: "claude-evil-override", foo: "bar" },
    });

    const { invocationKwargs } = chatAnthropicConstructorMock.mock.calls[0][0];
    expect(invocationKwargs).not.toHaveProperty("model");
    expect(invocationKwargs).toMatchObject({ foo: "bar" });
  });

  it.each([
    ["empty string", ""],
    ["slash", "us/east5"],
    ["dot", "us.east5"],
    ["colon", "us:east5"],
  ])("rejects an invalid Vertex location (%s)", async (_label, location) => {
    await expect(runVertex({ location })).rejects.toThrow(
      "Invalid Vertex AI location",
    );
  });

  it.each([
    ["slash", "claude-3-haiku/evil"],
    ["path traversal", "claude-3-haiku..evil"],
    ["whitespace", "claude 3 haiku"],
  ])(
    "rejects an invalid Anthropic Vertex model name (%s)",
    async (_label, model) => {
      await expect(runVertex({ model })).rejects.toThrow(
        "Invalid Anthropic Vertex AI model name",
      );
    },
  );
});
