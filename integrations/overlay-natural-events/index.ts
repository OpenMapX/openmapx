import type { BBox } from "@openmapx/core";
import {
  createHazardsOrchestrator,
  type IntegrationContext,
  scalarQueries,
} from "@openmapx/integration-framework";
import type { NaturalHazard, NaturalHazardType } from "@openmapx/mobility-core/hazards";

const WORLD: BBox = [-180, -90, 180, 90];
const CACHE_TTL_S = 900;
const DAY_MS = 86_400_000;
/** How far back a closed or full read goes when no day limit is asked for. */
const DEFAULT_DAYS = 365;
/** The day limits the legend offers; any other would only multiply cache entries. */
const DAY_LIMITS = new Set([30, 90, 365]);
/**
 * Hazards are drawn at one point each, so their shapes are read coarsely: a
 * flood's or a drought's polygon need not travel whole for its mean to barely move.
 */
const SIMPLIFY_DEG = 0.05;
const STATUSES = ["open", "closed", "all"] as const;
type Status = (typeof STATUSES)[number];

/** The layer's categories, in legend order, with the hazard type each one shows. */
const CATEGORIES = [
  { id: "volcanoes", title: "Volcanoes", type: "volcano" },
  { id: "severeStorms", title: "Tropical Cyclones", type: "tropical_cyclone" },
  { id: "floods", title: "Floods", type: "flood" },
  { id: "landslides", title: "Landslides", type: "landslide" },
  { id: "seaLakeIce", title: "Sea and Lake Ice", type: "sea_ice" },
  { id: "drought", title: "Drought", type: "drought" },
  { id: "dustHaze", title: "Dust and Haze", type: "dust_storm" },
] as const satisfies readonly { id: string; title: string; type: NaturalHazardType }[];

type Category = (typeof CATEGORIES)[number];

const ALERT_LEVELS = new Set(["green", "orange", "red"]);

export interface NaturalEventFeature {
  type: "Feature";
  id: string;
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    title: string;
    categoryId: string;
    categoryTitle: string;
    /** ISO 8601 instants. */
    date: string | null;
    /** The hazard's last update, else its start: what a day limit on open hazards reads. */
    updated: string | null;
    closed: string | null;
    magnitudeLabel: string | null;
    alertLevel: "green" | "orange" | "red" | null;
    link: string | null;
    sourceUrl: string | null;
    /** The feed id of the hazard's first source. */
    source: string;
    sources: string[];
  };
}

export interface NaturalEventFeatureCollection {
  type: "FeatureCollection";
  features: NaturalEventFeature[];
  /** The feed ids behind the features, for the map credits. */
  sources: string[];
}

function magnitudeLabel(hazard: NaturalHazard): string | null {
  if (hazard.maxWindKmh !== undefined) return `${Math.round(hazard.maxWindKmh)} km/h`;
  if (hazard.areaHa !== undefined) return `${Math.round(hazard.areaHa)} ha`;
  return null;
}

function alertLevel(hazard: NaturalHazard): NaturalEventFeature["properties"]["alertLevel"] {
  const declared = hazard.severity?.declared?.toLowerCase();
  return declared && ALERT_LEVELS.has(declared) ? (declared as "green" | "orange" | "red") : null;
}

/**
 * The hazard as one map point in its category, or null when no category shows
 * its type. Polygon hazards are drawn at their representative point.
 */
export function hazardToFeature(hazard: NaturalHazard): NaturalEventFeature | null {
  const category = CATEGORIES.find((c) => c.type === hazard.type);
  if (!category) return null;
  return {
    type: "Feature",
    id: hazard.id,
    geometry: { type: "Point", coordinates: hazard.point },
    properties: {
      id: hazard.id,
      title: hazard.name ?? hazard.headline ?? category.title,
      categoryId: category.id,
      categoryTitle: category.title,
      date: hazard.start ?? null,
      updated: hazard.updatedAt ?? hazard.start ?? null,
      closed: hazard.ended ? (hazard.end ?? null) : null,
      magnitudeLabel: magnitudeLabel(hazard),
      alertLevel: alertLevel(hazard),
      link: hazard.detailUrl ?? null,
      sourceUrl: hazard.detailUrl ?? null,
      source: hazard.sources[0] ?? "",
      sources: hazard.sources,
    },
  };
}

/** Features and the sources behind exactly them, for the map credits. */
function collection(features: NaturalEventFeature[]): NaturalEventFeatureCollection {
  const sources = new Set(features.flatMap((f) => f.properties.sources));
  return { type: "FeatureCollection", features, sources: [...sources].sort() };
}

function toFeatureCollection(hazards: readonly NaturalHazard[]): NaturalEventFeatureCollection {
  return collection(hazards.flatMap((h) => hazardToFeature(h) ?? []));
}

/** The features of the requested categories, and with `since` those updated on or after it. */
function select(
  fc: NaturalEventFeatureCollection,
  categories: readonly Category[],
  since: number | undefined,
): NaturalEventFeatureCollection {
  const ids = new Set<string>(categories.map((c) => c.id));
  return collection(
    fc.features.filter(
      (f) =>
        ids.has(f.properties.categoryId) &&
        (since === undefined ||
          (f.properties.updated !== null && Date.parse(f.properties.updated) >= since)),
    ),
  );
}

/** The requested categories in legend order; null when one is unknown. */
function parseCategories(raw: string | undefined): Category[] | null {
  if (!raw) return [...CATEGORIES];
  const ids = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  if ([...ids].some((id) => !CATEGORIES.some((c) => c.id === id))) return null;
  return CATEGORIES.filter((c) => ids.has(c.id));
}

/** The language a text is asked for: one of the app's locales, English otherwise. */
function parseLang(raw: string | undefined): "en" | "de" {
  return raw?.toLowerCase().split("-")[0] === "de" ? "de" : "en";
}

export function setup(ctx: IntegrationContext): void {
  const hazards = createHazardsOrchestrator(ctx);

  ctx.registerRoute("GET", "/events", async (req, reply) => {
    const query = scalarQueries(req.query);
    const status = (query.status ?? "open") as Status;
    const days = query.days === undefined ? undefined : Number(query.days);
    const categories = parseCategories(query.category);
    const lang = parseLang(query.lang);

    if (!STATUSES.includes(status)) {
      return reply.status(400).send({ message: "Invalid status parameter." });
    }
    if (days !== undefined && !DAY_LIMITS.has(days)) {
      return reply.status(400).send({ message: "Invalid days parameter (30, 90 or 365)." });
    }
    if (!categories || categories.length === 0) {
      return reply.status(400).send({ message: "Invalid category parameter." });
    }

    // Open hazards are the current ones, and a day limit keeps those updated within it.
    // Only a closed or full read takes a window, for the hazards that ended within it.
    const windowDays = status === "open" ? undefined : (days ?? DEFAULT_DAYS);
    // One entry per status, window and language: categories and the open day limit are
    // applied to the cached read. Namespaced by the response shape: an entry cached in an
    // older shape must not be served against the new one.
    const key = `natural-events:v3:${status}:${windowDays ?? "current"}:${lang}`;

    try {
      const fc = await ctx.cache.withCache(key, CACHE_TTL_S, async () => {
        const { hazards: found, partial } = await hazards.naturalHazards(WORLD, {
          types: CATEGORIES.map((c) => c.type),
          ...(windowDays === undefined
            ? {}
            : { since: new Date(Date.now() - windowDays * DAY_MS).toISOString() }),
          simplifyDeg: SIMPLIFY_DEG,
          lang,
        });
        // Nothing back from a failed read is not "no events": caching it would hide them.
        if (partial === "unavailable" && found.length === 0) {
          throw new Error("every hazards provider failed");
        }
        const kept =
          status === "open"
            ? found.filter((h) => !h.ended)
            : status === "closed"
              ? found.filter((h) => h.ended)
              : found;
        return toFeatureCollection(kept);
      });
      const since =
        status === "open" && days !== undefined ? Date.now() - days * DAY_MS : undefined;
      reply.header("Cache-Control", `public, max-age=${CACHE_TTL_S}`);
      return reply.send(select(fc, categories, since));
    } catch (err) {
      ctx.log.error("Failed to read natural events", err);
      reply.header("Cache-Control", "no-store");
      return reply.status(503).send({ message: "Natural event data temporarily unavailable" });
    }
  });
}
