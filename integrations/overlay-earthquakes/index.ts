import type { BBox } from "@openmapx/core";
import {
  createHazardsOrchestrator,
  type IntegrationContext,
  scalarQueries,
} from "@openmapx/integration-framework";
import type { NaturalHazard } from "@openmapx/mobility-core/hazards";

const WORLD: BBox = [-180, -90, 180, 90];

const RANGE_MS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 30 * 86_400_000,
};

const CACHE_TTL: Record<string, number> = {
  hour: 60,
  day: 120,
  week: 300,
  month: 600,
};

interface EarthquakeFeature {
  type: "Feature";
  id: string;
  geometry: {
    type: "Point";
    /** `[lon, lat, depth in km]`; the depth is absent when the publisher gave none. */
    coordinates: [number, number, number?];
  };
  properties: {
    mag: number | null;
    place: string | null;
    /** Epoch milliseconds. */
    time: number;
    url: string | null;
    felt: number | null;
    mmi: number | null;
    alert: string | null;
    /** 1 for a large event in an oceanic region (not a warning), else 0. */
    tsunami: number;
    sources: string[];
  };
}

interface EarthquakeFeatureCollection {
  type: "FeatureCollection";
  features: EarthquakeFeature[];
  /** The feed ids behind the features, for the map credits. */
  sources: string[];
}

export function depthCategory(depth: number): string {
  if (depth < 70) return "shallow";
  if (depth < 300) return "intermediate";
  return "deep";
}

export function magLabel(mag: number): string {
  if (mag < 2.0) return "Micro";
  if (mag < 4.0) return "Minor";
  if (mag < 5.0) return "Light";
  if (mag < 6.0) return "Moderate";
  if (mag < 7.0) return "Strong";
  if (mag < 8.0) return "Major";
  return "Great";
}

export function ageCategory(ageMs: number): string {
  if (ageMs < 3_600_000) return "recent";
  if (ageMs < 86_400_000) return "today";
  if (ageMs < 604_800_000) return "this_week";
  return "older";
}

export function enrichFeatures(fc: EarthquakeFeatureCollection): EarthquakeFeatureCollection {
  const now = Date.now();
  return {
    ...fc,
    features: fc.features.map((f) => {
      const depth = f.geometry.coordinates[2] ?? 0;
      const mag = f.properties.mag ?? 0;
      const age = now - f.properties.time;
      return {
        ...f,
        properties: {
          ...f.properties,
          mag,
          depth,
          depthCategory: depthCategory(depth),
          magLabel: magLabel(mag),
          ageMs: age,
          ageCategory: ageCategory(age),
        },
      };
    }),
  };
}

/** The earthquake as one map feature, or null when it carries no usable time. */
export function hazardToFeature(hazard: NaturalHazard): EarthquakeFeature | null {
  const time = Date.parse(hazard.start ?? hazard.updatedAt ?? "");
  if (Number.isNaN(time)) return null;
  const [lon, lat] = hazard.point;
  return {
    type: "Feature",
    id: hazard.id,
    geometry: {
      type: "Point",
      coordinates: hazard.depthM === undefined ? [lon, lat] : [lon, lat, hazard.depthM / 1000],
    },
    properties: {
      mag: hazard.magnitude?.value ?? null,
      place: hazard.name ?? null,
      time,
      url: hazard.detailUrl ?? null,
      felt: hazard.feltReports ?? null,
      mmi: hazard.mmi ?? null,
      alert: hazard.severity?.declared ?? null,
      tsunami: hazard.tsunamiFlag ? 1 : 0,
      sources: hazard.sources,
    },
  };
}

/**
 * The earthquakes of at least `minMagnitude`. A quake without a magnitude is
 * kept only when no minimum is asked for.
 */
export function hazardsToFeatureCollection(
  hazards: readonly NaturalHazard[],
  minMagnitude: number,
): EarthquakeFeatureCollection {
  const features: EarthquakeFeature[] = [];
  for (const hazard of hazards) {
    const feature = hazardToFeature(hazard);
    if (feature) features.push(feature);
  }
  return filterByMagnitude({ type: "FeatureCollection", features, sources: [] }, minMagnitude);
}

/** Keeps the features of at least `minMagnitude`; the sources are those of the kept features. */
function filterByMagnitude(
  fc: EarthquakeFeatureCollection,
  minMagnitude: number,
): EarthquakeFeatureCollection {
  const features = fc.features.filter(({ properties: { mag } }) =>
    mag === null ? minMagnitude <= 0 : mag >= minMagnitude,
  );
  const sources = new Set(features.flatMap((f) => f.properties.sources));
  return { type: "FeatureCollection", features, sources: [...sources].sort() };
}

/** The language a text is asked for: one of the app's locales, English otherwise. */
function parseLang(raw: string | undefined): "en" | "de" {
  return raw?.toLowerCase().split("-")[0] === "de" ? "de" : "en";
}

export function setup(ctx: IntegrationContext): void {
  const hazards = createHazardsOrchestrator(ctx);

  ctx.registerRoute("GET", "/earthquakes", async (req, reply) => {
    const query = scalarQueries(req.query);
    const timeRange = query.timeRange ?? "week";
    const minMagnitude = Number.parseFloat(query.minMagnitude ?? "2.5");
    const lang = parseLang(query.lang);

    if (!Object.hasOwn(RANGE_MS, timeRange)) {
      return reply.status(400).send({ message: "Invalid timeRange" });
    }
    if (!Number.isFinite(minMagnitude) || minMagnitude < 0 || minMagnitude > 10) {
      return reply.status(400).send({ message: "Invalid minMagnitude" });
    }

    const ttl = CACHE_TTL[timeRange] ?? 300;
    // The world's earthquakes of the range are cached once, unfiltered, so the magnitude
    // cannot multiply cache entries. Namespaced by the response shape: an entry cached in an
    // older shape must not be served against the new one.
    const key = `eq:v3:${timeRange}:${lang}`;

    try {
      const fc = await ctx.cache.withCache(key, ttl, async () => {
        const { hazards: found, partial } = await hazards.naturalHazards(WORLD, {
          types: ["earthquake"],
          since: new Date(Date.now() - RANGE_MS[timeRange]).toISOString(),
          lang,
        });
        // Nothing back from a failed read is not "no earthquakes": caching it would hide them.
        if (partial === "unavailable" && found.length === 0) {
          throw new Error("every hazards provider failed");
        }
        return hazardsToFeatureCollection(found, 0);
      });
      reply.header("Cache-Control", `public, max-age=${ttl}`);
      return reply.send(enrichFeatures(filterByMagnitude(fc, minMagnitude)));
    } catch (err) {
      ctx.log.error("Failed to read earthquakes", err);
      reply.header("Cache-Control", "no-store");
      return reply.status(503).send({ message: "Earthquake data temporarily unavailable" });
    }
  });
}
