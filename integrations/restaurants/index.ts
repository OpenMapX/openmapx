import type { IntegrationContext } from "@openmapx/integration-framework";
import { normalizeWebsite, resolveRestaurantLinks } from "./menu.js";

const POSITIVE_TTL = 7 * 24 * 60 * 60; // 7 days — menus rarely move
const NEGATIVE_TTL = 24 * 60 * 60; // 1 day — give new menus a chance to appear

interface CachedMenu {
  found: boolean;
  menuUrl?: string;
  source?: string;
  format?: string;
  orderUrl?: string;
  providerOrderUrls?: string[];
}

/**
 * Restaurant integration. Resolves a link to a restaurant's menu from its own
 * website (schema.org `hasMenu` → menu-link heuristics) so the place panel can
 * show a "Menu" row. OSM `website:menu` tags are handled client-side and never
 * reach this route. We link to menus — we never rehost menu content.
 *
 * Routes (under `/api/integrations/restaurants`):
 *   GET /menu?website=<url>  → { menuUrl, source, format } or 204 if none found
 */
export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/menu", async (req, reply) => {
    const websiteRaw = (req.query.website ?? "").trim();
    const normalized = normalizeWebsite(websiteRaw);
    if (!normalized) {
      reply.status(400).send({ error: "'website' must be a valid URL" });
      return;
    }

    // Key on origin+path so two POIs sharing a site reuse one crawl.
    const cacheKey = `menu:${normalized}`;
    const cached = await ctx.cache.get<CachedMenu>(cacheKey);
    let result: CachedMenu;
    if (cached) {
      result = cached;
    } else {
      const resolved = await resolveRestaurantLinks(normalized, ctx.log);
      result =
        resolved.menu || resolved.orderUrl || resolved.providerOrderUrls.length > 0
          ? {
              found: true,
              menuUrl: resolved.menu?.menuUrl,
              source: resolved.menu?.source,
              format: resolved.menu?.format,
              orderUrl: resolved.orderUrl ?? undefined,
              providerOrderUrls: resolved.providerOrderUrls,
            }
          : { found: false };
      await ctx.cache.set(cacheKey, result, result.found ? POSITIVE_TTL : NEGATIVE_TTL);
    }

    if (!result.found) {
      reply.header("Cache-Control", "public, max-age=3600");
      reply.status(204).send({});
      return;
    }
    reply.header("Cache-Control", "public, max-age=86400");
    reply.send({
      menuUrl: result.menuUrl,
      source: result.source,
      format: result.format,
      orderUrl: result.orderUrl,
      providerOrderUrls: result.providerOrderUrls,
    });
  });
}
