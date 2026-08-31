"use client";

import { type BoundingBox, type LngLat, PANEL } from "@openmapx/core";

export const DEEPLINK_UPDATE_EVENT = "openmapx:deeplink:update";

export const DEEPLINK_PARAMS = new Set([
  "map",
  "base",
  "globe",
  "ov",
  "panel",
  "place",
  "at",
  "name",
  "cat",
  "raw",
  "mode",
  "avoid",
  "units",
  "wp",
  "categoryId",
  "bbox",
  "source",
  "item",
  "savedTab",
  "list",
  "measure",
  "measureUnit",
  "measurePts",
  "measureDone",
  "iso",
  "isoAt",
  "isoMins",
  "weather",
  "sat",
  "date",
  "opacity",
  "eq",
  "fire",
  "neDays",
  "neCat",
  "alertSev",
  "envSensor",
  "sli",
  "trail",
  "winter",
  "cycleAuto",
  "ltProviders",
  "ltModes",
  "ltCodes",
  "ltVehicle",
]);

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
}

export interface ParsedDeepLink {
  hasDeepLinkParams: boolean;
  map?: CameraDeepLink;
  base?: string;
  globe?: boolean;
  overlays?: string[];
  panel?: string;
  place?: DeepLinkPlace;
  directions?: {
    mode?: string;
    avoid: string[];
    units?: string;
    waypoints: LabeledPointDeepLink[];
  };
  category?: {
    id: string;
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
  overlaySettings: Record<string, string>;
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
    "map",
    formatCameraParam({ center: target.coordinates, zoom: 16, bearing: 0, pitch: 0 }),
  );
  url.searchParams.set("panel", PANEL.PLACE);
  url.searchParams.set("place", target.id);
  url.searchParams.set("at", formatLngLat(target.coordinates));
  if (target.name) url.searchParams.set("name", target.name);
  if (target.category) url.searchParams.set("cat", target.category);
  if (target.rawCategory) url.searchParams.set("raw", target.rawCategory);
  return url.toString();
}

export interface DirectionsShareTarget {
  waypoints: { coords: LngLat; label?: string }[];
  mode?: string;
  avoidHighways?: boolean;
  avoidTolls?: boolean;
  avoidFerries?: boolean;
}

/** Deep link into the main app's directions panel (the `wp` param is lat,lng order). */
export function buildDirectionsDeepLinkUrl(origin: string, target: DirectionsShareTarget): string {
  const url = new URL("/", origin);
  url.searchParams.set("panel", PANEL.DIRECTIONS);
  if (target.mode && target.mode !== "driving") url.searchParams.set("mode", target.mode);
  const avoid = [
    target.avoidHighways ? "highways" : "",
    target.avoidTolls ? "tolls" : "",
    target.avoidFerries ? "ferries" : "",
  ].filter(Boolean);
  if (avoid.length > 0) url.searchParams.set("avoid", avoid.join(","));
  for (const waypoint of target.waypoints) {
    url.searchParams.append(
      "wp",
      formatLabeledPoint({ coords: waypoint.coords, label: waypoint.label ?? "" }),
    );
  }
  return url.toString();
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
  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : new URLSearchParams(search.toString());

  for (const key of DEEPLINK_PARAMS) {
    params.delete(key);
  }

  return params;
}

function hasAnyDeepLinkParam(params: URLSearchParams): boolean {
  for (const key of DEEPLINK_PARAMS) {
    if (params.has(key)) return true;
  }
  return false;
}

export function parseDeepLinkSearch(search: string | URLSearchParams): ParsedDeepLink {
  const params =
    typeof search === "string"
      ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
      : new URLSearchParams(search.toString());

  const placeId = params.get("place");
  const placeCoords = parseLngLatParam(params.get("at"));

  const place =
    placeId && placeCoords
      ? {
          id: placeId,
          coords: placeCoords,
          name: params.get("name") ?? "",
          category: params.get("cat") ?? undefined,
          rawCategory: params.get("raw") ?? undefined,
        }
      : undefined;

  const categoryId = params.get("categoryId");
  const sourceId = params.get("source");
  const measureMode = params.get("measure");
  const isoMode = params.get("iso");

  return {
    hasDeepLinkParams: hasAnyDeepLinkParam(params),
    map: parseCameraParam(params.get("map")) ?? undefined,
    base: params.get("base") ?? undefined,
    globe: params.has("globe") ? params.get("globe") === "1" : undefined,
    overlays: splitCsv(params.get("ov")),
    panel: params.get("panel") ?? undefined,
    place,
    directions:
      params.has("wp") || params.has("mode") || params.get("panel") === "directions"
        ? {
            mode: params.get("mode") ?? undefined,
            avoid: splitCsv(params.get("avoid")),
            units: params.get("units") ?? undefined,
            waypoints: params
              .getAll("wp")
              .map(parseLabeledPoint)
              .filter((wp): wp is LabeledPointDeepLink => Boolean(wp)),
          }
        : undefined,
    category: categoryId
      ? { id: categoryId, bbox: parseBboxParam(params.get("bbox")) ?? undefined }
      : undefined,
    dataSource: sourceId
      ? {
          id: sourceId,
          itemId: params.get("item") ?? undefined,
          bbox: parseBboxParam(params.get("bbox")) ?? undefined,
        }
      : undefined,
    saved:
      params.has("savedTab") || params.has("list") || params.get("panel") === "saved"
        ? {
            tab: params.get("savedTab") ?? undefined,
            listId: params.get("list") ?? undefined,
          }
        : undefined,
    measurement: measureMode
      ? {
          mode: measureMode,
          unitSystem: params.get("measureUnit") ?? undefined,
          points: parseLngLatListParam(params.get("measurePts")),
          finalized: params.get("measureDone") === "1",
        }
      : undefined,
    travelTime: isoMode
      ? {
          mode: isoMode,
          origin: parseLngLatParam(params.get("isoAt")) ?? undefined,
          minutes: splitCsv(params.get("isoMins"))
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0),
        }
      : undefined,
    overlaySettings: {
      weather: params.get("weather") ?? "",
      sat: params.get("sat") ?? "",
      date: params.get("date") ?? "",
      opacity: params.get("opacity") ?? "",
      eq: params.get("eq") ?? "",
      fire: params.get("fire") ?? "",
      neDays: params.get("neDays") ?? "",
      neCat: params.get("neCat") ?? "",
      alertSev: params.get("alertSev") ?? "",
      envSensor: params.get("envSensor") ?? "",
      sli: params.get("sli") ?? "",
      trail: params.get("trail") ?? "",
      winter: params.get("winter") ?? "",
      cycleAuto: params.get("cycleAuto") ?? "",
      ltProviders: params.get("ltProviders") ?? "",
      ltModes: params.get("ltModes") ?? "",
      ltCodes: params.get("ltCodes") ?? "",
      ltVehicle: params.get("ltVehicle") ?? "",
    },
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
