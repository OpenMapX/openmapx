import type { IntegrationContext } from "@openmapx/core";

const EONET_BASE = "https://eonet.gsfc.nasa.gov/api/v3/events/geojson";
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL = 900; // 15 minutes

const EXCLUDED_CATEGORIES = new Set(["earthquakes", "wildfires"]);

interface EONETCategory {
  id: string;
  title: string;
}

interface EONETSource {
  id: string;
  url: string;
}

interface EONETFeature {
  type: "Feature";
  geometry: {
    type: "Point" | "Polygon";
    coordinates: number[] | number[][];
  };
  properties: {
    id: string;
    title: string;
    description: string | null;
    link: string;
    closed: string | null;
    date: string;
    magnitudeValue: number | null;
    magnitudeUnit: string | null;
    categories: EONETCategory[];
    sources: EONETSource[];
  };
}

interface EONETFeatureCollection {
  type: "FeatureCollection";
  features: EONETFeature[];
}

function enrichFeatures(fc: EONETFeatureCollection): EONETFeatureCollection {
  const now = Date.now();
  return {
    ...fc,
    features: fc.features
      .filter((f) => {
        const catId = f.properties.categories?.[0]?.id;
        return catId && !EXCLUDED_CATEGORIES.has(catId);
      })
      .map((f) => {
        const cat = f.properties.categories[0];
        const ageMs = now - new Date(f.properties.date).getTime();
        return {
          ...f,
          properties: {
            ...f.properties,
            categoryId: cat.id,
            categoryTitle: cat.title,
            ageMs,
            magnitudeLabel:
              f.properties.magnitudeValue != null
                ? `${f.properties.magnitudeValue} ${f.properties.magnitudeUnit ?? ""}`.trim()
                : null,
            sourceUrl: f.properties.sources?.[0]?.url ?? null,
          },
        };
      }),
  };
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/events", async (req, reply) => {
    const status = req.query.status ?? "open";
    const category = req.query.category ?? "";
    const days = req.query.days ? Number.parseInt(req.query.days, 10) : undefined;

    if (!["open", "closed", "all"].includes(status)) {
      reply.status(400).send({ message: "Invalid status parameter." });
      return;
    }
    if (days != null && (Number.isNaN(days) || days < 1 || days > 365)) {
      reply.status(400).send({ message: "Invalid days parameter (1-365)." });
      return;
    }

    const cacheKey = `eonet:${days ?? "all"}:${status}:${category}`;

    try {
      const cached = await ctx.cache.get<EONETFeatureCollection>(cacheKey);
      if (cached) {
        reply.send(enrichFeatures(cached));
        return;
      }

      const params = new URLSearchParams({ status });
      if (days != null) {
        params.set("days", String(days));
      }
      if (category) {
        params.set("category", category);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(`${EONET_BASE}?${params}`, {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        ctx.log.warn(`EONET API returned ${res.status}`);

        const stale = await ctx.cache.get<EONETFeatureCollection>(cacheKey);
        if (stale) {
          reply.send(enrichFeatures(stale));
          return;
        }

        reply.status(503).send({ message: "Natural event data temporarily unavailable" });
        return;
      }

      const raw = (await res.json()) as EONETFeatureCollection;
      await ctx.cache.set(cacheKey, raw, CACHE_TTL);

      reply.send(enrichFeatures(raw));
    } catch (err) {
      ctx.log.error("Failed to fetch EONET data", err);

      const stale = await ctx.cache.get<EONETFeatureCollection>(cacheKey);
      if (stale) {
        reply.send(enrichFeatures(stale));
        return;
      }

      reply.status(503).send({ message: "Natural event data temporarily unavailable" });
    }
  });
}
