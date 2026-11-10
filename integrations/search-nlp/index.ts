import { createHash } from "node:crypto";
import { fetchJson } from "@openmapx/core";
import type {
  AiSearchDisclosure,
  IntegrationContext,
  NlpProvider,
} from "@openmapx/integration-framework";
import { resolveBrandPredicates } from "./brand-resolution";
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
const DEFAULT_CLOUD_REQUESTS_PER_DAY = 1_000;
const DEFAULT_CLOUD_REQUESTS_PER_CLIENT_PER_HOUR = 20;
const BREAKER_TTL_SECONDS = 60;
/** Longest query accepted, in characters. A search phrase never needs more. */
export const MAX_QUERY_CHARACTERS = 500;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function readString(ctx: IntegrationContext, key: string): string | undefined {
  const v = ctx.config[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readNumber(ctx: IntegrationContext, key: string): number | undefined {
  const v = ctx.config[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function readPositiveInteger(ctx: IntegrationContext, key: string): number | undefined {
  const v = ctx.config[key];
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
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

/** Only the deterministic, non-AI providers; the keyword floor is guaranteed. */
export function applyKeywordOnly(providers: NlpProvider[]): NlpProvider[] {
  const keyword = providers.filter((p) => !p.isAi);
  return keyword.length > 0 ? keyword : [keywordProvider];
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
 * Build the rate-limit cache key for a client within a fixed hourly bucket.
 * The bucket id is `floor(epochSeconds / 3600)`, so the key changes every hour
 * and the count resets naturally. Exported so tests can assert the key
 * contains the hour bucket.
 */
export function __rateLimitKey(clientKey: string, nowMs: number = Date.now()): string {
  const bucket = Math.floor(nowMs / 1000 / 3600);
  return `nlp:rl:${clientKey}:${bucket}`;
}

type QuotaOutcome = "allowed" | "denied" | "unavailable";

/**
 * Per-client hourly parse quota, keyed by the host's trusted client key so a
 * caller can neither pick its own bucket nor exhaust anyone else's. With the
 * shared upstream runtime the count is atomic across replicas; without one (a
 * development checkout) a best-effort cache counter stands in.
 */
async function consumeParseQuota(
  ctx: IntegrationContext,
  clientKey: string,
  limit: number,
): Promise<QuotaOutcome> {
  const runtime = ctx.upstreamRuntime;
  if (runtime) {
    const decision = await runtime.consumeQuota({
      bucket: "parse",
      cost: 1,
      windows: [{ id: `client:${clientKey}`, limit, durationMs: HOUR_MS }],
    });
    if (decision.allowed) return "allowed";
    return decision.diagnostic === "store_unavailable" ? "unavailable" : "denied";
  }
  const key = __rateLimitKey(clientKey);
  const current = (await ctx.cache.get<number>(key)) ?? 0;
  if (current >= limit) return "denied";
  await ctx.cache.set(key, current + 1, 3600);
  return "allowed";
}

/** A cloud call the budget refused. It is not a provider failure. */
export class CloudBudgetDeniedError extends Error {
  constructor() {
    super("Cloud search budget exhausted");
    this.name = "CloudBudgetDeniedError";
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/**
 * Wraps cloud providers so each call first takes one unit from two budgets in
 * one atomic step: the caller's hourly share and the deployment's daily total.
 * A refused call never reaches the provider, and one caller can use at most
 * its hourly share of the daily total. Without the shared runtime, or with it
 * unreachable, every cloud call is refused: paid usage is never unmetered.
 */
function budgetCloudProviders(
  ctx: IntegrationContext,
  providers: NlpProvider[],
  budgetKey: string,
  limits: { perDay: number; perClientPerHour: number },
): NlpProvider[] {
  const admit = async () => {
    const runtime = ctx.upstreamRuntime;
    if (!runtime) throw new CloudBudgetDeniedError();
    const decision = await runtime.consumeQuota({
      bucket: "cloud",
      cost: 1,
      windows: [
        { id: `client:${budgetKey}`, limit: limits.perClientPerHour, durationMs: HOUR_MS },
        { id: "deployment", limit: limits.perDay, durationMs: DAY_MS },
      ],
    });
    if (!decision.allowed) throw new CloudBudgetDeniedError();
  };
  return providers.map((provider) => {
    if (!provider.requiresNetwork) return provider;
    const budgeted = Object.create(provider) as NlpProvider;
    budgeted.parseQuery = async (query, parseContext) => {
      await admit();
      return provider.parseQuery(query, parseContext);
    };
    return budgeted;
  });
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

type PrivacyMode = "strict" | "consent" | "open";

export function computeAiSearchDisclosure(
  providers: NlpProvider[],
  privacyMode: PrivacyMode = "consent",
): AiSearchDisclosure {
  const processors = new Map(
    providers
      .flatMap((provider) => provider.cloudProcessors)
      .map((processor) => [processor.id, processor]),
  );
  const cloudProcessors = [...processors.values()];
  const localActive = providers.some((provider) => provider.isAi && !provider.requiresNetwork);
  const cloudActive = providers.some((provider) => provider.isAi && provider.requiresNetwork);
  const cloudAvailable = cloudActive && privacyMode !== "strict";
  return {
    type: "ai-search",
    integrationId: "search-nlp",
    aiActive: providers.some((provider) => provider.isAi),
    localActive,
    cloudActive,
    cloudProcessors,
    cloudAvailable,
    cloudConsentRequired: cloudAvailable && privacyMode === "consent",
    cloudRequiresSignIn: cloudAvailable && privacyMode === "consent",
    cloudProviderLabels: providers
      .filter((provider) => provider.requiresNetwork)
      .map((provider) => provider.label),
  };
}

export function setup(ctx: IntegrationContext): void {
  const definitions = readProviderDefinitions(ctx);
  const providers = __buildProviders(ctx, definitions);
  const configuredPrivacyMode = readString(ctx, "privacyMode");
  const privacyMode: PrivacyMode =
    configuredPrivacyMode === "strict" || configuredPrivacyMode === "open"
      ? configuredPrivacyMode
      : "consent";
  const disclosure = computeAiSearchDisclosure(providers, privacyMode);
  ctx.registerDisclosure(disclosure);
  const roundDecimals = readNumber(ctx, "roundCoordsDecimals") ?? DEFAULT_ROUND_DECIMALS;
  const intentTtl = readNumber(ctx, "intentCacheTtlSeconds") ?? DEFAULT_INTENT_TTL;
  const rateLimit = readNumber(ctx, "rateLimitPerIpPerHour") ?? DEFAULT_RATE_LIMIT;
  const cloudLimits = {
    perDay: readPositiveInteger(ctx, "cloudRequestsPerDay") ?? DEFAULT_CLOUD_REQUESTS_PER_DAY,
    perClientPerHour:
      readPositiveInteger(ctx, "cloudRequestsPerClientPerHour") ??
      DEFAULT_CLOUD_REQUESTS_PER_CLIENT_PER_HOUR,
  };

  ctx.registerRoute(
    "POST",
    "/parse",
    async (req, reply) => {
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

      if (query.length > MAX_QUERY_CHARACTERS && [...query].length > MAX_QUERY_CHARACTERS) {
        reply.status(400).send({ error: "query_too_long" });
        return;
      }

      const quota = await consumeParseQuota(ctx, req.clientKey, rateLimit);
      if (quota === "denied") {
        reply.header("Retry-After", "3600");
        reply.status(429).send({ error: "rate_limited" });
        return;
      }

      // Cloud access is decided here, never asserted by the client. Strict
      // mode never uses cloud. Open mode uses it unless the caller declines.
      // Consent mode uses it only for a signed-in user who opted in: the
      // choice belongs to an account the server has verified, and an
      // anonymous caller cannot unlock paid processing by sending a flag.
      const signedIn = typeof req.userId === "string" && req.userId.length > 0;
      const strictPrivacy = privacyMode === "strict";
      const cloudOffered = !strictPrivacy && (privacyMode === "open" || signedIn);
      const cloudAllowed =
        cloudOffered &&
        quota === "allowed" &&
        (cloudAccess === "consented" ||
          (privacyMode === "open" && cloudAccess === "defer-to-server"));

      const afterBreakers = await __filterOpenBreakers(providers, ctx);
      // A quota store that cannot be reached leaves only the deterministic
      // keyword floor: neither paid cloud calls nor local model time can be
      // metered, so neither runs.
      const permitted =
        quota === "unavailable"
          ? applyKeywordOnly(afterBreakers)
          : cloudAllowed
            ? afterBreakers
            : applyLocalOnly(afterBreakers);
      const budgetKey = signedIn ? `user:${digest(req.userId as string)}` : `net:${req.clientKey}`;
      const active = budgetCloudProviders(ctx, permitted, budgetKey, cloudLimits);
      let cloudBudgetDenied = false;
      const chain = createChain(active, {
        onProviderFailure: async (provider, error) => {
          if (error instanceof CloudBudgetDeniedError) {
            cloudBudgetDenied = true;
            return;
          }
          if (!provider.requiresNetwork) return;
          await ctx.cache.set(breakerKey(provider.id), 1, BREAKER_TTL_SECONDS).catch(() => {});
          ctx.log.warn(`[search-nlp] provider ${provider.id} failed`, (error as Error).message);
        },
      });
      const parseCtx: ParseContext = { mapCenter, mapBbox, lang };

      const chainId = permitted.map((provider) => provider.cacheKey).join("|");

      let cached = true;
      const key = intentCacheKey(query, mapCenter, roundDecimals, chainId, cloudAllowed);

      try {
        // An answer produced only because the cloud budget was spent is not
        // cached, so the query gets a cloud answer once budget is available.
        const result = await ctx.cache.withCache(
          key,
          intentTtl,
          async () => {
            cached = false;
            return chain.parse(query, parseCtx);
          },
          undefined,
          () => !cloudBudgetDenied,
        );

        // Re-resolved on every request (cached or not) rather than baked into
        // the cached intent, so a catalog update takes effect immediately and
        // this stays a pure, side-effect-free step right before the response.
        // No country is available on this request; suggestBrands ranks
        // globally in that case, which only weakens disambiguation, never
        // correctness (an exact-name match still requires no substitutable
        // ambiguity).
        const resolvedIntent = {
          ...result.intent,
          filter: resolveBrandPredicates(result.intent.filter, undefined),
        };

        const resolvedBbox = await resolveSpatialConstraint(
          resolvedIntent.spatial_constraint,
          mapBbox,
          mapCenter,
          ctx,
          lang,
        );

        reply.send({
          intent: resolvedIntent,
          resolvedBbox,
          provider: result.provider.id,
          providerLabel: result.provider.label,
          cloud: result.provider.cloud,
          cloudAvailable: cloudOffered && disclosure.cloudActive,
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
    },
    { rateLimitTier: "expensive", optionalAuth: true },
  );

  for (const definition of definitions) {
    if (definition.type === "ollama") void ensureOllamaModel(ctx, definition);
  }

  ctx.log.info("[search-nlp] ready");
}
