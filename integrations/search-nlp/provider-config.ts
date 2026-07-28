import { isIP } from "node:net";
import type { AiCloudProcessor, IntegrationContext } from "@openmapx/integration-framework";
import { z } from "zod/v4";

export const DEFAULT_LOCAL_TIMEOUT_MS = 10_000;
export const DEFAULT_CLOUD_TIMEOUT_MS = 3_000;
export const DEFAULT_OLLAMA_MODEL = "gemma3:4b-it-qat";
export const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, dot, underscore, or dash");
const modelSchema = z.string().min(1).max(200);
const timeoutSchema = z.number().int().min(250).max(120_000).optional();
const labelSchema = z.string().min(1).max(100).optional();

const processorSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1).max(100),
    countryCode: z.string().min(2).max(10),
    privacyUrl: z.string().url().refine(isHttpsEndpoint, "processor privacy URLs must use HTTPS"),
  })
  .strict();

const keywordDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("keyword"),
    label: labelSchema,
  })
  .strict();

const ollamaDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("ollama"),
    label: labelSchema,
    model: modelSchema,
    baseURL: z.string().url().optional(),
    timeoutMs: timeoutSchema,
  })
  .strict();

const anthropicDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("anthropic"),
    label: labelSchema,
    model: modelSchema,
    timeoutMs: timeoutSchema,
  })
  .strict();

const openAiDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("openai"),
    label: labelSchema,
    model: modelSchema,
    api: z.enum(["responses", "chat"]).default("responses"),
    timeoutMs: timeoutSchema,
  })
  .strict();

const googleDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("google"),
    label: labelSchema,
    model: modelSchema,
    timeoutMs: timeoutSchema,
  })
  .strict();

const openRouterDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("openrouter"),
    label: labelSchema,
    model: modelSchema,
    timeoutMs: timeoutSchema,
    providerOrder: z.array(z.string().min(1)).default([]),
    allowFallbacks: z.boolean().default(true),
    dataCollection: z.enum(["allow", "deny"]).default("deny"),
    zeroDataRetention: z.boolean().default(true),
  })
  .strict();

export const compatibleCredentialKeys = ["none", "compatibleApiKey"] as const;

const compatibleDefinitionSchema = z
  .object({
    id: idSchema,
    type: z.literal("openai-compatible"),
    label: labelSchema,
    model: modelSchema,
    baseURL: z.string().url(),
    credential: z.enum(compatibleCredentialKeys).default("compatibleApiKey"),
    supportsStructuredOutputs: z.boolean().default(true),
    local: z.boolean().default(false),
    timeoutMs: timeoutSchema,
    processor: processorSchema.optional(),
  })
  .strict();

const providerDefinitionSchema = z.discriminatedUnion("type", [
  keywordDefinitionSchema,
  ollamaDefinitionSchema,
  anthropicDefinitionSchema,
  openAiDefinitionSchema,
  googleDefinitionSchema,
  openRouterDefinitionSchema,
  compatibleDefinitionSchema,
]);

export const ProviderDefinitionsSchema = z
  .array(providerDefinitionSchema)
  .min(1)
  .max(20)
  .superRefine((definitions, ctx) => {
    const seen = new Set<string>();
    definitions.forEach((definition, index) => {
      if (seen.has(definition.id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "id"],
          message: `duplicate provider id ${definition.id}`,
        });
      }
      seen.add(definition.id);

      if (definition.type === "ollama" && definition.baseURL) {
        if (!isPrivateEndpoint(definition.baseURL)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "baseURL"],
            message: "Ollama endpoints must resolve through a local/private hostname or IP",
          });
        }
      }

      if (definition.type === "openai-compatible") {
        if (definition.local && !isPrivateEndpoint(definition.baseURL)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "baseURL"],
            message: "local providers must use a local/private hostname or IP",
          });
        }
        if (!definition.local && !definition.processor) {
          ctx.addIssue({
            code: "custom",
            path: [index, "processor"],
            message: "cloud-compatible providers require processor disclosure metadata",
          });
        }
        if (!definition.local && !isHttpsEndpoint(definition.baseURL)) {
          ctx.addIssue({
            code: "custom",
            path: [index, "baseURL"],
            message: "cloud-compatible providers must use HTTPS",
          });
        }
      }
    });
  });

export type ProviderDefinition = z.infer<typeof providerDefinitionSchema>;
export type CompatibleProviderDefinition = Extract<
  ProviderDefinition,
  { type: "openai-compatible" }
>;

export const DEFAULT_PROVIDER_DEFINITIONS: ProviderDefinition[] = ProviderDefinitionsSchema.parse([
  { id: "local", type: "ollama", model: DEFAULT_OLLAMA_MODEL },
  { id: "keyword", type: "keyword" },
]);

const BUILTIN_PROCESSORS: Record<
  "anthropic" | "openai" | "google" | "openrouter",
  AiCloudProcessor
> = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic (Claude)",
    countryCode: "US",
    privacyUrl: "https://www.anthropic.com/legal/privacy",
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    countryCode: "US",
    privacyUrl: "https://openai.com/policies/privacy-policy/",
  },
  google: {
    id: "google",
    name: "Google (Gemini)",
    countryCode: "US",
    privacyUrl: "https://policies.google.com/privacy",
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter and selected inference providers",
    countryCode: "VARIES",
    privacyUrl: "https://openrouter.ai/privacy",
  },
};

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function isHttpsEndpoint(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).protocol === "https:";
  } catch {
    return false;
  }
}

export function isPrivateEndpoint(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".svc") ||
      hostname.endsWith(".home.arpa") ||
      !hostname.includes(".")
    ) {
      return true;
    }
    const ipVersion = isIP(hostname);
    if (ipVersion === 4) return isPrivateIpv4(hostname);
    if (ipVersion === 6) {
      return (
        hostname === "::1" ||
        hostname.startsWith("fc") ||
        hostname.startsWith("fd") ||
        hostname.startsWith("fe80:")
      );
    }
    return false;
  } catch {
    return false;
  }
}

export function readProviderDefinitions(ctx: IntegrationContext): ProviderDefinition[] {
  const parsed = ProviderDefinitionsSchema.safeParse(ctx.config.providers);
  if (parsed.success) return parsed.data;
  ctx.log.warn(
    "[search-nlp] invalid providers configuration; using local-first defaults",
    z.prettifyError(parsed.error),
  );
  return DEFAULT_PROVIDER_DEFINITIONS;
}

export function providerLabel(definition: ProviderDefinition): string {
  if (definition.label) return definition.label;
  switch (definition.type) {
    case "keyword":
      return "Keyword parser";
    case "ollama":
      return `Ollama · ${definition.model}`;
    case "anthropic":
      return `Claude · ${definition.model}`;
    case "openai":
      return `OpenAI · ${definition.model}`;
    case "google":
      return `Gemini · ${definition.model}`;
    case "openrouter":
      return `OpenRouter · ${definition.model}`;
    case "openai-compatible":
      return `${definition.id} · ${definition.model}`;
  }
}

export function providerProcessors(definition: ProviderDefinition): AiCloudProcessor[] {
  switch (definition.type) {
    case "anthropic":
    case "openai":
    case "google":
    case "openrouter":
      return [BUILTIN_PROCESSORS[definition.type]];
    case "openai-compatible":
      return definition.local || !definition.processor ? [] : [definition.processor];
    case "keyword":
    case "ollama":
      return [];
  }
}

export function providerTimeoutMs(definition: ProviderDefinition): number {
  if ("timeoutMs" in definition && definition.timeoutMs !== undefined) {
    return definition.timeoutMs;
  }
  return definition.type === "keyword" || definition.type === "ollama"
    ? DEFAULT_LOCAL_TIMEOUT_MS
    : DEFAULT_CLOUD_TIMEOUT_MS;
}
