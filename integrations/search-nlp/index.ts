import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { IntegrationContext, NlpProvider } from "@openmapx/integration-framework";
import OpenAI from "openai";
import { createChain } from "./orchestrator";
import { createClaudeProvider } from "./providers/claude";
import { keywordProvider } from "./providers/keyword";
import { createOllamaProvider } from "./providers/ollama";
import { createOpenAiProvider } from "./providers/openai";
import { resolveSpatialConstraint } from "./spatial-resolver";
import type { ParseContext } from "./types";

const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "gemma3:4b-it-qat";
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_LOCAL_TIMEOUT = 10000;
const DEFAULT_CLOUD_TIMEOUT = 3000;
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

function ollamaEndpoint(ctx: IntegrationContext): string {
  return (
    ctx.getRequiredService("local-ai")?.url ??
    readString(ctx, "ollamaEndpoint") ??
    DEFAULT_OLLAMA_ENDPOINT
  );
}

/**
 * Build the configured provider list once at setup. Always guarantees a
 * deterministic keyword floor so `chain.parse` can never fail outright.
 */
export function __buildProviders(ctx: IntegrationContext): NlpProvider[] {
  const chain = (ctx.config.providerChain as string[] | undefined) ?? ["local", "keyword"];
  const roundDecimals = readNumber(ctx, "roundCoordsDecimals") ?? DEFAULT_ROUND_DECIMALS;
  const localTimeoutMs = readNumber(ctx, "localTimeoutMs") ?? DEFAULT_LOCAL_TIMEOUT;
  const cloudTimeoutMs = readNumber(ctx, "cloudTimeoutMs") ?? DEFAULT_CLOUD_TIMEOUT;

  const providers: NlpProvider[] = [];

  for (const id of chain) {
    if (id === "keyword") {
      providers.push(keywordProvider);
    } else if (id === "local") {
      providers.push(
        createOllamaProvider({
          endpoint: ollamaEndpoint(ctx),
          model: readString(ctx, "ollamaModel") ?? DEFAULT_OLLAMA_MODEL,
          timeoutMs: localTimeoutMs,
          roundDecimals,
        }),
      );
    } else if (id === "claude") {
      const apiKey = readString(ctx, "anthropicApiKey");
      if (apiKey) {
        const client = new Anthropic({ apiKey });
        providers.push(
          createClaudeProvider({
            model: readString(ctx, "claudeModel") ?? DEFAULT_CLAUDE_MODEL,
            timeoutMs: cloudTimeoutMs,
            client: client as unknown as Parameters<typeof createClaudeProvider>[0]["client"],
            roundDecimals,
          }),
        );
      } else {
        ctx.log.warn("[search-nlp] claude in chain but anthropicApiKey not set; skipping");
      }
    } else if (id === "openai") {
      const apiKey = readString(ctx, "openaiApiKey");
      if (apiKey) {
        const client = new OpenAI({ apiKey });
        providers.push(
          createOpenAiProvider({
            model: readString(ctx, "openaiModel") ?? DEFAULT_OPENAI_MODEL,
            timeoutMs: cloudTimeoutMs,
            client: client as unknown as Parameters<typeof createOpenAiProvider>[0]["client"],
            roundDecimals,
          }),
        );
      } else {
        ctx.log.warn("[search-nlp] openai in chain but openaiApiKey not set; skipping");
      }
    }
  }

  if (!providers.some((p) => p.id === "keyword")) {
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
  if (!out.some((p) => p.id === "keyword")) out.push(keywordProvider);
  return out;
}

/**
 * When the client has declined cloud consent, strip any provider that requires
 * network access (cloud) from the active list. The keyword floor is preserved.
 */
export function applyNoCloud(providers: NlpProvider[]): NlpProvider[] {
  const local = providers.filter((p) => !p.requiresNetwork);
  if (local.some((p) => p.id === "keyword")) return local;
  return [...local, keywordProvider];
}

function intentCacheKey(query: string, center: [number, number], decimals: number): string {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  const lng = center[0].toFixed(decimals);
  const lat = center[1].toFixed(decimals);
  return `nlp:intent:${createHash("sha256").update(`${normalized}|${lng},${lat}`).digest("hex").slice(0, 32)}`;
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
async function ensureOllamaModel(ctx: IntegrationContext): Promise<void> {
  try {
    const endpoint = ollamaEndpoint(ctx);
    const model = readString(ctx, "ollamaModel") ?? DEFAULT_OLLAMA_MODEL;
    const tagsRes = await fetch(`${endpoint}/api/tags`);
    if (!tagsRes.ok) return;
    const data = (await tagsRes.json()) as { models?: Array<{ name?: string }> };
    const present = (data.models ?? []).some((m) => m.name === model);
    if (present) return;
    ctx.log.info(`[search-nlp] pulling Ollama model ${model}`);
    await fetch(`${endpoint}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
    });
  } catch (err) {
    ctx.log.warn("[search-nlp] ensureOllamaModel failed (best-effort)", (err as Error).message);
  }
}

export function setup(ctx: IntegrationContext): void {
  const providers = __buildProviders(ctx);
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
          noCloud?: unknown;
        }
      | null
      | undefined;

    const query = typeof body?.query === "string" ? body.query : undefined;
    const mapCenter = body?.mapCenter as [number, number] | undefined;
    const mapBbox = body?.mapBbox as
      | { south: number; west: number; north: number; east: number }
      | undefined;
    const lang = typeof body?.lang === "string" ? body.lang : undefined;
    const noCloud = body?.noCloud === true;

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
    // privacyMode "strict" enforces no-cloud server-side: cloud providers are
    // always excluded regardless of the client's noCloud flag, so a request can
    // never reach a requiresNetwork provider in strict mode.
    const strictPrivacy = readString(ctx, "privacyMode") === "strict";
    const active = noCloud || strictPrivacy ? applyNoCloud(afterBreakers) : afterBreakers;
    const chain = createChain(active);
    const parseCtx: ParseContext = { mapCenter, mapBbox, lang };

    let cached = true;
    const key = intentCacheKey(query, mapCenter, roundDecimals);

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

      reply.send({ intent: result.intent, resolvedBbox, provider: result.provider, cached });
    } catch (err) {
      // Best-effort breaker: trip any cloud provider that participated. A
      // chain failure here is unexpected (keyword floor is deterministic),
      // so we trip every cloud provider in the active set.
      for (const p of active) {
        if (p.requiresNetwork) {
          await ctx.cache.set(breakerKey(p.id), 1, BREAKER_TTL_SECONDS).catch(() => {});
        }
      }
      ctx.log.error("[search-nlp] parse failed", (err as Error).message);
      reply.status(502).send({ error: "nlp_unavailable" });
    }
  });

  const chainIds = (ctx.config.providerChain as string[] | undefined) ?? ["local", "keyword"];
  if (chainIds.includes("local")) {
    void ensureOllamaModel(ctx);
  }

  ctx.log.info("[search-nlp] ready");
}
