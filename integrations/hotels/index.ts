// integrations/hotels/index.ts
import { bareDomain, type HotelProviderInfo } from "@openmapx/core/server";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { fetchOfficialBookingUrl } from "./official.js";
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

  /** Booking-engine link is stable; cache the resolved (dated) URL a day. */
  const OFFICIAL_TTL = 24 * 60 * 60;

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

  ctx.registerRoute("GET", "/official", async (req, reply) => {
    const website = (req.query.website ?? "").trim();
    if (!website) {
      reply.status(204).send({});
      return;
    }
    const parsed = parseHotelQuery(req.query); // requires name; client always has it
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    const q = parsed.query;
    const key = `hotels:official:${website}:${q.checkIn ?? ""}:${q.checkOut ?? ""}:${q.adults ?? 2}:${q.rooms ?? 1}`;
    try {
      const url = await ctx.cache.withCache(key, OFFICIAL_TTL, () =>
        fetchOfficialBookingUrl(
          website,
          { checkIn: q.checkIn, checkOut: q.checkOut, adults: q.adults, rooms: q.rooms },
          ctx.log,
        ),
      );
      if (!url) {
        reply.status(204).send({});
        return;
      }
      reply.header("Cache-Control", "public, max-age=86400");
      reply.send({ url });
    } catch {
      reply.status(204).send({});
    }
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
