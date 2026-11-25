"use client";

import {
  type BikeRoutingOptions,
  type BoundingBox,
  bicycleOptions,
  isBikeHillPreference,
  isBikeProfile,
  isBikeSpeedKmh,
  type LngLat,
  PANEL,
  type Waypoint,
  type WaypointSchedule,
} from "@openmapx/core";
import {
  formatLinkBoolean,
  type MapLinkParam,
  MAP_LINK_PARAMS as P,
  parseLinkBoolean,
} from "@openmapx/core/map-link-params";

/** An external request to read the URL; UPDATE writes the current stores to it. */
export const DEEPLINK_OPEN_EVENT = "openmapx:deeplink:open";
export const DEEPLINK_UPDATE_EVENT = "openmapx:deeplink:update";

/** The overlay parameters, each passed through as its raw string. */
const OVERLAY_SETTING_PARAMS = [
  P.weather,
  P.satelliteLayer,
  P.satelliteDate,
  P.satelliteOpacity,
  P.earthquakes,
  P.wildfires,
  P.naturalEventDays,
  P.naturalEventCategories,
  P.weatherAlertSeverities,
  P.environmentSensor,
  P.streetLevelImage,
  P.hikingTrail,
  P.winterSportsFeature,
  P.cyclingAutomatic,
  P.liveTransitExcludedProviders,
  P.liveTransitExcludedModes,
  P.liveTransitExcludedCodespaces,
  P.liveTransitVehicle,
] as const;

type OverlaySettingParam = (typeof OVERLAY_SETTING_PARAMS)[number];

export const DEEPLINK_PARAMS: ReadonlySet<MapLinkParam> = new Set(Object.values(P));

export interface CameraDeepLink {
  center: LngLat;
  zoom: number;
  bearing?: number;
  pitch?: number;
}

export interface LabeledPointDeepLink {
  coords: LngLat;
  label: string;
}

export interface DeepLinkPlace {
  id: string;
  coords: LngLat;
  name: string;
  category?: string;
  rawCategory?: string;
  /** Name of the transit stop the place was opened for (see `Place.transitStop`). */
  stopName?: string;
}

export interface ParsedDeepLink {
  hasDeepLinkParams: boolean;
  map?: CameraDeepLink;
  baseLayer?: string;
  globe?: boolean;
  buildingsOff?: boolean;
  overlays?: string[];
  panel?: string;
  place?: DeepLinkPlace;
  directions?: BikeRoutingOptions & {
    mode?: string;
    avoid: string[];
    /**
     * One entry per directions slot; `null` is a blank slot (an empty
     * `waypoint=`), kept so later waypoints and the `schedule` indices keep
     * their position.
     */
    waypoints: (LabeledPointDeepLink | null)[];
    /** Per-waypoint time constraints, keyed by waypoint index. */
    schedules: Record<number, WaypointSchedule>;
  };
  category?: {
    id: string;
    bbox?: BoundingBox;
  };
  /** A free-text search of an area (the results list a typed query opens). */
  textSearch?: {
    text: string;
    bbox?: BoundingBox;
  };
  dataSource?: {
    id: string;
    itemId?: string;
    bbox?: BoundingBox;
  };
  saved?: {
    tab?: string;
    listId?: string;
  };
  measurement?: {
    mode: string;
    unitSystem?: string;
    points: LngLat[];
    finalized: boolean;
  };
  travelTime?: {
    mode: string;
    origin?: LngLat;
    minutes: number[];
  };
  /** Every overlay parameter, empty when the link does not carry it. */
  overlaySettings: Record<OverlaySettingParam, string>;
}

export type ShareCurrentUrlResult = "shared" | "copied" | "cancelled" | "unavailable";

function parseFinite(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeZero(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}

function formatNumber(value: number, precision: number): string {
  return normalizeZero(Number(value.toFixed(precision))).toString();
}

function validLngLat(lng: number, lat: number): boolean {
  return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;
}

export function formatLngLat(coords: LngLat): string {
  const [lng, lat] = coords;
  return `${formatNumber(lat, 6)},${formatNumber(lng, 6)}`;
}

export function parseLngLatParam(value: string | null): LngLat | null {
  if (!value) return null;
  const [latRaw, lngRaw] = value.split(",");
  const lat = parseFinite(latRaw ?? null);
  const lng = parseFinite(lngRaw ?? null);
  if (lat === null || lng === null || !validLngLat(lng, lat)) return null;
  return [lng, lat];
}

export function formatLabeledPoint(point: LabeledPointDeepLink): string {
  const prefix = formatLngLat(point.coords);
  return point.label ? `${prefix},${point.label}` : prefix;
}

export function parseLabeledPoint(value: string | null): LabeledPointDeepLink | null {
  if (!value) return null;
  const parts = value.split(",");
  if (parts.length < 2) return null;
  const coords = parseLngLatParam(`${parts[0]},${parts[1]}`);
  if (!coords) return null;
  return { coords, label: parts.slice(2).join(",").trim() };
}

export function formatCameraParam(camera: CameraDeepLink): string {
  const parts = [
    formatLngLat(camera.center),
    formatNumber(camera.zoom, 2),
    formatNumber(camera.bearing ?? 0, 1),
    formatNumber(camera.pitch ?? 0, 1),
  ];
  return parts.join(",");
}

export interface LocationShareTarget {
  id: string;
  coordinates: LngLat;
  name: string;
  category?: string;
  rawCategory?: string;
}

export function buildLocationShareUrl(currentHref: string, target: LocationShareTarget): string {
  const url = new URL(currentHref);
  url.search = "";
  url.hash = "";
  url.searchParams.set(
    P.camera,
    formatCameraParam({ center: target.coordinates, zoom: 16, bearing: 0, pitch: 0 }),
  );
  url.searchParams.set(P.panel, PANEL.PLACE);
  writePlaceParams(url.searchParams, target);
  return url.toString();
}

/** The place parameters of a link; the transit stop only when the place has one. */
export function writePlaceParams(
  params: URLSearchParams,
  place: LocationShareTarget & { transitStopName?: string },
): void {
  params.set(P.place, place.id);
  params.set(P.placeLocation, formatLngLat(place.coordinates));
  if (place.name) params.set(P.placeName, place.name);
  if (place.category) params.set(P.placeCategory, place.category);
  if (place.rawCategory) params.set(P.placeRawCategory, place.rawCategory);
  if (place.transitStopName) params.set(P.placeTransitStop, place.transitStopName);
}

/** The cycling parameters of a link, booleans as `1`/`0`; none for another mode. */
export function writeBikeParams(
  params: URLSearchParams,
  mode: string | undefined,
  options: BikeRoutingOptions,
): void {
  if (mode !== "cycling") return;
  const bike = bicycleOptions("cycling", options);
  if (bike.bikeProfile) params.set(P.bikeProfile, bike.bikeProfile);
  if (bike.bikeHillPreference) params.set(P.bikeHillPreference, bike.bikeHillPreference);
  params.set(P.bikePreferQuietRoads, formatLinkBoolean(bike.bikePreferQuietRoads === true));
  params.set(P.bikePreferSmoothSurfaces, formatLinkBoolean(bike.bikePreferSmoothSurfaces === true));
  if (bike.bikeSpeedKmh !== undefined) params.set(P.bikeSpeedKmh, String(bike.bikeSpeedKmh));
}

/** The `avoid` list of a link, or nothing when no road class is avoided. */
export function writeAvoidParam(
  params: URLSearchParams,
  options: { avoidHighways?: boolean; avoidTolls?: boolean; avoidFerries?: boolean },
): void {
  setCsvParam(params, P.avoid, [
    options.avoidHighways ? "highways" : "",
    options.avoidTolls ? "tolls" : "",
    options.avoidFerries ? "ferries" : "",
  ]);
}

export interface DirectionsShareTarget extends BikeRoutingOptions {
  waypoints: { coords: LngLat; label?: string }[];
  mode?: string;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
}

/** Deep link into the main app's directions panel (each `waypoint` is lat,lng order). */
export function buildDirectionsDeepLinkUrl(origin: string, target: DirectionsShareTarget): string {
  const url = new URL("/", origin);
  url.searchParams.set(P.panel, PANEL.DIRECTIONS);
  if (target.mode && target.mode !== "driving") url.searchParams.set(P.travelMode, target.mode);
  writeBikeParams(url.searchParams, target.mode, target);
  writeAvoidParam(url.searchParams, target);
  for (const waypoint of target.waypoints) {
    url.searchParams.append(
      P.waypoint,
      formatLabeledPoint({ coords: waypoint.coords, label: waypoint.label ?? "" }),
    );
  }
  return url.toString();
}

export const SCHEDULE_PARAM_VERSION = 1;

const SCHEDULE_KEYS: Record<string, "departAfter" | "arriveBy" | "fixedAt" | "timeZone"> = {
  d: "departAfter",
  a: "arriveBy",
  f: "fixedAt",
  z: "timeZone",
};
const SCHEDULE_WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_SCHEDULE_DWELL_MINUTES = 1440;

/**
 * Records are separated by `;`, fields within a record by `,`. Not by `:` —
 * a wall clock contains one, and a comma appears in neither `YYYY-MM-DDTHH:mm`
 * nor an IANA zone id.
 */
export function parseScheduleParam(value: string | null): Record<number, WaypointSchedule> {
  if (!value) return {};
  const separator = value.indexOf("|");
  if (separator < 0) return {};
  const version = value.slice(0, separator);
  const body = value.slice(separator + 1);
  if (Number(version) !== SCHEDULE_PARAM_VERSION || !body) return {};

  const result: Record<number, WaypointSchedule> = {};
  for (const record of body.split(";")) {
    const [rawIndex, ...fields] = record.split(",");
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0) continue;

    const schedule: WaypointSchedule = {};
    let valid = true;
    for (const field of fields) {
      const eq = field.indexOf("=");
      if (eq < 0) continue;
      const key = field.slice(0, eq);
      const raw = field.slice(eq + 1);
      if (key === "w") {
        const minutes = Number(raw);
        if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_SCHEDULE_DWELL_MINUTES) {
          valid = false;
          break;
        }
        if (minutes > 0) schedule.dwellSeconds = minutes * 60;
        continue;
      }
      const target = SCHEDULE_KEYS[key];
      if (!target) continue;
      if (target !== "timeZone" && !SCHEDULE_WALL_CLOCK.test(raw)) {
        valid = false;
        break;
      }
      schedule[target] = raw;
    }
    if (valid && Object.keys(schedule).length > 0) result[index] = schedule;
  }
  return result;
}

/**
 * The `waypoint` values for a directions route: one per slot once any slot has
 * a place, a blank slot as an empty value so the slots after it (and the
 * `schedule` indices, which count every slot) keep their position.
 */
export function formatWaypointParams(
  waypoints: readonly Pick<Waypoint, "coords" | "label">[],
): string[] {
  if (!waypoints.some((waypoint) => waypoint.coords)) return [];
  return waypoints.map((waypoint) =>
    waypoint.coords ? formatLabeledPoint({ coords: waypoint.coords, label: waypoint.label }) : "",
  );
}

/**
 * `null` when no waypoint is constrained, so an ordinary link is unchanged.
 * Indices count every slot, blank ones included, matching `formatWaypointParams`.
 */
export function formatScheduleParam(waypoints: Waypoint[]): string | null {
  const records: string[] = [];
  waypoints.forEach((waypoint, index) => {
    const schedule = waypoint.schedule;
    if (!schedule) return;
    const fields: string[] = [];
    if (schedule.departAfter) fields.push(`d=${schedule.departAfter}`);
    if (schedule.arriveBy) fields.push(`a=${schedule.arriveBy}`);
    if (schedule.fixedAt) fields.push(`f=${schedule.fixedAt}`);
    if (schedule.timeZone) fields.push(`z=${schedule.timeZone}`);
    if (schedule.dwellSeconds) fields.push(`w=${Math.round(schedule.dwellSeconds / 60)}`);
    if (fields.length > 0) records.push([index, ...fields].join(","));
  });
  return records.length > 0 ? `${SCHEDULE_PARAM_VERSION}|${records.join(";")}` : null;
}

export function parseCameraParam(value: string | null): CameraDeepLink | null {
  if (!value) return null;
  const parts = value.split(",");
  if (parts.length < 3) return null;
  const coords = parseLngLatParam(`${parts[0]},${parts[1]}`);
  const zoom = parseFinite(parts[2] ?? null);
  if (!coords || zoom === null || zoom < 0 || zoom > 24) return null;
  const bearing = parseFinite(parts[3] ?? null) ?? 0;
  const pitch = parseFinite(parts[4] ?? null) ?? 0;
  return {
    center: coords,
    zoom,
    bearing,
    pitch: Math.max(0, Math.min(85, pitch)),
  };
}

export function formatBboxParam(bbox: BoundingBox): string {
  return [
    formatNumber(bbox.west, 6),
    formatNumber(bbox.south, 6),
    formatNumber(bbox.east, 6),
    formatNumber(bbox.north, 6),
  ].join(",");
}

export function parseBboxParam(value: string | null): BoundingBox | null {
  if (!value) return null;
  const [westRaw, southRaw, eastRaw, northRaw] = value.split(",");
  const west = parseFinite(westRaw ?? null);
  const south = parseFinite(southRaw ?? null);
  const east = parseFinite(eastRaw ?? null);
  const north = parseFinite(northRaw ?? null);
  if (west === null || south === null || east === null || north === null) return null;
  if (!validLngLat(west, south) || !validLngLat(east, north)) return null;
  if (south > north) return null;
  return { west, south, east, north };
}

export function splitCsv(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function setCsvParam(
  params: URLSearchParams,
  name: string,
  values: readonly string[],
): void {
  const normalized = [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (normalized.length > 0) params.set(name, normalized.join(","));
}

export function formatLngLatList(points: readonly LngLat[]): string {
  return points.map(formatLngLat).join(";");
}

export function parseLngLatListParam(value: string | null): LngLat[] {
  if (!value) return [];
  return value
    .split(";")
    .map(parseLngLatParam)
    .filter((point): point is LngLat => Boolean(point));
}

export function paramsWithoutDeepLink(search: string | URLSearchParams): URLSearchParams {
  const params = toSearchParams(search);

  for (const key of DEEPLINK_PARAMS) {
    params.delete(key);
  }

  return params;
}

function toSearchParams(search: string | URLSearchParams): URLSearchParams {
  return typeof search === "string"
    ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
    : new URLSearchParams(search.toString());
}

/**
 * The surfaces a deep link has open, outermost first — what the Back gesture
 * steps through, one entry per level. The camera, base layer and overlays are
 * deliberately not part of it: panning the map or toggling a layer is not a
 * place to go back to.
 *
 * Segments are `kind` or `kind:identity`; two paths that differ only in the
 * identity of their last segment are siblings (another place in the same list).
 */
export function navigationPath(search: string | URLSearchParams): string[] {
  const params = toSearchParams(search);
  const panel = params.get(P.panel);
  const categoryId = params.get(P.category);
  const text = params.get(P.search);
  const source = params.get(P.dataSource);
  const path: string[] = [];

  if (categoryId) path.push(`category:${categoryId}`);
  else if (text) path.push(`search:${text}`);
  else if (source) path.push(`datasource:${source}`);
  else if (panel && panel !== PANEL.PLACE && panel !== PANEL.PLACE_CARD) path.push(panel);

  const list = params.get(P.savedList);
  if (panel === PANEL.SAVED && list) path.push(`list:${list}`);
  const item = params.get(P.dataSourceItem);
  if (source && item) path.push(`item:${item}`);
  const place = params.get(P.place);
  if (place && params.has(P.placeLocation)) path.push(`place:${place}`);

  if (params.has(P.measurement)) path.push("tool:measure");
  if (params.has(P.travelTime)) path.push("tool:iso");
  return path;
}

function hasAnyDeepLinkParam(params: URLSearchParams): boolean {
  for (const key of DEEPLINK_PARAMS) {
    if (params.has(key)) return true;
  }
  return false;
}

export function parseDeepLinkSearch(search: string | URLSearchParams): ParsedDeepLink {
  const params = toSearchParams(search);

  const placeId = params.get(P.place);
  const placeCoords = parseLngLatParam(params.get(P.placeLocation));

  const place =
    placeId && placeCoords
      ? {
          id: placeId,
          coords: placeCoords,
          name: params.get(P.placeName) ?? "",
          category: params.get(P.placeCategory) ?? undefined,
          rawCategory: params.get(P.placeRawCategory) ?? undefined,
          stopName: params.get(P.placeTransitStop) ?? undefined,
        }
      : undefined;

  const categoryId = params.get(P.category);
  const searchText = params.get(P.search);
  const sourceId = params.get(P.dataSource);
  const measureMode = params.get(P.measurement);
  const isoMode = params.get(P.travelTime);
  const bounds = parseBboxParam(params.get(P.bounds)) ?? undefined;
  const mode = params.get(P.travelMode);
  const bikeProfile = params.get(P.bikeProfile);
  const bikeHillPreference = params.get(P.bikeHillPreference);
  const bikeSpeedKmh = Number(params.get(P.bikeSpeedKmh));

  return {
    hasDeepLinkParams: hasAnyDeepLinkParam(params),
    map: parseCameraParam(params.get(P.camera)) ?? undefined,
    baseLayer: params.get(P.baseLayer) ?? undefined,
    globe: parseLinkBoolean(params.get(P.globe)),
    buildingsOff: parseLinkBoolean(params.get(P.buildings)) === false,
    overlays: splitCsv(params.get(P.overlay)),
    panel: params.get(P.panel) ?? undefined,
    place,
    directions:
      params.has(P.waypoint) || mode !== null || params.get(P.panel) === PANEL.DIRECTIONS
        ? {
            mode: mode ?? undefined,
            ...(mode === "cycling"
              ? bicycleOptions("cycling", {
                  bikeProfile: isBikeProfile(bikeProfile) ? bikeProfile : undefined,
                  bikeHillPreference: isBikeHillPreference(bikeHillPreference)
                    ? bikeHillPreference
                    : undefined,
                  bikePreferQuietRoads: parseLinkBoolean(params.get(P.bikePreferQuietRoads)),
                  bikePreferSmoothSurfaces: parseLinkBoolean(
                    params.get(P.bikePreferSmoothSurfaces),
                  ),
                  bikeSpeedKmh: isBikeSpeedKmh(bikeSpeedKmh) ? bikeSpeedKmh : undefined,
                })
              : {}),
            avoid: splitCsv(params.get(P.avoid)),
            waypoints: params
              .getAll(P.waypoint)
              .flatMap((value): (LabeledPointDeepLink | null)[] => {
                // Empty marks a blank slot; anything else unreadable is dropped.
                if (value === "") return [null];
                const point = parseLabeledPoint(value);
                return point ? [point] : [];
              }),
            schedules: parseScheduleParam(params.get(P.schedule)),
          }
        : undefined,
    category: categoryId ? { id: categoryId, bbox: bounds } : undefined,
    textSearch: !categoryId && searchText ? { text: searchText, bbox: bounds } : undefined,
    dataSource: sourceId
      ? {
          id: sourceId,
          itemId: params.get(P.dataSourceItem) ?? undefined,
          bbox: bounds,
        }
      : undefined,
    saved:
      params.has(P.savedTab) || params.has(P.savedList) || params.get(P.panel) === PANEL.SAVED
        ? {
            tab: params.get(P.savedTab) ?? undefined,
            listId: params.get(P.savedList) ?? undefined,
          }
        : undefined,
    measurement: measureMode
      ? {
          mode: measureMode,
          unitSystem: params.get(P.measurementUnits) ?? undefined,
          points: parseLngLatListParam(params.get(P.measurementPoints)),
          finalized: parseLinkBoolean(params.get(P.measurementFinished)) === true,
        }
      : undefined,
    travelTime: isoMode
      ? {
          mode: isoMode,
          origin: parseLngLatParam(params.get(P.travelTimeOrigin)) ?? undefined,
          minutes: splitCsv(params.get(P.travelTimeMinutes))
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0),
        }
      : undefined,
    // An entry for every parameter in the tuple, so the record is complete.
    overlaySettings: Object.fromEntries(
      OVERLAY_SETTING_PARAMS.map((name) => [name, params.get(name) ?? ""]),
    ) as Record<OverlaySettingParam, string>,
  };
}

export function requestDeepLinkUpdate(): string {
  if (typeof window === "undefined") return "";
  window.dispatchEvent(new Event(DEEPLINK_UPDATE_EVENT));
  return window.location.href;
}

export async function shareUrl({
  url,
  title = "OpenMapX",
  text,
}: {
  url: string;
  title?: string;
  text?: string;
}): Promise<ShareCurrentUrlResult> {
  if (typeof navigator === "undefined") return "unavailable";
  const payload = { title, text, url };
  if (typeof navigator.share === "function" && (navigator.canShare?.(payload) ?? true)) {
    try {
      await navigator.share(payload);
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    }
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return "copied";
    }
  } catch {
    return "unavailable";
  }
  return "unavailable";
}

export async function shareCurrentUrl({
  title = "OpenMapX",
  text,
}: {
  title?: string;
  text?: string;
} = {}): Promise<ShareCurrentUrlResult> {
  if (typeof window === "undefined") return "unavailable";
  return shareUrl({ title, text, url: requestDeepLinkUpdate() });
}
