import { createGoogle } from "@ai-sdk/google";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderDefinitionsSchema } from "../provider-config";
import { createAiSdkNlpProvider, createConfiguredAiProvider } from "../providers/ai-sdk";
import type { ParseContext } from "../types";

const CTX: ParseContext = {
  mapCenter: [2.35, 48.86],
  mapBbox: { south: 48.85, west: 2.33, north: 48.87, east: 2.37 },
};

const WIRE_INTENT = {
  filter: {
    selectors: [{ tags: [{ key: "tourism", op: "=" as const, value: "museum" }] }],
    require: [
      { key: "wheelchair", op: "=" as const, value: "yes" },
      { key: "fee", op: "=" as const, value: "no" },
    ],
    exclude: [],
    elementTypes: [],
  },
  spatial_constraint: {
    type: "near_place" as const,
    place_name: "train station",
    lat: null,
    lng: null,
    south: null,
    west: null,
    north: null,
    east: null,
  },
  time_constraint: null,
  sort_by: "distance" as const,
  unmapped_attributes: [],
  confidence: 0.9,
  explanation: "Museums near the train station",
};

function generation(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 20, text: 20, reasoning: undefined },
    },
    warnings: [],
  };
}

function makeCtx(config: Record<string, unknown>): IntegrationContext {
  return {
    config,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as IntegrationContext;
}

afterEach(() => vi.unstubAllGlobals());

describe("createAiSdkNlpProvider", () => {
  it("uses one typed structured-output path and normalizes the wire result", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generation(JSON.stringify(WIRE_INTENT)) });
    const provider = createAiSdkNlpProvider({
      id: "test",
      label: "Test model",
      model,
      timeoutMs: 3_000,
      requiresNetwork: true,
      cloudProcessors: [],
      cacheKey: "test:model",
    });

    const intent = await provider.parseQuery("museums near the station", CTX);

    expect(intent.filter.require).toEqual([
      { key: "wheelchair", op: "=", value: "yes" },
      { key: "fee", op: "=", value: "no" },
    ]);
    expect(intent.filter.exclude).toBeUndefined();
    expect(intent.spatial_constraint).toEqual({
      type: "near_place",
      place_name: "train station",
    });
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0].responseFormat?.type).toBe("json");
    expect(model.doGenerateCalls[0].responseFormat).toHaveProperty("schema");
  });

  it("rejects output that violates the portable schema", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generation(JSON.stringify({ ...WIRE_INTENT, confidence: 2 })),
    });
    const provider = createAiSdkNlpProvider({
      id: "test",
      label: "Test model",
      model,
      timeoutMs: 3_000,
      requiresNetwork: false,
      cloudProcessors: [],
      cacheKey: "test:model",
    });

    await expect(provider.parseQuery("museums", CTX)).rejects.toThrow("did not match schema");
  });

  it("marks Anthropic's stable system prompt for provider-side caching", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generation(JSON.stringify(WIRE_INTENT)) });
    const provider = createAiSdkNlpProvider({
      id: "claude",
      label: "Claude",
      model,
      timeoutMs: 3_000,
      requiresNetwork: true,
      cloudProcessors: [],
      cacheKey: "claude:model",
      cacheSystemPrompt: true,
    });

    await provider.parseQuery("museums", CTX);

    expect(model.doGenerateCalls[0].prompt[0]).toMatchObject({
      role: "system",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });

  it("converts the portable schema into Gemini's union-free OpenAPI subset", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: { role: "model", parts: [{ text: JSON.stringify(WIRE_INTENT) }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 10,
            candidatesTokenCount: 20,
            totalTokenCount: 30,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const model = createGoogle({ apiKey: "secret", fetch: fetchMock })("gemini-2.5-flash");
    const provider = createAiSdkNlpProvider({
      id: "gemini",
      label: "Gemini",
      model,
      timeoutMs: 3_000,
      requiresNetwork: true,
      cloudProcessors: [],
      cacheKey: "gemini:model",
      providerOptions: { google: { structuredOutputs: true } },
    });

    await expect(provider.parseQuery("museums", CTX)).resolves.toMatchObject({
      confidence: 0.9,
    });
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    const responseSchema = body.generationConfig.responseSchema;
    expect(responseSchema).toBeDefined();
    expect(JSON.stringify(responseSchema)).not.toContain('"oneOf"');
    expect(JSON.stringify(responseSchema)).not.toContain('"anyOf"');
    expect(responseSchema.properties.spatial_constraint.nullable).toBe(true);
  });
});

describe("createConfiguredAiProvider", () => {
  it("builds Gemini as a cloud provider with Google disclosure metadata", () => {
    const [definition] = ProviderDefinitionsSchema.parse([
      { id: "gemini-fast", type: "google", model: "gemini-2.5-flash" },
    ]);
    const provider = createConfiguredAiProvider(makeCtx({ googleApiKey: "secret" }), definition, {
      roundDecimals: 2,
    });

    expect(provider?.id).toBe("gemini-fast");
    expect(provider?.requiresNetwork).toBe(true);
    expect(provider?.cloudProcessors.map((processor) => processor.id)).toEqual(["google"]);
  });

  it("skips a cloud provider whose vault credential is missing", () => {
    const ctx = makeCtx({});
    const [definition] = ProviderDefinitionsSchema.parse([
      { id: "claude", type: "anthropic", model: "claude-haiku-4-5" },
    ]);

    expect(createConfiguredAiProvider(ctx, definition, { roundDecimals: 2 })).toBeNull();
    expect(ctx.log.warn).toHaveBeenCalled();
  });

  it("builds Ollama through the OpenAI-compatible AI SDK transport", () => {
    const [definition] = ProviderDefinitionsSchema.parse([
      { id: "local", type: "ollama", model: "gemma3:4b-it-qat" },
    ]);
    const provider = createConfiguredAiProvider(makeCtx({}), definition, {
      roundDecimals: 2,
      ollamaEndpoint: "http://local-ai:11434",
    });

    expect(provider?.requiresNetwork).toBe(false);
    expect(provider?.isAi).toBe(true);
    expect(provider?.cacheKey).toContain("gemma3:4b-it-qat");
  });

  it("sends OpenRouter's privacy and routing constraints with the request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "generation-1",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-4.1-mini",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: JSON.stringify(WIRE_INTENT) },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const [definition] = ProviderDefinitionsSchema.parse([
      {
        id: "router",
        type: "openrouter",
        model: "openai/gpt-4.1-mini",
        providerOrder: ["OpenAI"],
        allowFallbacks: false,
        dataCollection: "deny",
        zeroDataRetention: true,
      },
    ]);
    const provider = createConfiguredAiProvider(
      makeCtx({ openrouterApiKey: "secret" }),
      definition,
      { roundDecimals: 2 },
    );

    await provider?.parseQuery("museums", CTX);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.provider).toEqual({
      require_parameters: true,
      allow_fallbacks: false,
      data_collection: "deny",
      zdr: true,
      order: ["OpenAI"],
    });
  });
});
