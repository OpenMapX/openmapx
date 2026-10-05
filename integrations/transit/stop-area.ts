import { isOverpassRuntimeLimit, type OverpassResponse } from "@openmapx/core";
import { convexHull, spanMeters } from "@openmapx/core/navigation";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { diceSimilarity, haversineMeters } from "@openmapx/mobility-core/geo";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type {
  TransitStop,
  TransitStopArea,
  TransitStopAreaShape,
} from "@openmapx/mobility-core/transit";

/**
 * Where a stop physically is, for deciding that a navigating rider reached it.
 *
 * A trip's stop is a quay id and one coordinate. On the map the same stop is a
 * platform — a node for a bus pole, a 400 m area for a train — inside a stop
 * place that groups every platform, stop position and station building. This
 * module finds both in OpenStreetMap:
 *
 *  - by identity first: German (and other IFOPT/DHID) quay ids such as
 *    `de:05334:1008:91:2` are tagged `ref:IFOPT` on the platform, the stop
 *    positions and the `stop_area` relation, so the match is exact;
 *  - then by platform code (`ref` / `local_ref`) inside that stop place;
 *  - then by the nearest platform for the vehicle, and stop places by name.
 *
 * Shapes leave buffers unapplied: a navigation engine widens them by the fix's
 * accuracy, and containment stays exact.
 */

type LngLat = [number, number];

export interface StopAreaQuery {
  stopId: string;
  lat: number;
  lng: number;
  name: string;
  platform?: string;
  mode: string;
}

const RAIL_MODES = new Set(["rail", "subway", "monorail", "funicular"]);
const MODES = new Set([
  "bus",
  "rail",
  "subway",
  "tram",
  "ferry",
  "gondola",
  "funicular",
  "cable_car",
  "monorail",
]);

/** Search radius around the stop: a station's platforms spread much further than a bus stop's. */
const SEARCH_RADIUS_METERS = { local: 150, rail: 300 } as const;
/** How far the nearest platform may be from the stop's point and still be its platform. */
const NEAREST_PLATFORM_METERS = { local: 25, rail: 40 } as const;
const BUFFER = {
  polygon: 3,
  /** Half a platform's width around a platform drawn as a line. */
  line: 4,
  platformNode: { local: 12, rail: 25 },
  stopPosition: 10,
  station: 10,
  feedStation: { local: 15, rail: 30 },
} as const;
/** A stop place wider than this is a mapping error, not a station. */
const MAX_STATION_SPAN_METERS = 1500;
const MIN_NAME_SIMILARITY = 0.6;

const isRail = (mode: string) => RAIL_MODES.has(mode);

/** Validates the lookup's query; null when it cannot describe a stop. */
export function parseStopAreaQuery(
  stopId: string,
  query: Record<string, string | undefined>,
): StopAreaQuery | null {
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const name = (query.name ?? "").trim();
  const platform = query.platform?.trim();
  const mode = query.mode ?? "";
  if (!stopId || stopId.length > 256) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null;
  if (name.length > 200 || (platform && platform.length > 32) || !MODES.has(mode)) return null;
  return { stopId, lat, lng, name, ...(platform ? { platform } : {}), mode };
}

/**
 * Cache identity: the stop id with the position and platform the request
 * claimed, so a request carrying a wrong position cannot answer for everyone
 * else asking about the same id.
 */
export function stopAreaCacheKey(query: StopAreaQuery): string {
  return [
    "stop-area:v1",
    query.stopId,
    query.lat.toFixed(4),
    query.lng.toFixed(4),
    query.platform ?? "",
    query.mode,
  ].join(":");
}

export interface IfoptId {
  /** The full id as given, e.g. `de:05334:1008:91:2`. */
  id: string;
  /** Country, district and stop place: `de:05334:1008`. */
  stopPlace: string;
  /** The stop place's area (a platform shared by two tracks): `de:05334:1008:91`. */
  area: string | null;
}

/**
 * The IFOPT/DHID id inside a feed stop id such as
 * `mo:de-DELFI_de:05334:1008:91:2`, or null when the id is not one.
 */
export function ifoptOf(stopId: string): IfoptId | null {
  const match = /([a-z]{2}:\d+:[^:_\s]+(?::[^:_\s]+){0,2})$/i.exec(stopId);
  if (!match) return null;
  const id = match[1];
  const parts = id.split(":");
  return {
    id,
    stopPlace: parts.slice(0, 3).join(":"),
    area: parts.length === 5 ? parts.slice(0, 4).join(":") : null,
  };
}

/** One query: transit features near the stop, their stop places, and those places' members. */
export function stopAreaOverpassQuery(query: StopAreaQuery): string {
  const radius = isRail(query.mode) ? SEARCH_RADIUS_METERS.rail : SEARCH_RADIUS_METERS.local;
  const around = `around:${radius},${query.lat},${query.lng}`;
  return `[out:json][timeout:20];
(
  nwr(${around})["public_transport"~"^(platform|stop_position|station)$"];
  nwr(${around})["railway"~"^(platform|station|halt|tram_stop|stop)$"];
  nwr(${around})["highway"~"^(bus_stop|platform)$"];
  nwr(${around})["amenity"="bus_station"];
)->.near;
(rel(bn.near)["public_transport"="stop_area"];rel(bw.near)["public_transport"="stop_area"];rel(br.near)["public_transport"="stop_area"];)->.areas;
(node(r.areas);way(r.areas);rel(r.areas);)->.members;
.areas out body;
(.near; .members;);
out body geom;`;
}

interface GeometryPoint {
  lat: number;
  lon: number;
}

interface RawElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: GeometryPoint[];
  members?: Array<{ type: string; ref: number; role?: string; geometry?: GeometryPoint[] }>;
}

interface Feature {
  key: string;
  tags: Record<string, string>;
  /** Geometry pieces, without buffers. */
  pieces: Array<{ type: "point" | "line" | "polygon"; coordinates: LngLat[] }>;
}

const lngLat = (p: GeometryPoint): LngLat => [p.lon, p.lat];

function closed(coords: LngLat[]): boolean {
  if (coords.length < 4) return false;
  const [a, b] = [coords[0], coords[coords.length - 1]];
  return a[0] === b[0] && a[1] === b[1];
}

function wayPiece(
  coords: LngLat[],
  tags: Record<string, string>,
): { type: "line" | "polygon"; coordinates: LngLat[] } {
  // A closed platform outline is an area unless it says otherwise.
  const area = closed(coords) && tags.area !== "no";
  return area
    ? { type: "polygon", coordinates: coords.slice(0, -1) }
    : { type: "line", coordinates: coords };
}

function toFeature(element: RawElement): Feature | null {
  const tags = element.tags ?? {};
  const key = `${element.type}/${element.id}`;
  if (element.type === "node" && element.lat !== undefined && element.lon !== undefined) {
    return { key, tags, pieces: [{ type: "point", coordinates: [[element.lon, element.lat]] }] };
  }
  if (element.type === "way" && element.geometry && element.geometry.length > 0) {
    return { key, tags, pieces: [wayPiece(element.geometry.map(lngLat), tags)] };
  }
  if (element.type === "relation" && tags.public_transport !== "stop_area") {
    const pieces = (element.members ?? [])
      .filter((member) => member.geometry && member.geometry.length > 0)
      .map((member) => wayPiece((member.geometry ?? []).map(lngLat), tags));
    return pieces.length > 0 ? { key, tags, pieces } : null;
  }
  return null;
}

const isPlatform = (tags: Record<string, string>) =>
  tags.public_transport === "platform" ||
  tags.railway === "platform" ||
  tags.highway === "platform" ||
  tags.highway === "bus_stop";

const isStopPosition = (tags: Record<string, string>) =>
  tags.public_transport === "stop_position" ||
  tags.railway === "tram_stop" ||
  tags.railway === "stop";

/** Whether a platform serves this kind of vehicle, as far as its tags say. */
function servesMode(tags: Record<string, string>, mode: string): boolean {
  const yes = (key: string) => tags[key] === "yes";
  const train = yes("train");
  const subway = yes("subway");
  const lightRail = yes("light_rail");
  const tram = yes("tram");
  const bus = yes("bus") || yes("coach") || yes("trolleybus");
  // Vehicle keys say it outright; `railway=platform` alone is any rail vehicle.
  if (train || subway || lightRail || tram || bus) {
    if (mode === "rail") return train || lightRail;
    if (mode === "subway" || mode === "monorail") return subway || lightRail || train;
    if (mode === "tram") return tram || lightRail;
    if (mode === "bus") return bus;
    return true;
  }
  if (tags.highway === "bus_stop") return mode === "bus";
  if (tags.railway === "tram_stop") return mode === "tram";
  if (tags.railway === "platform") return mode !== "bus";
  return true;
}

function ifoptTags(tags: Record<string, string>): string[] {
  return (tags["ref:IFOPT"] ?? "")
    .split(";")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
}

function refTokens(tags: Record<string, string>): string[] {
  return [tags.local_ref, tags.ref, tags["railway:track_ref"]]
    .flatMap((value) => (value ?? "").split(/[;/,]/))
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

/** "Gleis 7", "Gl. 7", "Pl. H.2" → "7", "h.2"; equal codes compare equal. */
function normalisePlatformCode(code: string): string {
  return code
    .trim()
    .toLowerCase()
    .replace(/^(gleis|gl\.?|platform|pl\.?|bstg\.?|bahnsteig|track|quai|voie)\s*/, "");
}

/** Station-name abbreviations, so "Köln Hbf" and "Köln Hauptbahnhof" compare equal. */
const NAME_ABBREVIATIONS: Record<string, string> = {
  hbf: "hauptbahnhof",
  bhf: "bahnhof",
  bf: "bahnhof",
  str: "strasse",
  pl: "platz",
};

/** Lowercased, punctuation-free, abbreviations spelled out, with any leading "City, " dropped. */
function normaliseName(name: string): string[] {
  const plain = (value: string) =>
    value
      .toLowerCase()
      .replace(/ß/g, "ss")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .map((word) => NAME_ABBREVIATIONS[word] ?? word.replace(/strasse$|str$/, "strasse"))
      .join(" ");
  const full = plain(name);
  const comma = name.lastIndexOf(",");
  const local = comma >= 0 ? plain(name.slice(comma + 1)) : full;
  return [...new Set([full, local])].filter(Boolean);
}

function namesMatch(a: string, b: string): boolean {
  for (const left of normaliseName(a)) {
    for (const right of normaliseName(b)) {
      if (left === right || diceSimilarity(left, right) >= MIN_NAME_SIMILARITY) return true;
    }
  }
  return false;
}

function featureDistance(feature: Feature, point: LngLat): number {
  let best = Number.POSITIVE_INFINITY;
  for (const piece of feature.pieces) {
    for (const [lng, lat] of piece.coordinates) {
      best = Math.min(best, haversineMeters(point[1], point[0], lat, lng));
    }
  }
  return best;
}

function platformShapes(feature: Feature, mode: string): TransitStopAreaShape[] {
  const nodeBuffer = isRail(mode) ? BUFFER.platformNode.rail : BUFFER.platformNode.local;
  return feature.pieces.map((piece) =>
    piece.type === "point"
      ? { type: "point", coordinates: piece.coordinates[0], bufferMeters: nodeBuffer }
      : piece.type === "line"
        ? { type: "line", coordinates: piece.coordinates, bufferMeters: BUFFER.line }
        : { type: "polygon", coordinates: piece.coordinates, bufferMeters: BUFFER.polygon },
  );
}

function stopPositionShapes(feature: Feature): TransitStopAreaShape[] {
  return feature.pieces
    .filter((piece) => piece.type === "point")
    .map((piece) => ({
      type: "point" as const,
      coordinates: piece.coordinates[0],
      bufferMeters: BUFFER.stopPosition,
    }));
}

/** A hull around points, as a station area; null when degenerate or implausibly wide. */
function hullShape(points: LngLat[], bufferMeters: number): TransitStopAreaShape | null {
  if (points.length === 0) return null;
  if (spanMeters(convexHull(points)) > MAX_STATION_SPAN_METERS) return null;
  const hull = convexHull(points);
  if (hull.length === 1) return { type: "point", coordinates: hull[0], bufferMeters };
  if (hull.length === 2) return { type: "line", coordinates: hull, bufferMeters };
  return { type: "polygon", coordinates: hull, bufferMeters };
}

/** Derives the stop's platform and stop place from one Overpass answer. */
export function deriveStopAreaFromOsm(
  query: StopAreaQuery,
  response: OverpassResponse,
): TransitStopArea | null {
  const elements = response.elements as unknown as RawElement[];
  const features = new Map<string, Feature>();
  for (const element of elements) {
    const feature = toFeature(element);
    if (feature && !features.has(feature.key)) features.set(feature.key, feature);
  }
  const stopAreas = elements.filter(
    (element) => element.type === "relation" && element.tags?.public_transport === "stop_area",
  );
  const membersOf = (relation: RawElement) =>
    (relation.members ?? [])
      .map((member) => features.get(`${member.type}/${member.ref}`))
      .filter((feature): feature is Feature => feature !== undefined);

  const point: LngLat = [query.lng, query.lat];
  const ifopt = ifoptOf(query.stopId);
  const quay = ifopt?.id.toLowerCase();
  const all = [...features.values()];
  const platforms = all.filter((f) => isPlatform(f.tags));

  // The platform: by identity, by the platform's own area id, by code, then nearest.
  let matched = quay ? platforms.filter((f) => ifoptTags(f.tags).includes(quay)) : [];
  if (matched.length === 0 && ifopt?.area) {
    const area = ifopt.area.toLowerCase();
    matched = platforms.filter((f) => ifoptTags(f.tags).includes(area));
  }

  // The stop place: the relation holding the platform, else one carrying or
  // holding the stop place's id, else one by name.
  const stopPlace = ifopt?.stopPlace.toLowerCase();
  const belongsToStopPlace = (f: Feature) =>
    stopPlace !== undefined &&
    ifoptTags(f.tags).some((id) => id === stopPlace || id.startsWith(`${stopPlace}:`));
  let places = stopAreas.filter((relation) =>
    membersOf(relation).some((member) => matched.includes(member)),
  );
  if (places.length === 0 && stopPlace) {
    places = stopAreas.filter(
      (relation) =>
        ifoptTags(relation.tags ?? {}).includes(stopPlace) ||
        membersOf(relation).some(belongsToStopPlace),
    );
  }
  if (places.length === 0 && query.name) {
    places = stopAreas.filter((relation) => namesMatch(relation.tags?.name ?? "", query.name));
  }
  const placeMembers = places.flatMap(membersOf);
  // Without a stop place relation, the transit features that share the stop's
  // id or name are its stop place — the two poles of a bus stop, say.
  const looseMembers = all.filter(
    (f) =>
      (isPlatform(f.tags) || isStopPosition(f.tags)) &&
      (belongsToStopPlace(f) || (query.name !== "" && namesMatch(f.tags.name ?? "", query.name))),
  );
  const stationFeatures = placeMembers.length > 0 ? placeMembers : looseMembers;

  if (matched.length === 0 && query.platform) {
    const code = normalisePlatformCode(query.platform);
    matched = stationFeatures.filter(
      (f) =>
        (isPlatform(f.tags) || isStopPosition(f.tags)) &&
        servesMode(f.tags, query.mode) &&
        refTokens(f.tags).some((token) => normalisePlatformCode(token) === code),
    );
  }
  // A stop-place id, or a train with no track given, names the station, not a
  // platform: guessing the nearest one would send the rider to the wrong track.
  const stationLevel =
    (ifopt !== null && ifopt.id.split(":").length <= 3) || (isRail(query.mode) && !query.platform);
  if (matched.length === 0 && !stationLevel) {
    const limit = isRail(query.mode) ? NEAREST_PLATFORM_METERS.rail : NEAREST_PLATFORM_METERS.local;
    const nearest = platforms
      .filter((f) => servesMode(f.tags, query.mode))
      .map((f) => ({ f, distance: featureDistance(f, point) }))
      .filter(({ distance }) => distance <= limit)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest) matched = [nearest.f];
  }

  const platform: TransitStopAreaShape[] = matched.flatMap((f) =>
    isPlatform(f.tags) ? platformShapes(f, query.mode) : stopPositionShapes(f),
  );
  if (quay) {
    for (const f of all) {
      if (isStopPosition(f.tags) && ifoptTags(f.tags).includes(quay)) {
        platform.push(...stopPositionShapes(f));
      }
    }
  }

  const stationPoints = [...stationFeatures, ...matched].flatMap((f) =>
    f.pieces.flatMap((piece) => piece.coordinates),
  );
  const hull = stationFeatures.length >= 2 ? hullShape(stationPoints, BUFFER.station) : null;
  const station = hull ? [hull] : [];

  if (platform.length === 0 && station.length === 0) return null;
  return { stopId: query.stopId, platform, station, source: "osm" };
}

/**
 * The stop place as the timetable groups it: a hull around the platforms that
 * share the stop's parent station. Used where OpenStreetMap had no stop place.
 */
export function stopAreaFromSiblings(
  query: StopAreaQuery,
  siblings: ReadonlyArray<{ lat: number; lng: number }>,
): TransitStopArea | null {
  const points: LngLat[] = [
    [query.lng, query.lat],
    ...siblings.map((stop): LngLat => [stop.lng, stop.lat]),
  ];
  if (new Set(points.map((p) => `${p[0]},${p[1]}`)).size < 2) return null;
  const buffer = isRail(query.mode) ? BUFFER.feedStation.rail : BUFFER.feedStation.local;
  const hull = hullShape(points, buffer);
  return hull ? { stopId: query.stopId, platform: [], station: [hull], source: "feed" } : null;
}

export const OSM_ATTRIBUTION: Attribution = {
  sourceId: "openstreetmap",
  name: "OpenStreetMap contributors",
  url: "https://www.openstreetmap.org/copyright",
  spdxLicense: "ODbL-1.0",
  licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
  attributionText: "© OpenStreetMap contributors",
};

export interface StopAreaSources {
  overpass: (query: string) => Promise<OverpassResponse>;
  /** The stop's sibling platforms under its parent station, from the timetable. */
  siblings: (stopId: string) => Promise<MobilityResult<TransitStop[]>>;
}

export interface ResolvedStopArea {
  area: TransitStopArea | null;
  attributions: Attribution[];
  /** False when a source failed, so the answer may be worse than next time's. */
  complete: boolean;
}

/**
 * OpenStreetMap first; where it knows no stop place, the timetable's grouping
 * of platforms under one parent station fills it in.
 */
export async function resolveStopArea(
  query: StopAreaQuery,
  sources: StopAreaSources,
): Promise<ResolvedStopArea> {
  let complete = true;
  let osm: TransitStopArea | null = null;
  try {
    const answer = await sources.overpass(stopAreaOverpassQuery(query));
    if (isOverpassRuntimeLimit(answer.remark)) complete = false;
    osm = deriveStopAreaFromOsm(query, answer);
  } catch {
    complete = false;
  }
  if (osm && osm.station.length > 0) {
    return { area: osm, attributions: [OSM_ATTRIBUTION], complete };
  }

  let feed: TransitStopArea | null = null;
  let feedAttributions: Attribution[] = [];
  try {
    const siblings = await sources.siblings(query.stopId);
    feed = stopAreaFromSiblings(query, siblings.data ?? []);
    feedAttributions = siblings.attributions ?? [];
  } catch {
    complete = false;
  }

  if (osm && feed) {
    return {
      area: { ...osm, station: feed.station },
      attributions: [OSM_ATTRIBUTION, ...feedAttributions],
      complete,
    };
  }
  if (osm) return { area: osm, attributions: [OSM_ATTRIBUTION], complete };
  return { area: feed, attributions: feed ? feedAttributions : [], complete };
}
