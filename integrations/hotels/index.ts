// integrations/hotels/index.ts
import { bareDomain, type HotelProviderInfo } from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { getHotelProvider, HOTEL_PROVIDERS, providerServes } from "./providers.js";
import { parseHotelQuery } from "./query.js";
import type { HotelProviderConfig } from "./types.js";

/**
 * Hotels integration. Tier 1 exposes deep-link builders for external hotel OTAs
 * so a lodging place panel can hand the user off to the OTA's search pre-filled
 * with the hotel name, dates, and occupancy. No live data is fetched in Tier 1.
 * (Tier 2 adds GET /offers for a live lowest rate via LiteAPI.) See
 * docs/plans/hotel-prices-and-booking.md.
 *
 * Routes (under `/api/integrations/hotels`):
 *   GET /providers?country=de  → OTAs serving that country (or all)
 *   GET /:provider/open        → 302 redirect to the pre-filled OTA search
 *   GET /:provider/url         → { url } (same link as JSON, for previews/tests)
 */
export function setup(ctx: IntegrationContext): void {
  const providerConfig: HotelProviderConfig = {
    affiliateTemplates:
      ctx.config.affiliateTemplates && typeof ctx.config.affiliateTemplates === "object"
        ? (ctx.config.affiliateTemplates as Record<string, string>)
        : undefined,
    bookingAid: typeof ctx.config.bookingAid === "string" ? ctx.config.bookingAid : undefined,
  };

  ctx.registerRoute("GET", "/providers", async (req, reply) => {
    const country = (req.query.country ?? "").trim().toLowerCase() || undefined;
    const providers: HotelProviderInfo[] = HOTEL_PROVIDERS.filter((p) =>
      providerServes(p, country),
    ).map((p) => ({
      id: p.id,
      name: p.name,
      domain: bareDomain(p.homepage),
      homepage: p.homepage,
      color: p.color,
    }));
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send({ providers });
  });

  ctx.registerRoute("GET", "/:provider/open", async (req, reply) => {
    const provider = getHotelProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown hotel provider" });
      return;
    }
    const parsed = parseHotelQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    reply.header("Location", provider.build(parsed.query, providerConfig));
    reply.status(302).send({});
  });

  ctx.registerRoute("GET", "/:provider/url", async (req, reply) => {
    const provider = getHotelProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown hotel provider" });
      return;
    }
    const parsed = parseHotelQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    reply.send({ provider: provider.id, url: provider.build(parsed.query, providerConfig) });
  });
}
