import { haversineKm } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";

const EONET_BASE = "https://eonet.gsfc.nasa.gov/api/v3/events/geojson";
const GDACS_BASE = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL = 900; // 15 minutes
const DEDUP_DISTANCE_KM = 80;

const EXCLUDED_EONET_CATEGORIES = new Set(["earthquakes", "wildfires"]);

// Map GDACS event types to our category IDs (exclude EQ + WF, covered by other integrations)
const GDACS_TYPE_TO_CATEGORY: Record<string, { id: string; title: string }> = {
  TC: { id: "severeStorms", title: "Tropical Cyclones" },
  FL: { id: "floods", title: "Floods" },
  VO: { id: "volcanoes", title: "Volcanoes" },
  DR: { id: "drought", title: "Drought" },
};

interface NormalizedFeature {
  type: "Feature";
  geometry: {
    type: "Point" | "Polygon";
    coordinates: number[] | number[][];
  };
  properties: Record<string, unknown>;
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: NormalizedFeature[];
}

interface EONETCategory {
  id: string;
  title: string;
}

interface EONETSource {
  id: string;
  url: string;
}

interface GDACSFeature {
  type: "Feature";
  geometry: { type: string; coordinates: number[] | number[][] };
  properties: {
    eventtype: string;
    eventid: number;
    episodeid: number;
    name: string;
    description: string;
    htmldescription: string;
    alertlevel: string;
    alertscore: number;
    episodealertlevel: string;
    episodealertscore: number;
    country: string;
    iso3: string;
    fromdate: string;
    todate: string;
    datemodified: string;
    iscurrent: string;
    severitydata?: { severity: number; severitytext: string; severityunit: string };
    url?: { geometry: string; report: string; details: string };
  };
}

function getPointCoords(f: NormalizedFeature): [number, number] | null {
  if (f.geometry.type === "Point") {
    const c = f.geometry.coordinates as number[];
    return [c[0], c[1]];
  }
  return null;
}

function enrichEONET(features: NormalizedFeature[]): NormalizedFeature[] {
  const now = Date.now();
  return features
    .filter((f) => {
      const cats = f.properties.categories as EONETCategory[] | undefined;
      const catId = cats?.[0]?.id;
      return catId && !EXCLUDED_EONET_CATEGORIES.has(catId);
    })
    .map((f) => {
      const cats = f.properties.categories as EONETCategory[];
      const sources = f.properties.sources as EONETSource[];
      const cat = cats[0];
      const date = f.properties.date as string;
      const magnitudeValue = f.properties.magnitudeValue as number | null;
      const magnitudeUnit = f.properties.magnitudeUnit as string | null;
      const ageMs = now - new Date(date).getTime();
      return {
        ...f,
        properties: {
          ...f.properties,
          categoryId: cat.id,
          categoryTitle: cat.title,
          ageMs,
          magnitudeLabel:
            magnitudeValue != null ? `${magnitudeValue} ${magnitudeUnit ?? ""}`.trim() : null,
          sourceUrl: sources?.[0]?.url ?? null,
          source: "eonet",
          alertLevel: null,
        },
      };
    });
}

function enrichGDACS(features: GDACSFeature[]): NormalizedFeature[] {
  const now = Date.now();
  return features
    .filter((f) => GDACS_TYPE_TO_CATEGORY[f.properties.eventtype])
    .map((f) => {
      const p = f.properties;
      const cat = GDACS_TYPE_TO_CATEGORY[p.eventtype];
      const date = p.fromdate;
      const ageMs = now - new Date(date).getTime();
      const sev = p.severitydata;
      return {
        type: "Feature" as const,
        geometry: f.geometry as NormalizedFeature["geometry"],
        properties: {
          id: `gdacs-${p.eventtype}-${p.eventid}`,
          title: p.name || `${cat.title} — ${p.country}`,
          description: p.description || null,
          link: p.url?.report || null,
          closed: p.iscurrent === "true" ? null : p.todate,
          date,
          magnitudeValue: sev?.severity ?? null,
          magnitudeUnit: sev?.severityunit ?? null,
          categories: [cat],
          sources: [],
          categoryId: cat.id,
          categoryTitle: cat.title,
          ageMs,
          magnitudeLabel: sev ? `${sev.severitytext}` : null,
          sourceUrl: p.url?.report || null,
          source: "gdacs",
          alertLevel: p.alertlevel?.toLowerCase() ?? null,
          alertScore: p.alertscore ?? null,
          country: p.country,
        },
      };
    });
}

function deduplicateFeatures(
  eonetFeatures: NormalizedFeature[],
  gdacsFeatures: NormalizedFeature[],
): NormalizedFeature[] {
  // EONET features take priority; drop GDACS features that are near an EONET feature of the same category
  const kept = [...eonetFeatures];
  for (const gf of gdacsFeatures) {
    const gCoords = getPointCoords(gf);
    const gCat = gf.properties.categoryId as string;
    let isDuplicate = false;
    if (gCoords) {
      for (const ef of eonetFeatures) {
        if ((ef.properties.categoryId as string) !== gCat) continue;
        const eCoords = getPointCoords(ef);
        if (!eCoords) continue;
        const dist = haversineKm(gCoords[1], gCoords[0], eCoords[1], eCoords[0]);
        if (dist < DEDUP_DISTANCE_KM) {
          // Merge alert level onto the EONET feature if GDACS has one
          const alertLevel = gf.properties.alertLevel as string | null;
          if (alertLevel && alertLevel !== "green") {
            ef.properties.alertLevel = alertLevel;
            ef.properties.alertScore = gf.properties.alertScore;
          }
          isDuplicate = true;
          break;
        }
      }
    }
    if (!isDuplicate) {
      kept.push(gf);
    }
  }
  return kept;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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

    const cacheKey = `natural-events:${days ?? "all"}:${status}:${category}`;

    try {
      const cached = await ctx.cache.get<FeatureCollection>(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }

      // Fetch EONET + GDACS in parallel
      const eonetParams = new URLSearchParams({ status });
      if (days != null) eonetParams.set("days", String(days));
      if (category) eonetParams.set("category", category);

      const gdacsFrom = new Date();
      gdacsFrom.setDate(gdacsFrom.getDate() - (days ?? 365));
      const gdacsParams = new URLSearchParams({
        eventlist: Object.keys(GDACS_TYPE_TO_CATEGORY).join(","),
        fromDate: gdacsFrom.toISOString().slice(0, 10),
        toDate: new Date().toISOString().slice(0, 10),
        alertlevel: "Green;Orange;Red",
      });

      const [eonetRes, gdacsRes] = await Promise.allSettled([
        fetchWithTimeout(`${EONET_BASE}?${eonetParams}`, FETCH_TIMEOUT_MS),
        fetchWithTimeout(`${GDACS_BASE}?${gdacsParams}`, FETCH_TIMEOUT_MS),
      ]);

      let eonetFeatures: NormalizedFeature[] = [];
      let gdacsFeatures: NormalizedFeature[] = [];

      if (eonetRes.status === "fulfilled" && eonetRes.value.ok) {
        const raw = (await eonetRes.value.json()) as FeatureCollection;
        eonetFeatures = enrichEONET(raw.features);
      } else {
        ctx.log.warn(
          `EONET API unavailable: ${eonetRes.status === "fulfilled" ? eonetRes.value.status : eonetRes.reason}`,
        );
      }

      if (gdacsRes.status === "fulfilled" && gdacsRes.value.ok) {
        const raw = (await gdacsRes.value.json()) as { features: GDACSFeature[] };
        gdacsFeatures = enrichGDACS(raw.features ?? []);
      } else {
        ctx.log.warn(
          `GDACS API unavailable: ${gdacsRes.status === "fulfilled" ? gdacsRes.value.status : gdacsRes.reason}`,
        );
      }

      if (eonetFeatures.length === 0 && gdacsFeatures.length === 0) {
        const stale = await ctx.cache.get<FeatureCollection>(cacheKey);
        if (stale) {
          reply.send(stale);
          return;
        }
        reply.status(503).send({ message: "Natural event data temporarily unavailable" });
        return;
      }

      const merged: FeatureCollection = {
        type: "FeatureCollection",
        features: deduplicateFeatures(eonetFeatures, gdacsFeatures),
      };

      await ctx.cache.set(cacheKey, merged, CACHE_TTL);
      reply.send(merged);
    } catch (err) {
      ctx.log.error("Failed to fetch natural event data", err);

      const stale = await ctx.cache.get<FeatureCollection>(cacheKey);
      if (stale) {
        reply.send(stale);
        return;
      }

      reply.status(503).send({ message: "Natural event data temporarily unavailable" });
    }
  });
}
