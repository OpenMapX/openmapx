import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { IntegrationContext, NlpProvider } from "@openmapx/integration-framework";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, type JSONValue, type LanguageModel, Output } from "ai";
import { normalizeSearchIntent, SearchIntentWireSchema } from "../intent-schema";
import { buildSystemPrompt, buildUserMessage } from "../prompt";
import {
  DEFAULT_OLLAMA_ENDPOINT,
  isPrivateEndpoint,
  type ProviderDefinition,
  providerLabel,
  providerProcessors,
  providerTimeoutMs,
} from "../provider-config";
import type { ParseContext } from "../types";

type AiProviderOptions = Record<string, Record<string, JSONValue>>;

function describeWarning(warning: unknown): string {
  try {
    return JSON.stringify(warning) ?? String(warning);
  } catch {
    return String(warning);
  }
}

export interface AiSdkNlpProviderOptions {
  id: string;
  label: string;
  model: LanguageModel;
  timeoutMs: number;
  requiresNetwork: boolean;
  cloudProcessors: NlpProvider["cloudProcessors"];
  cacheKey: string;
  roundDecimals?: number;
  providerOptions?: AiProviderOptions;
  cacheSystemPrompt?: boolean;
  warn?: (message: string) => void;
}

export function createAiSdkNlpProvider(options: AiSdkNlpProviderOptions): NlpProvider {
  return {
    id: options.id,
    label: options.label,
    cacheKey: options.cacheKey,
    isAi: true,
    requiresNetwork: options.requiresNetwork,
    cloudProcessors: options.cloudProcessors,
    async parseQuery(query: string, ctx: ParseContext) {
      const instructions = options.cacheSystemPrompt
        ? {
            role: "system" as const,
            content: buildSystemPrompt(),
            providerOptions: {
              anthropic: { cacheControl: { type: "ephemeral" as const } },
            },
          }
        : buildSystemPrompt();

      const result = await generateText({
        model: options.model,
        instructions,
        prompt: buildUserMessage(query, ctx, options.roundDecimals ?? 2),
        output: Output.object({
          name: "search_intent",
          description: "A normalized OpenStreetMap search intent",
          schema: SearchIntentWireSchema,
        }),
        temperature: 0,
        maxOutputTokens: 1_024,
        maxRetries: 0,
        timeout: { totalMs: options.timeoutMs },
        providerOptions: options.providerOptions,
        telemetry: { isEnabled: false },
      });

      const warnings = result.warnings ?? [];
      if (warnings.length > 0) {
        options.warn?.(
          `[search-nlp] ${options.id} returned ${warnings.length} provider warning(s): ${warnings
            .map(describeWarning)
            .join("; ")}`,
        );
      }

      return normalizeSearchIntent(result.output);
    },
  };
}

function readSecret(ctx: IntegrationContext, key: string): string | undefined {
  const value = ctx.config[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireSecret(
  ctx: IntegrationContext,
  definition: ProviderDefinition,
  key: string,
): string | undefined {
  const value = readSecret(ctx, key);
  if (!value) {
    ctx.log.warn(`[search-nlp] ${definition.id} requires ${key}; skipping provider`);
  }
  return value;
}

function withV1(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

export function createConfiguredAiProvider(
  ctx: IntegrationContext,
  definition: Exclude<ProviderDefinition, { type: "keyword" }>,
  options: { roundDecimals: number; ollamaEndpoint?: string },
): NlpProvider | null {
  const common = {
    id: definition.id,
    label: providerLabel(definition),
    timeoutMs: providerTimeoutMs(definition),
    cacheKey: JSON.stringify(definition),
    roundDecimals: options.roundDecimals,
    warn: (message: string) => ctx.log.warn(message),
  };

  switch (definition.type) {
    case "ollama": {
      const endpoint = definition.baseURL ?? options.ollamaEndpoint ?? DEFAULT_OLLAMA_ENDPOINT;
      if (!isPrivateEndpoint(endpoint)) {
        ctx.log.error(
          `[search-nlp] ${definition.id} rejected: Ollama endpoint must be local/private`,
        );
        return null;
      }
      const ollama = createOpenAICompatible({
        name: `ollama-${definition.id}`,
        baseURL: withV1(endpoint),
        supportsStructuredOutputs: true,
      });
      return createAiSdkNlpProvider({
        ...common,
        model: ollama(definition.model),
        requiresNetwork: false,
        cloudProcessors: [],
      });
    }
    case "anthropic": {
      const apiKey = requireSecret(ctx, definition, "anthropicApiKey");
      if (!apiKey) return null;
      return createAiSdkNlpProvider({
        ...common,
        model: createAnthropic({ apiKey })(definition.model),
        requiresNetwork: true,
        cloudProcessors: providerProcessors(definition),
        cacheSystemPrompt: true,
      });
    }
    case "openai": {
      const apiKey = requireSecret(ctx, definition, "openaiApiKey");
      if (!apiKey) return null;
      const openai = createOpenAI({ apiKey });
      return createAiSdkNlpProvider({
        ...common,
        model:
          definition.api === "chat"
            ? openai.chat(definition.model)
            : openai.responses(definition.model),
        requiresNetwork: true,
        cloudProcessors: providerProcessors(definition),
      });
    }
    case "google": {
      const apiKey = requireSecret(ctx, definition, "googleApiKey");
      if (!apiKey) return null;
      return createAiSdkNlpProvider({
        ...common,
        model: createGoogle({ apiKey })(definition.model),
        requiresNetwork: true,
        cloudProcessors: providerProcessors(definition),
        providerOptions: { google: { structuredOutputs: true } },
      });
    }
    case "openrouter": {
      const apiKey = requireSecret(ctx, definition, "openrouterApiKey");
      if (!apiKey) return null;
      const providerRouting: Record<string, JSONValue> = {
        require_parameters: true,
        allow_fallbacks: definition.allowFallbacks,
        data_collection: definition.dataCollection,
        zdr: definition.zeroDataRetention,
      };
      if (definition.providerOrder.length > 0) {
        providerRouting.order = definition.providerOrder;
      }
      const openrouter = createOpenRouter({
        apiKey,
        compatibility: "strict",
        appName: "OpenMapX",
        appUrl: "https://openmapx.org",
        extraBody: { provider: providerRouting },
      });
      return createAiSdkNlpProvider({
        ...common,
        model: openrouter.chat(definition.model),
        requiresNetwork: true,
        cloudProcessors: providerProcessors(definition),
      });
    }
    case "openai-compatible": {
      const apiKey =
        definition.credential === "none"
          ? undefined
          : requireSecret(ctx, definition, definition.credential);
      if (definition.credential !== "none" && !apiKey) return null;
      const compatible = createOpenAICompatible({
        name: definition.id,
        apiKey,
        baseURL: definition.baseURL,
        supportsStructuredOutputs: definition.supportsStructuredOutputs,
      });
      return createAiSdkNlpProvider({
        ...common,
        model: compatible(definition.model),
        requiresNetwork: !definition.local,
        cloudProcessors: providerProcessors(definition),
      });
    }
  }
}
