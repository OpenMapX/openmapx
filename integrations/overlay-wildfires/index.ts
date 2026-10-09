import type { BBox, DataSourcePartialReason } from "@openmapx/core";
import {
  createHazardsOrchestrator,
  type IntegrationContext,
  type RouteHandler,
  scalarQueries,
} from "@openmapx/integration-framework";
import type { FirePixel, NaturalHazard } from "@openmapx/mobility-core/hazards";
import {
  densityCellDeg,
  HOTSPOT_POINTS_MIN_ZOOM,
  normalizeViewport,
  perimeterSimplifyDeg,
} from "./bounds.js";
import {
  FIRMS_FETCHED_AT_HEADER,
  FIRMS_SOURCES_HEADER,
  FIRMS_STALE_HEADER,
  FIRMS_TRUNCATED_HEADER,
} from "./firms-response.js";
import type {
  EffisProperties,
  FireDensityCollection,
  FireFeature,
  FireFeatureCollection,
  FirmsDayRange,
  FirmsInstrument,
  NifcProperties,
  NoaaSmokeProperties,
  NormalizedViewport,
  WildfireFeatureCollection,
  WildfireProvider,
} from "./types.js";

const WORLD: BBox = [-180, -90, 180, 90];
const DAY_MS = 86_400_000;
const ACRES_TO_HECTARES = 0.40468564224;
const DAY_RANGES: readonly FirmsDayRange[] = [1, 2, 3];
const INSTRUMENTS: readonly FirmsInstrument[] = ["viirs", "modis"];
/** The most detections one view loads; the response says when there were more. */
const HOTSPOT_LIMIT = 20_000;
/**
 * A density read of more cells than this is refused: the view is too large for its zoom. A
 * full screen holds far fewer; the margin covers large displays.
 */
const MAX_DENSITY_CELLS = 200_000;
const HOTSPOT_TTL_S = 300;
const LAYER_TTL_S: Record<WildfireProvider, number> = {
  nifc: 300,
  effis: 1_800,
  "noaa-hms": 600,
};
const UNAVAILABLE_CODE: Record<WildfireProvider, string> = {
  nifc: "nifc_unavailable",
  effis: "effis_unavailable",
  "noaa-hms": "noaa_hms_unavailable",
};

type RouteReply = Parameters<RouteHandler>[1];

function cacheControl(ttlSeconds: number): string {
  return `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}`;
}

function badRequest(reply: RouteReply, message: string) {
  reply.header("Cache-Control", "no-store");
  return reply.status(400).send({ message });
}

/** A UTC instant in the canonical form the web validators accept; undefined when unreadable. */
function canonicalInstant(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function sortedSources(items: readonly { sources: readonly string[] }[]): string[] {
  const ids = new Set<string>();
  for (const item of items) for (const id of item.sources) ids.add(id);
  return [...ids].sort();
}

function bboxOf(view: NormalizedViewport): BBox {
  return [view.west, view.south, view.east, view.north];
}

function viewKey(view: NormalizedViewport): string {
  return `${view.west}:${view.south}:${view.east}:${view.north}`;
}

/** Cells a box touches, counting a box across the antimeridian as its two halves. */
function cellCount(view: NormalizedViewport, cellDeg: number): number {
  const span = (lo: number, hi: number) => Math.floor(hi / cellDeg) - Math.floor(lo / cellDeg) + 1;
  const columns =
    view.west <= view.east
      ? span(view.west, view.east)
      : span(view.west, 180) + span(-180, view.east);
  return columns * span(view.south, view.north);
}

/** The confidence in the instrument's own terms: VIIRS's rating, MODIS's percentage. */
function confidenceLabel(pixel: FirePixel): string | null {
  if (pixel.instrument === "viirs") return pixel.confidence?.level ?? null;
  const percent = pixel.confidence?.percent;
  return percent !== undefined && Number.isInteger(percent) && percent >= 0 && percent <= 100
    ? String(percent)
    : null;
}

/** A hotspot feature before its age is known: the age is taken when it is served. */
type AgelessFireFeature = Omit<FireFeature, "properties"> & {
  properties: Omit<FireFeature["properties"], "ageMs">;
};

/** The detection as a hotspot feature; null when its time is unreadable. */
function pixelToFeature(pixel: FirePixel): AgelessFireFeature | null {
  const observed = canonicalInstant(pixel.observedAt);
  if (observed === undefined) return null;
  const [longitude, latitude] = pixel.point;
  return {
    type: "Feature",
    id: pixel.id,
    geometry: { type: "Point", coordinates: [longitude, latitude] },
    properties: {
      latitude,
      longitude,
      brightness: pixel.brightnessK ?? null,
      frp: pixel.frpMW,
      confidence: confidenceLabel(pixel),
      satellite: pixel.satellite ?? null,
      acqDate: observed.slice(0, 10),
      acqTime: `${observed.slice(11, 13)}${observed.slice(14, 16)}`,
      dayNight: pixel.dayNight === "day" ? "D" : pixel.dayNight === "night" ? "N" : null,
      instrument: pixel.instrument,
    },
  };
}

interface HotspotRead {
  features: AgelessFireFeature[];
  sources: string[];
  fetchedAt: string;
  partial?: DataSourcePartialReason;
}

/** The acquisition instant of a hotspot, in epoch milliseconds. */
function acquiredAt({ acqDate, acqTime }: AgelessFireFeature["properties"]): number {
  return Date.parse(`${acqDate}T${acqTime.slice(0, 2)}:${acqTime.slice(2)}:00Z`);
}

function withAge(read: HotspotRead): FireFeatureCollection {
  const now = Date.now();
  return {
    type: "FeatureCollection",
    features: read.features.map((feature) => ({
      ...feature,
      properties: { ...feature.properties, ageMs: now - acquiredAt(feature.properties) },
    })),
  };
}

function nifcFeature(hazard: NaturalHazard): GeoJSON.Feature | null {
  if (hazard.geometry.type !== "Polygon" && hazard.geometry.type !== "MultiPolygon") return null;
  const id = `nifc:${hazard.id}`;
  const properties: NifcProperties = {
    id,
    kind: "reported-perimeter",
    provider: hazard.sources[0] ?? "",
    name: hazard.name ?? hazard.headline ?? "",
  };
  if (hazard.areaHa !== undefined) properties.areaAcres = hazard.areaHa / ACRES_TO_HECTARES;
  const observedAt = canonicalInstant(hazard.perimeterAt);
  if (observedAt) properties.observedAt = observedAt;
  const updatedAt = canonicalInstant(hazard.updatedAt);
  if (updatedAt) properties.updatedAt = updatedAt;
  const discoveredAt = canonicalInstant(hazard.discoveredAt);
  if (discoveredAt) properties.discoveredAt = discoveredAt;
  if (hazard.containmentPct !== undefined) properties.containmentPercent = hazard.containmentPct;
  if (hazard.region) properties.region = hazard.region;
  if (hazard.ignitionCause) properties.cause = hazard.ignitionCause;
  return { type: "Feature", id, geometry: hazard.geometry, properties: { ...properties } };
}

function effisFeature(hazard: NaturalHazard): GeoJSON.Feature | null {
  if (hazard.geometry.type !== "Polygon" && hazard.geometry.type !== "MultiPolygon") return null;
  const id = `effis:${hazard.id}`;
  const properties: EffisProperties = {
    id,
    kind: "satellite-burned-area",
    provider: hazard.sources[0] ?? "",
  };
  const detectedAt = canonicalInstant(hazard.start);
  if (detectedAt) properties.detectedAt = detectedAt;
  const updatedAt = canonicalInstant(hazard.updatedAt);
  if (updatedAt) properties.updatedAt = updatedAt;
  if (hazard.country) properties.countryCode = hazard.country;
  if (hazard.region) properties.region = hazard.region;
  if (hazard.locality) properties.locality = hazard.locality;
  if (hazard.areaHa !== undefined) properties.areaHectares = hazard.areaHa;
  return { type: "Feature", id, geometry: hazard.geometry, properties: { ...properties } };
}

function smokeFeature(hazard: NaturalHazard): GeoJSON.Feature | null {
  if (hazard.geometry.type !== "Polygon" && hazard.geometry.type !== "MultiPolygon") return null;
  if (!hazard.density) return null;
  const id = `noaa-hms:${hazard.id}`;
  const properties: NoaaSmokeProperties = {
    id,
    kind: "observed-smoke",
    provider: hazard.sources[0] ?? "",
    density: hazard.density,
  };
  if (hazard.detection?.satellite) properties.satellite = hazard.detection.satellite;
  const startedAt = canonicalInstant(hazard.detection?.start ?? hazard.start);
  if (startedAt) properties.startedAt = startedAt;
  const endedAt = canonicalInstant(hazard.detection?.end);
  if (endedAt) properties.endedAt = endedAt;
  return { type: "Feature", id, geometry: hazard.geometry, properties: { ...properties } };
}

interface LayerRoute {
  layer: WildfireProvider;
  /** Whether the route reads the requested view; otherwise it reads the world. */
  viewport: boolean;
  subtypes?: string[];
  types: NaturalHazard["type"][];
  toFeature(hazard: NaturalHazard): GeoJSON.Feature | null;
}

const NIFC_ROUTE: LayerRoute = {
  layer: "nifc",
  viewport: true,
  types: ["wildfire"],
  subtypes: ["wildfire_perimeter"],
  toFeature: nifcFeature,
};

const EFFIS_ROUTE: LayerRoute = {
  layer: "effis",
  viewport: true,
  types: ["wildfire"],
  subtypes: ["burned_area"],
  toFeature: effisFeature,
};

const SMOKE_ROUTE: LayerRoute = {
  layer: "noaa-hms",
  viewport: false,
  types: ["smoke"],
  toFeature: smokeFeature,
};

function parseFireQuery(
  query: Record<string, string>,
): { dayRange: FirmsDayRange; instrument: FirmsInstrument } | string {
  const dayRange = Number(query.dayRange ?? "1") as FirmsDayRange;
  const instrument = (query.instrument ?? "viirs") as FirmsInstrument;
  if (!DAY_RANGES.includes(dayRange)) return "Invalid dayRange (1-3)";
  if (!INSTRUMENTS.includes(instrument)) return "Invalid instrument";
  return { dayRange, instrument };
}

export function setup(ctx: IntegrationContext): void {
  const hazards = createHazardsOrchestrator(ctx);

  /** The fire query and the bounded view of a request, or the reason it is refused. */
  function fireRequest(rawQuery: Parameters<typeof scalarQueries>[0]) {
    const query = scalarQueries(rawQuery);
    const fire = parseFireQuery(query);
    if (typeof fire === "string") return fire;
    let view: NormalizedViewport;
    try {
      view = normalizeViewport(query);
    } catch {
      return "Invalid viewport";
    }
    // A rolling window: "one day" is the last 24 hours, whatever the time of day.
    const since = () => new Date(Date.now() - fire.dayRange * DAY_MS).toISOString();
    return { ...fire, view, since };
  }

  ctx.registerRoute("GET", "/wildfires", async (req, reply) => {
    const request = fireRequest(req.query);
    if (typeof request === "string") return badRequest(reply, request);
    const { dayRange, instrument, view, since } = request;
    if (view.zoom < HOTSPOT_POINTS_MIN_ZOOM) {
      return badRequest(
        reply,
        `Hotspots load from zoom ${HOTSPOT_POINTS_MIN_ZOOM}; use /wildfires/density below it`,
      );
    }

    // The view is quantized, so nearby views share an entry. Namespaced by the response
    // shape: an entry cached in an older shape must not be served against the new one.
    const key = `wildfires:hotspots-v2:${instrument}:${dayRange}:${viewKey(view)}`;
    try {
      const read = await ctx.cache.withCache<HotspotRead>(key, HOTSPOT_TTL_S, async () => {
        const { pixels, partial } = await hazards.firePixels(bboxOf(view), {
          since: since(),
          instrument,
          limit: HOTSPOT_LIMIT,
        });
        // Nothing back from a failed read is not "no fires": caching it would hide them.
        if (partial === "unavailable" && pixels.length === 0) {
          throw new Error("every hazards provider failed");
        }
        // The credits name the sources of the detections served, not of those left out.
        const served = pixels.flatMap((pixel) => {
          const feature = pixel.instrument === instrument ? pixelToFeature(pixel) : null;
          return feature ? [{ feature, sources: pixel.sources }] : [];
        });
        return {
          features: served.map((s) => s.feature),
          sources: sortedSources(served),
          fetchedAt: new Date().toISOString(),
          ...(partial ? { partial } : {}),
        };
      });
      reply.header("Cache-Control", cacheControl(HOTSPOT_TTL_S));
      reply.header(FIRMS_FETCHED_AT_HEADER, read.fetchedAt);
      reply.header(FIRMS_STALE_HEADER, String(read.partial === "unavailable"));
      reply.header(FIRMS_TRUNCATED_HEADER, String(read.partial === "area"));
      reply.header(FIRMS_SOURCES_HEADER, read.sources.join(","));
      return reply.send(withAge(read));
    } catch (error) {
      ctx.log.error("Failed to read fire detections", error);
      reply.header("Cache-Control", "no-store");
      return reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
    }
  });

  ctx.registerRoute("GET", "/wildfires/density", async (req, reply) => {
    const request = fireRequest(req.query);
    if (typeof request === "string") return badRequest(reply, request);
    const { dayRange, instrument, view, since } = request;
    const cellDeg = densityCellDeg(Math.floor(view.zoom));
    if (cellCount(view, cellDeg) > MAX_DENSITY_CELLS) {
      return badRequest(reply, "Viewport too large for its zoom");
    }

    const key = `wildfires:density-v1:${instrument}:${dayRange}:${cellDeg}:${viewKey(view)}`;
    try {
      const read = await ctx.cache.withCache(key, HOTSPOT_TTL_S, async () => {
        const { cells, sources, partial } = await hazards.fireDensity(bboxOf(view), {
          since: since(),
          instrument,
          cellDeg,
        });
        if (partial === "unavailable" && cells.length === 0) {
          throw new Error("every hazards provider failed");
        }
        const collection: FireDensityCollection = {
          type: "FeatureCollection",
          features: cells.map((cell) => ({
            type: "Feature",
            geometry: { type: "Point", coordinates: cell.point },
            properties: { count: cell.count, frpSum: cell.frpSumMW, frpMax: cell.frpMaxMW },
          })),
          sources: [...sources].sort(),
        };
        return { collection, fetchedAt: new Date().toISOString(), ...(partial ? { partial } : {}) };
      });
      reply.header("Cache-Control", cacheControl(HOTSPOT_TTL_S));
      reply.header(FIRMS_FETCHED_AT_HEADER, read.fetchedAt);
      reply.header(FIRMS_STALE_HEADER, String(read.partial === "unavailable"));
      reply.header(FIRMS_TRUNCATED_HEADER, String(read.partial === "area"));
      return reply.send(read.collection);
    } catch (error) {
      ctx.log.error("Failed to read fire density", error);
      reply.header("Cache-Control", "no-store");
      return reply.status(503).send({ message: "Wildfire data temporarily unavailable" });
    }
  });

  ctx.registerRoute("GET", "/perimeters/nifc", layerHandler(NIFC_ROUTE));
  ctx.registerRoute("GET", "/burned-areas/effis", layerHandler(EFFIS_ROUTE));
  ctx.registerRoute("GET", "/smoke/noaa", layerHandler(SMOKE_ROUTE));

  function layerHandler(route: LayerRoute): RouteHandler {
    return async (req, reply) => {
      let bbox = WORLD;
      let simplifyDeg: number | undefined;
      let key = `wildfires:${route.layer}-v2:world`;
      if (route.viewport) {
        let view: NormalizedViewport;
        try {
          view = normalizeViewport(scalarQueries(req.query));
        } catch {
          return badRequest(reply, "Invalid viewport");
        }
        bbox = bboxOf(view);
        // Keyed on the tolerance, one of four values, rather than on the client's zoom.
        simplifyDeg = perimeterSimplifyDeg(view.zoom);
        key = `wildfires:${route.layer}-v3:${simplifyDeg}:${viewKey(view)}`;
      }

      const ttl = LAYER_TTL_S[route.layer];
      try {
        const collection = await ctx.cache.withCache<WildfireFeatureCollection>(
          key,
          ttl,
          async () => {
            const { hazards: found, partial } = await hazards.naturalHazards(bbox, {
              types: route.types,
              ...(route.subtypes ? { subtypes: route.subtypes } : {}),
              ...(simplifyDeg === undefined ? {} : { simplifyDeg }),
            });
            if (partial === "unavailable" && found.length === 0) {
              throw new Error("every hazards provider failed");
            }
            const kept = found.flatMap((hazard) => {
              const feature = route.toFeature(hazard);
              return feature ? [{ feature, sources: hazard.sources }] : [];
            });
            return {
              type: "FeatureCollection",
              features: kept.map((k) => k.feature),
              source: route.layer,
              truncated: partial === "area",
              stale: partial === "unavailable",
              fetchedAt: new Date().toISOString(),
              sources: sortedSources(kept),
            };
          },
        );
        reply.header("Cache-Control", cacheControl(ttl));
        return reply.send(collection);
      } catch (error) {
        ctx.log.warn("Wildfire layer unavailable", { layer: route.layer, error });
        reply.header("Cache-Control", "no-store");
        return reply.status(503).send({ code: UNAVAILABLE_CODE[route.layer] });
      }
    };
  }
}
