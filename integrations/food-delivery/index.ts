import {
  bareDomain,
  type DeliveryLinkKind,
  type DeliveryProviderInfo,
} from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { DELIVERY_PROVIDERS, getDeliveryProvider, providerServes } from "./providers/index.js";
import { parseDeliveryQuery } from "./query.js";
import type { DeliveryProvider, DeliveryProviderConfig, DeliveryQuery } from "./types.js";

/** Resolved store URLs are stable; cache long to avoid re-querying the platform. */
const RESOLVE_TTL = 7 * 24 * 60 * 60;
/**
 * Cache "not on this platform" too, but for a shorter window so a restaurant
 * that later appears still gets picked up — and so a single miss doesn't re-run
 * the (slow) platform resolve on every subsequent hand-off.
 */
const RESOLVE_NEGATIVE_TTL = 24 * 60 * 60;

type CachedResolution =
  | { version: 2; kind: "exact"; url: string }
  | { version: 2; kind: "not_found" };

/**
 * Food-delivery integration. Exposes deep-link builders for external delivery
 * platforms so a restaurant's place panel can hand the user off to the
 * platform's search pre-filled with the restaurant name. No live menu/price/ETA
 * data is fetched.
 *
 * Routes (under `/api/integrations/food-delivery`):
 *   GET /providers?country=de  → providers serving that country (or all)
 *   GET /:provider/open        → 302 redirect to the pre-filled platform search
 *   GET /:provider/url         → { url } (same link as JSON, for previews/tests)
 */
export function setup(ctx: IntegrationContext): void {
  const providerConfig: DeliveryProviderConfig = {
    affiliateTemplates:
      ctx.config.affiliateTemplates && typeof ctx.config.affiliateTemplates === "object"
        ? (ctx.config.affiliateTemplates as Record<string, string>)
        : undefined,
    uberEatsScid: typeof ctx.config.uberEatsScid === "string" ? ctx.config.uberEatsScid : undefined,
  };

  ctx.registerRoute("GET", "/providers", async (req, reply) => {
    const country = (req.query.country ?? "").trim().toLowerCase() || undefined;
    const providers: DeliveryProviderInfo[] = DELIVERY_PROVIDERS.filter((p) =>
      providerServes(p, country),
    ).map((p) => providerInfo(p, p.fallbackKind));
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send({ providers });
  });

  /**
   * Fingerprint of the config that affects a resolved URL (Impact click id +
   * this provider's affiliate template). Part of the resolve cache key so
   * rotating either invalidates cached links instead of serving the old, fully
   * wrapped URL for {@link RESOLVE_TTL}.
   */
  function resolveConfigTag(provider: DeliveryProvider): string {
    const scid = providerConfig.uberEatsScid?.trim() ?? "";
    const tmpl = providerConfig.affiliateTemplates?.[provider.id]?.trim() ?? "";
    return `${scid}|${tmpl}`;
  }

  /**
   * Resolve the destination URL: try the provider's async `resolve` first (a
   * precise restaurant page, cached — including cached negatives), falling back
   * to the synchronous `build` deep link. Resolution failures never break the
   * hand-off.
   */
  function providerInfo(
    provider: DeliveryProvider,
    linkKind: DeliveryLinkKind,
    url?: string,
  ): DeliveryProviderInfo {
    return {
      id: provider.id,
      name: provider.name,
      domain: bareDomain(provider.homepage),
      homepage: provider.homepage,
      color: provider.color,
      linkKind,
      ...(url ? { url } : {}),
    };
  }

  async function resolveUrl(
    provider: DeliveryProvider,
    query: DeliveryQuery,
  ): Promise<{ url: string; linkKind: DeliveryLinkKind; degraded?: boolean }> {
    const fallback = () => provider.build(query, providerConfig);
    if (provider.resolve && typeof query.lat === "number" && typeof query.lng === "number") {
      const cacheKey = `resolve:v2:${provider.id}:${query.countryCode ?? ""}:${query.lat.toFixed(5)}:${query.lng.toFixed(5)}:${resolveConfigTag(provider)}:${query.name.toLowerCase()}`;
      try {
        const cached = await ctx.cache.get<CachedResolution>(cacheKey);
        if (cached?.version === 2 && cached.kind === "exact") {
          return { url: cached.url, linkKind: "exact" };
        }
        if (cached?.version === 2 && cached.kind === "not_found") {
          return { url: fallback(), linkKind: provider.fallbackKind };
        }
        const resolved = await provider.resolve(query, providerConfig);
        if (resolved.kind === "exact") {
          await ctx.cache.set(
            cacheKey,
            { version: 2, kind: "exact", url: resolved.url } satisfies CachedResolution,
            RESOLVE_TTL,
          );
          return { url: resolved.url, linkKind: "exact" };
        }
        await ctx.cache.set(
          cacheKey,
          { version: 2, kind: "not_found" } satisfies CachedResolution,
          RESOLVE_NEGATIVE_TTL,
        );
      } catch (err) {
        ctx.log.debug?.(`[food-delivery] ${provider.id} resolve failed: ${(err as Error).message}`);
        return { url: fallback(), linkKind: provider.fallbackKind, degraded: true };
      }
    }
    return { url: fallback(), linkKind: provider.fallbackKind };
  }

  ctx.registerRoute("GET", "/resolve", async (req, reply) => {
    const parsed = parseDeliveryQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    const handoffs = await Promise.all(
      DELIVERY_PROVIDERS.filter((provider) =>
        providerServes(provider, parsed.query.countryCode),
      ).map(async (provider) => {
        const handoff = await resolveUrl(provider, parsed.query);
        return {
          provider: providerInfo(
            provider,
            handoff.linkKind,
            handoff.linkKind === "exact" ? handoff.url : undefined,
          ),
          degraded: handoff.degraded === true,
        };
      }),
    );
    const degraded = handoffs.some((handoff) => handoff.degraded);
    reply.header(
      "Cache-Control",
      degraded ? "private, no-store, max-age=0" : "private, max-age=3600",
    );
    reply.send({ providers: handoffs.map((handoff) => handoff.provider), degraded });
  });

  ctx.registerRoute("GET", "/:provider/open", async (req, reply) => {
    const provider = getDeliveryProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown delivery provider" });
      return;
    }
    const parsed = parseDeliveryQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    const handoff = await resolveUrl(provider, parsed.query);
    reply.header("Location", handoff.url);
    reply.status(302).send({});
  });

  ctx.registerRoute("GET", "/:provider/url", async (req, reply) => {
    const provider = getDeliveryProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown delivery provider" });
      return;
    }
    const parsed = parseDeliveryQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    const handoff = await resolveUrl(provider, parsed.query);
    reply.send({ provider: provider.id, ...handoff });
  });
}
