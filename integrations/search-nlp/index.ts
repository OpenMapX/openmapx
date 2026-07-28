import { createHash } from "node:crypto";
import { fetchJson } from "@openmapx/core";
import type {
  AiSearchDisclosure,
  IntegrationContext,
  NlpProvider,
} from "@openmapx/integration-framework";
import { createChain } from "./orchestrator";
import {
  DEFAULT_OLLAMA_ENDPOINT,
  isPrivateEndpoint,
  type ProviderDefinition,
  providerLabel,
  readProviderDefinitions,
} from "./provider-config";
import { createConfiguredAiProvider } from "./providers/ai-sdk";
import { keywordProvider } from "./providers/keyword";
import { resolveSpatialConstraint } from "./spatial-resolver";
import type { ParseContext } from "./types";

const DEFAULT_ROUND_DECIMALS = 2;
const DEFAULT_INTENT_TTL = 86400;
const DEFAULT_RATE_LIMIT = 200;
const BREAKER_TTL_SECONDS = 60;

function readString(ctx: IntegrationContext, key: string): string | undefined {
  const v = ctx.config[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readNumber(ctx: IntegrationContext, key: string): number | undefined {
  const v = ctx.config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function localAiEndpoint(ctx: IntegrationContext): string | undefined {
  return ctx.getRequiredService("local-ai")?.url;
}

/**
 * Build the configured provider list once at setup. Always guarantees a
 * deterministic keyword floor so `chain.parse` can never fail outright.
 */
export function __buildProviders(
  ctx: IntegrationContext,
  definitions: ProviderDefinition[] = readProviderDefinitions(ctx),
): NlpProvider[] {
  const roundDecimals = readNumber(ctx, "roundCoordsDecimals") ?? DEFAULT_ROUND_DECIMALS;
  const providers: NlpProvider[] = [];

  for (const definition of definitions) {
    if (definition.type === "keyword") {
      providers.push({
        ...keywordProvider,
        id: definition.id,
        label: providerLabel(definition),
        cacheKey: JSON.stringify(definition),
      });
      continue;
    }

    const provider = createConfiguredAiProvider(ctx, definition, {
      roundDecimals,
      ollamaEndpoint: localAiEndpoint(ctx),
    });
    if (provider) providers.push(provider);
  }

  if (!providers.some((provider) => !provider.isAi)) {
    providers.push(keywordProvider);
  }

  return providers;
}

function breakerKey(id: string): string {
  return `nlp:breaker:${id}`;
}

/**
 * Per-request circuit-breaker filter: drop any CLOUD provider
 * (requiresNetwork) whose breaker key is currently set. Local/keyword
 * providers are never broken.
 */
export async function __filterOpenBreakers(
  providers: NlpProvider[],
  ctx: IntegrationContext,
): Promise<NlpProvider[]> {
  const out: NlpProvider[] = [];
  for (const p of providers) {
    if (!p.requiresNetwork) {
      out.push(p);
      continue;
    }
    const open = await ctx.cache.get<number>(breakerKey(p.id));
    if (!open) out.push(p);
  }
  // Keyword floor: if filtering removed everything but keyword stays.
  if (!out.some((provider) => !provider.isAi)) out.push(keywordProvider);
  return out;
}

/**
 * When the client has declined cloud consent, strip any provider that requires
 * network access (cloud) from the active list. The keyword floor is preserved.
 */
export function applyLocalOnly(providers: NlpProvider[]): NlpProvider[] {
  const local = providers.filter((p) => !p.requiresNetwork);
  if (local.some((provider) => !provider.isAi)) return local;
  return [...local, keywordProvider];
}

export function intentCacheKey(
  query: string,
  center: [number, number],
  decimals: number,
  chainId: string,
  cloudAllowed: boolean,
): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  const lng = center[0].toFixed(decimals);
  const lat = center[1].toFixed(decimals);
  const material = `${normalized}|${lng},${lat}|${chainId}|${cloudAllowed ? "cl" : "nc"}`;
  return `nlp:intent:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

/**
 * Build the rate-limit cache key for an IP within a fixed hourly bucket. The
 * bucket id is `floor(epochSeconds / 3600)`, so the key changes every hour and
 * the count resets naturally — no rolling-window problem. Re-setting the 1h TTL
 * within the same bucket is harmless (the bucket id, not the TTL, bounds the
 * window). Exported so tests can assert the key contains the hour bucket.
 */
export function __rateLimitKey(ip: string, nowMs: number = Date.now()): string {
  const bucket = Math.floor(nowMs / 1000 / 3600);
  return `nlp:rl:${ip}:${bucket}`;
}

/**
 * Best-effort per-IP hourly rate limiter built on the get/set cache API (the
 * CacheClient has no `incr` and no keep-TTL update). Uses a time-bucketed key
 * so the hourly window is a FIXED bucket rather than a rolling one: the count
 * lives at `nlp:rl:<ip>:<hourBucket>` with a 1h TTL on every write, and because
 * the bucket id changes each hour the count resets cleanly. Returns true when
 * the request is allowed.
 */
async function rateLimitAllow(
  ctx: IntegrationContext,
  ip: string,
  limit: number,
): Promise<boolean> {
  const key = __rateLimitKey(ip);
  const current = (await ctx.cache.get<number>(key)) ?? 0;
  if (current >= limit) return false;
  await ctx.cache.set(key, current + 1, 3600);
  return true;
}

/**
 * Model-ensure: if the configured Ollama model isn't pulled yet, pull it.
 * Never throws, never blocks setup.
 */
async function ensureOllamaModel(
  ctx: IntegrationContext,
  definition: Extract<ProviderDefinition, { type: "ollama" }>,
): Promise<void> {
  try {
    const endpoint = definition.baseURL ?? localAiEndpoint(ctx) ?? DEFAULT_OLLAMA_ENDPOINT;
    const model = definition.model;
    if (!isPrivateEndpoint(endpoint)) {
      ctx.log.error("[search-nlp] refusing to pull from a non-private Ollama endpoint");
      return;
    }
    const data = await fetchJson<{ models?: Array<{ name?: string }> }>(`${endpoint}/api/tags`, {
      nullOnError: true,
    });
    if (!data) return;
    const present = (data.models ?? []).some((m) => m.name === model);
    if (present) return;
    ctx.log.info(`[search-nlp] pulling Ollama model ${model}`);
    // Deliberately unbounded: pulling a model can take many minutes on a slow
    // connection or a large model, and the response body is never consumed
    // here (fire-and-forget) — a fetchJson-style timeout would abort a
    // still-healthy download.
    await fetch(`${endpoint}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
    });
  } catch (err) {
    ctx.log.warn("[search-nlp] ensureOllamaModel failed (best-effort)", (err as Error).message);
  }
}

export function computeAiSearchDisclosure(providers: NlpProvider[]): AiSearchDisclosure {
  const processors = new Map(
    providers
      .flatMap((provider) => provider.cloudProcessors)
      .map((processor) => [processor.id, processor]),
  );
  const cloudProcessors = [...processors.values()];
  const localActive = providers.some((provider) => provider.isAi && !provider.requiresNetwork);
  const cloudActive = providers.some((provider) => provider.isAi && provider.requiresNetwork);
  return {
    type: "ai-search",
    integrationId: "search-nlp",
    aiActive: providers.some((provider) => provider.isAi),
    localActive,
    cloudActive,
    cloudProcessors,
  };
}

export function setup(ctx: IntegrationContext): void {
  const definitions = readProviderDefinitions(ctx);
  const providers = __buildProviders(ctx, definitions);
  const disclosure = computeAiSearchDisclosure(providers);
  ctx.registerDisclosure(disclosure);
  const roundDecimals = readNumber(ctx, "roundCoordsDecimals") ?? DEFAULT_ROUND_DECIMALS;
  const intentTtl = readNumber(ctx, "intentCacheTtlSeconds") ?? DEFAULT_INTENT_TTL;
  const rateLimit = readNumber(ctx, "rateLimitPerIpPerHour") ?? DEFAULT_RATE_LIMIT;

  ctx.registerRoute("POST", "/parse", async (req, reply) => {
    const body = req.body as
      | {
          query?: unknown;
          mapCenter?: unknown;
          mapBbox?: unknown;
          lang?: unknown;
          cloudAccess?: unknown;
        }
      | null
      | undefined;

    const query = typeof body?.query === "string" ? body.query : undefined;
    const mapCenter = body?.mapCenter as [number, number] | undefined;
    const mapBbox = body?.mapBbox as
      | { south: number; west: number; north: number; east: number }
      | undefined;
    const lang = typeof body?.lang === "string" ? body.lang : undefined;
    const cloudAccess =
      body?.cloudAccess === "consented" || body?.cloudAccess === "defer-to-server"
        ? body.cloudAccess
        : "deny";

    if (
      !query ||
      !Array.isArray(mapCenter) ||
      mapCenter.length !== 2 ||
      typeof mapCenter[0] !== "number" ||
      typeof mapCenter[1] !== "number" ||
      !mapBbox ||
      typeof mapBbox.south !== "number" ||
      typeof mapBbox.west !== "number" ||
      typeof mapBbox.north !== "number" ||
      typeof mapBbox.east !== "number"
    ) {
      reply.status(400).send({ error: "query, mapCenter and mapBbox are required" });
      return;
    }

    // Per-IP hourly limit. The integration route abstraction does not expose
    // the socket peer, so we key on a forwarded `ip` query value when present
    // (the dispatcher in apps/api/server.ts enforces the real per-IP throttle
    // against the trusted socket peer). Falls back to a shared "anon" bucket.
    const ip = typeof req.query.ip === "string" && req.query.ip ? req.query.ip : "anon";
    if (!(await rateLimitAllow(ctx, ip, rateLimit))) {
      reply.header("Retry-After", "3600");
      reply.status(429).send({ error: "rate_limited" });
      return;
    }

    const afterBreakers = await __filterOpenBreakers(providers, ctx);
    // Cloud access is fail-closed. Consent mode needs an explicit positive
    // authorization on every request; open mode additionally accepts a client
    // request to defer to server policy. Strict mode always excludes cloud.
    const privacyMode = readString(ctx, "privacyMode") ?? "consent";
    const strictPrivacy = privacyMode === "strict";
    const cloudAllowed =
      !strictPrivacy &&
      (cloudAccess === "consented" ||
        (privacyMode === "open" && cloudAccess === "defer-to-server"));
    const active = cloudAllowed ? afterBreakers : applyLocalOnly(afterBreakers);
    const chain = createChain(active, {
      onProviderFailure: async (provider, error) => {
        if (!provider.requiresNetwork) return;
        await ctx.cache.set(breakerKey(provider.id), 1, BREAKER_TTL_SECONDS).catch(() => {});
        ctx.log.warn(`[search-nlp] provider ${provider.id} failed`, (error as Error).message);
      },
    });
    const parseCtx: ParseContext = { mapCenter, mapBbox, lang };

    const chainId = active.map((provider) => provider.cacheKey).join("|");

    let cached = true;
    const key = intentCacheKey(query, mapCenter, roundDecimals, chainId, cloudAllowed);

    try {
      const result = await ctx.cache.withCache(key, intentTtl, async () => {
        cached = false;
        return chain.parse(query, parseCtx);
      });

      const resolvedBbox = await resolveSpatialConstraint(
        result.intent.spatial_constraint,
        mapBbox,
        mapCenter,
        ctx,
        lang,
      );

      reply.send({
        intent: result.intent,
        resolvedBbox,
        provider: result.provider.id,
        providerLabel: result.provider.label,
        cloud: result.provider.cloud,
        cloudAvailable: !strictPrivacy && disclosure.cloudActive,
        cloudConsentRequired: privacyMode === "consent",
        cloudProviderLabels: providers
          .filter((provider) => provider.requiresNetwork)
          .map((provider) => provider.label),
        cached,
      });
    } catch (err) {
      ctx.log.error("[search-nlp] parse failed", (err as Error).message);
      reply.status(502).send({ error: "nlp_unavailable" });
    }
  });

  for (const definition of definitions) {
    if (definition.type === "ollama") void ensureOllamaModel(ctx, definition);
  }

  ctx.log.info("[search-nlp] ready");
}
