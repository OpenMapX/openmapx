import { haversineDistance, type LandmarkCandidate } from "@openmapx/core";
import { parseWgs84Point } from "@openmapx/integration-framework";
import { hashKey, round } from "./closure-exclusions.js";

/**
 * `POST /navigation/landmarks` — fuel stations, places of worship, pharmacies,
 * supermarkets and branded fast food near manoeuvre points, for voice prompts
 * such as "At the Aral petrol station, turn left". All uncached points of a
 * request share one Overpass query; each point's answer is cached for a week.
 */

export interface LandmarkPoint {
  lat: number;
  lon: number;
}

export interface LandmarkPointResult {
  candidates: LandmarkCandidate[];
  unavailable?: true;
}

const MAX_POINTS = 40;
const AROUND_RADIUS_METERS = 150;
/**
 * A candidate from the shared answer belongs to a point when its node, centre
 * or an outline vertex lies within this. A little wider than the `around`
 * radius, because Overpass matches a way by any part of its outline.
 */
const POINT_MATCH_METERS = 175;
const MAX_BRAND = 40;
/** Outlines beyond this many vertices are dropped; the centre still counts. */
const MAX_OUTLINE_VERTICES = 200;
const RELIGIONS = new Set(["christian", "muslim", "jewish"]);

export const LANDMARK_CACHE_TTL_SECONDS = 7 * 86_400;

/** Parse the request body; `null` means a 400. */
export function parseLandmarkPoints(body: unknown): LandmarkPoint[] | null {
  if (!body || typeof body !== "object") return null;
  const raw = (body as { points?: unknown }).points;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_POINTS) return null;
  const points: LandmarkPoint[] = [];
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") return null;
    const entry = candidate as { lat?: unknown; lon?: unknown };
    const parsed = parseWgs84Point(entry.lon, entry.lat);
    if (!parsed) return null;
    points.push({ lat: round(parsed[1], 4), lon: round(parsed[0], 4) });
  }
  return points;
}

/** The per-point cache key; points arrive rounded to ~10 m. */
export function landmarkCacheKey(point: LandmarkPoint): string {
  return hashKey("cache:nav:landmarks:v1", [point.lon, point.lat]);
}

/**
 * One query for all points. Nodes come with their position, ways with their
 * outline (the distance rule measures to the nearest edge of a building), and
 * relations with their centre only, since member geometry can be large.
 */
export function buildLandmarksQuery(points: LandmarkPoint[]): string {
  const filters = [
    '["amenity"~"^(fuel|place_of_worship|pharmacy|fast_food)$"]',
    '["shop"="supermarket"]',
  ];
  const statements = points
    .flatMap((point) =>
      filters.map(
        (filter) => `nwr(around:${AROUND_RADIUS_METERS},${point.lat},${point.lon})${filter};`,
      ),
    )
    .join("");
  return `[out:json][timeout:25];(${statements})->.l;node.l out tags;way.l out tags geom;rel.l out center tags;`;
}

export interface OverpassLandmarkElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  geometry?: { lat: number; lon: number }[];
}

function brandOf(tags: Record<string, string>): string | undefined {
  const brand = tags.brand?.trim();
  return brand && brand.length <= MAX_BRAND ? brand : undefined;
}

/** The candidate's category and spoken attributes, or null when it does not qualify. */
function classify(
  tags: Record<string, string>,
): Pick<LandmarkCandidate, "category" | "brand" | "religion"> | null {
  const brand = brandOf(tags);
  const withBrand = brand ? { brand } : {};
  switch (tags.amenity) {
    case "fuel":
      return { category: "fuel", ...withBrand };
    case "pharmacy":
      return { category: "pharmacy", ...withBrand };
    case "fast_food":
      // Only a brand singles out a fast-food place for a spoken prompt.
      return brand ? { category: "fast_food", brand } : null;
    case "place_of_worship": {
      const religion = tags.religion;
      // A visible building, of a religion the prompts have a word for.
      const isBuilding = tags.building !== undefined && tags.building !== "no";
      return isBuilding && religion && RELIGIONS.has(religion)
        ? { category: "place_of_worship", religion }
        : null;
    }
  }
  if (tags.shop === "supermarket") return { category: "supermarket", ...withBrand };
  return null;
}

function positionOf(
  element: OverpassLandmarkElement,
): { lat: number; lon: number; outline?: [number, number][] } | null {
  if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.type === "way" && element.geometry) {
    const vertices = element.geometry.filter(
      (vertex) => Number.isFinite(vertex?.lat) && Number.isFinite(vertex?.lon),
    );
    if (vertices.length === 0) return null;
    const lats = vertices.map((vertex) => vertex.lat);
    const lons = vertices.map((vertex) => vertex.lon);
    // The centre of the way's bounding box, as Overpass reports it.
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2;
    const lon = (Math.min(...lons) + Math.max(...lons)) / 2;
    const outline =
      vertices.length <= MAX_OUTLINE_VERTICES
        ? vertices.map(({ lat: y, lon: x }) => [x, y] as [number, number])
        : undefined;
    return { lat: round(lat, 7), lon: round(lon, 7), ...(outline && { outline }) };
  }
  if (element.center) return { lat: element.center.lat, lon: element.center.lon };
  return null;
}

/** The allowlisted candidates of the shared answer that lie near `point`. */
export function mapLandmarkElements(
  elements: OverpassLandmarkElement[],
  point: LandmarkPoint,
): LandmarkCandidate[] {
  const centre: [number, number] = [point.lon, point.lat];
  const candidates: LandmarkCandidate[] = [];
  for (const element of elements) {
    const kind = element.tags ? classify(element.tags) : null;
    if (!kind) continue;
    const position = positionOf(element);
    if (!position) continue;
    const vertices: [number, number][] = [
      [position.lon, position.lat],
      ...(position.outline ?? []),
    ];
    const near = vertices.some((vertex) => haversineDistance(centre, vertex) <= POINT_MATCH_METERS);
    if (!near) continue;
    candidates.push({ ...kind, ...position });
  }
  return candidates;
}
