import {
  closesRoadForCars,
  haversineDistance,
  isVehicleSpecific,
  type RoadConditionEvent,
} from "@openmapx/core";
import { isSeverityLabel, SEVERITY_COLORS } from "./severity";

export type LngLat = [number, number];

/** Glyph name → 24×24 Material icon path. "other" is the fallback. */
export const GLYPHS: Record<string, string> = {
  accident:
    "M18 1c-2.76 0-5 2.24-5 5s2.24 5 5 5 5-2.24 5-5-2.24-5-5-5m.5 6h-1V3h1zm0 1v1h-1V8zm-.59 5c.06.16.09.33.09.5 0 .83-.67 1.5-1.5 1.5s-1.5-.67-1.5-1.5c0-.39.15-.74.39-1.01-1.63-.66-2.96-1.91-3.71-3.49H5.81l1.04-3H11c0-.69.1-1.37.29-2H6.5c-.66 0-1.21.42-1.42 1.01L3 11v8c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h12v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-6.68c-1.05.51-2.16.69-3.09.68M7.5 15c-.83 0-1.5-.67-1.5-1.5S6.67 12 7.5 12s1.5.67 1.5 1.5S8.33 15 7.5 15",
  congestion:
    "M20 10h-3V8.86c1.72-.45 3-2 3-3.86h-3V4c0-.55-.45-1-1-1H8c-.55 0-1 .45-1 1v1H4c0 1.86 1.28 3.41 3 3.86V10H4c0 1.86 1.28 3.41 3 3.86V15H4c0 1.86 1.28 3.41 3 3.86V20c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-1.14c1.72-.45 3-2 3-3.86h-3v-1.14c1.72-.45 3-2 3-3.86m-8 9c-1.11 0-2-.9-2-2s.89-2 2-2c1.1 0 2 .9 2 2s-.89 2-2 2m0-5c-1.11 0-2-.9-2-2s.89-2 2-2c1.1 0 2 .9 2 2s-.89 2-2 2m0-5c-1.11 0-2-.9-2-2 0-1.11.89-2 2-2 1.1 0 2 .89 2 2 0 1.1-.89 2-2 2",
  roadworks:
    "m13.7829 15.1718 2.1213-2.1213 5.9963 5.9963-2.1213 2.1213zM17.5 10c1.93 0 3.5-1.57 3.5-3.5 0-.58-.16-1.12-.41-1.6l-2.7 2.7-1.49-1.49 2.7-2.7c-.48-.25-1.02-.41-1.6-.41C15.57 3 14 4.57 14 6.5c0 .41.08.8.21 1.16l-1.85 1.85-1.78-1.78.71-.71-1.41-1.41L12 3.49c-1.17-1.17-3.07-1.17-4.24 0L4.22 7.03l1.41 1.41H2.81l-.71.71 3.54 3.54.71-.71V9.15l1.41 1.41.71-.71 1.78 1.78-7.41 7.41 2.12 2.12L16.34 9.79c.36.13.75.21 1.16.21",
  road_closure:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2M4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12m8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8",
  hazard: "M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z",
  weather:
    "M17.92 7.02C17.45 4.18 14.97 2 12 2 9.82 2 7.83 3.18 6.78 5.06 4.09 5.41 2 7.74 2 10.5 2 13.53 4.47 16 7.5 16h10c2.48 0 4.5-2.02 4.5-4.5 0-2.34-1.79-4.27-4.08-4.48M14.8 17l-2.9 3.32 2 1L11.55 24h2.65l2.9-3.32-2-1L17.45 17zm-6 0-2.9 3.32 2 1L5.55 24H8.2l2.9-3.32-2-1L11.45 17z",
  road_condition:
    "M21.98 14H22zM5.35 13c1.19 0 1.42 1 3.33 1 1.95 0 2.09-1 3.33-1 1.19 0 1.42 1 3.33 1 1.95 0 2.09-1 3.33-1 1.19 0 1.4.98 3.31 1v-2c-1.19 0-1.42-1-3.33-1-1.95 0-2.09 1-3.33 1-1.19 0-1.42-1-3.33-1-1.95 0-2.09 1-3.33 1-1.19 0-1.42-1-3.33-1-1.95 0-2.09 1-3.33 1v2c1.9 0 2.17-1 3.35-1m13.32 2c-1.95 0-2.09 1-3.33 1-1.19 0-1.42-1-3.33-1-1.95 0-2.1 1-3.34 1s-1.38-1-3.33-1-2.1 1-3.34 1v2c1.95 0 2.11-1 3.34-1 1.24 0 1.38 1 3.33 1s2.1-1 3.34-1c1.19 0 1.42 1 3.33 1 1.94 0 2.09-1 3.33-1 1.19 0 1.42 1 3.33 1v-2c-1.24 0-1.38-1-3.33-1M5.35 9c1.19 0 1.42 1 3.33 1 1.95 0 2.09-1 3.33-1 1.19 0 1.42 1 3.33 1 1.95 0 2.09-1 3.33-1 1.19 0 1.4.98 3.31 1V8c-1.19 0-1.42-1-3.33-1-1.95 0-2.09 1-3.33 1-1.19 0-1.42-1-3.33-1-1.95 0-2.09 1-3.33 1-1.19 0-1.42-1-3.33-1C3.38 7 3.24 8 2 8v2c1.9 0 2.17-1 3.35-1",
  obstruction:
    "M15.73 3H8.27L3 8.27v7.46L8.27 21h7.46L21 15.73V8.27zM17 15.74 15.74 17 12 13.26 8.26 17 7 15.74 10.74 12 7 8.26 8.26 7 12 10.74 15.74 7 17 8.26 13.26 12z",
  broken_down_vehicle:
    "M16.22 12c.68 0 1.22-.54 1.22-1.22 0-.67-.54-1.22-1.22-1.22S15 10.11 15 10.78c0 .68.55 1.22 1.22 1.22m-9.66-1.22c0 .67.54 1.22 1.22 1.22S9 11.46 9 10.78c0-.67-.54-1.22-1.22-1.22s-1.22.55-1.22 1.22M7.61 4 6.28 8h11.43l-1.33-4zm8.67-1s.54.01.92.54c.02.02.03.04.05.07.07.11.14.24.19.4.22.65 1.56 4.68 1.56 4.68v6.5c0 .45-.35.81-.78.81h-.44c-.43 0-.78-.36-.78-.81V14H7v1.19c0 .45-.35.81-.78.81h-.44c-.43 0-.78-.36-.78-.81v-6.5S6.34 4.67 6.55 4c.05-.16.12-.28.19-.4.03-.02.04-.04.06-.06.38-.53.92-.54.92-.54zM4 17.01h16V19h-7v3h-2v-3H4z",
  public_event:
    "M12 12.75c1.63 0 3.07.39 4.24.9 1.08.48 1.76 1.56 1.76 2.73V18H6v-1.61c0-1.18.68-2.26 1.76-2.73 1.17-.52 2.61-.91 4.24-.91M4 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2m1.13 1.1c-.37-.06-.74-.1-1.13-.1-.99 0-1.93.21-2.78.58C.48 14.9 0 15.62 0 16.43V18h4.5v-1.61c0-.83.23-1.61.63-2.29M20 13c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2m4 3.43c0-.81-.48-1.53-1.22-1.85-.85-.37-1.79-.58-2.78-.58-.39 0-.76.04-1.13.1.4.68.63 1.46.63 2.29V18H24zM12 6c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3",
  authority:
    "m5.2497 8.0687 2.83-2.8268 14.1342 14.15-2.83 2.8269zm4.2361-4.2415 2.828-2.8288 5.6577 5.656-2.828 2.8288zM.999 12.3147l2.8284-2.8284 5.6569 5.6568-2.8285 2.8285zM1 21h12v2H1z",
  speed_restriction:
    "m20.38 8.57-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83",
  dimension_restriction: "M13 6.99h3L12 3 8 6.99h3v10.02H8L12 21l4-3.99h-3z",
  equipment_fault:
    "m22.7 19-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4",
  security:
    "M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm2.5 11.59.9 3.88-3.4-2.05-3.4 2.05.9-3.87-3-2.59 3.96-.34L12 6.02l1.54 3.64 3.96.34z",
  other:
    "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2m1 15h-2v-6h2zm0-8h-2V7h2z",
  restriction:
    "m20.38 8.57-1.23 1.85a8 8 0 0 1-.22 7.58H5.07A8 8 0 0 1 15.58 6.85l1.85-1.23A10 10 0 0 0 3.35 19a2 2 0 0 0 1.72 1h13.85a2 2 0 0 0 1.74-1 10 10 0 0 0-.27-10.44zm-9.79 6.84a2 2 0 0 0 2.83 0l5.66-8.49-8.49 5.66a2 2 0 0 0 0 2.83",
};

/** The glyph of each registry kind, when its types share one. */
const KIND_GLYPHS: Record<string, string> = {
  roadworks: "roadworks",
  closure: "road_closure",
  weather_condition: "weather",
  winter_operation: "weather",
  road_condition: "road_condition",
  road_hazard: "hazard",
  public_event: "public_event",
  authority: "authority",
  equipment_fault: "equipment_fault",
  security: "security",
  congestion: "congestion",
};

/** The glyph of each `kind.type` that differs from its kind's. */
const TYPE_GLYPH_OVERRIDES: Record<string, string> = {
  "incident.accident": "accident",
  "incident.breakdown": "broken_down_vehicle",
  "incident.vehicle_hazard": "hazard",
  "incident.obstruction": "obstruction",
  "incident.fire": "hazard",
  "restriction.dimension": "dimension_restriction",
  "restriction.speed": "speed_restriction",
};

/** The glyph of a registry classification; an unknown one draws the generic glyph. */
export function glyphFor(kind: string, type?: string): string {
  const override = type ? TYPE_GLYPH_OVERRIDES[`${kind}.${type}`] : undefined;
  if (override) return override;
  if (kind === "incident") return "accident";
  if (kind === "restriction") return "restriction";
  return KIND_GLYPHS[kind] ?? "other";
}

/**
 * The glyph a situation is drawn with. A closure situation whose closures
 * bind only some vehicles draws as a restriction: a vehicle-conditioned
 * closure must not look like the road is shut.
 */
export function markerGlyph(
  event: Pick<RoadConditionEvent, "kind" | "type" | "subtype" | "effects">,
): string {
  if (event.kind === "pass_status") return event.subtype === "closed" ? "road_closure" : "other";
  if (
    event.kind === "closure" &&
    !event.effects.some(closesRoadForCars) &&
    event.effects.some(isVehicleSpecific)
  ) {
    return "restriction";
  }
  return glyphFor(event.kind, event.type);
}

const MARKER_PREFIX = "rc";

/** Stable image id for a (glyph, severity) marker, e.g. "rc:road_closure:major". */
export function markerImageId(glyph: string, severity: string): string {
  const g = GLYPHS[glyph] ? glyph : "other";
  const s = isSeverityLabel(severity) ? severity : "unknown";
  return `${MARKER_PREFIX}:${g}:${s}`;
}

/** The marker image id of a situation. */
export function markerImageIdFor(
  event: Pick<RoadConditionEvent, "kind" | "type" | "subtype" | "effects" | "severity">,
): string {
  return markerImageId(markerGlyph(event), event.severity.label);
}

/** Parse a marker image id back into its glyph + severity. */
export function parseMarkerImageId(id: string): { glyph: string; severity: string } | null {
  const parts = id.split(":");
  if (parts.length !== 3 || parts[0] !== MARKER_PREFIX) return null;
  return { glyph: parts[1] as string, severity: parts[2] as string };
}

/**
 * Rasterize a marker: a severity-colored disc (white ring) with the white
 * glyph centered. One baked image per (glyph, severity) → a single symbol per
 * incident, so the icon never separates from its disc. Returns null off-DOM.
 */
export function markerImageData(glyph: string, severity: string, size = 64): ImageData | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const r = size / 2;
  ctx.beginPath();
  ctx.arc(r, r, r - size * 0.07, 0, Math.PI * 2);
  ctx.fillStyle = isSeverityLabel(severity) ? SEVERITY_COLORS[severity] : SEVERITY_COLORS.unknown;
  ctx.fill();
  ctx.lineWidth = size * 0.05;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  const path = GLYPHS[glyph] ?? (GLYPHS.other as string);
  const scale = (size * 0.52) / 24;
  ctx.save();
  ctx.translate(r, r);
  ctx.scale(scale, scale);
  ctx.translate(-12, -12);
  ctx.fillStyle = "#ffffff";
  ctx.fill(new Path2D(path));
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

function lineLength(coords: number[][]): number {
  let len = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    len += haversineDistance(coords[i] as LngLat, coords[i + 1] as LngLat);
  }
  return len;
}

function midpointOfLine(coords: number[][]): LngLat | null {
  if (coords.length === 0) return null;
  if (coords.length === 1) return coords[0] as LngLat;
  const half = lineLength(coords) / 2;
  let acc = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i] as LngLat;
    const b = coords[i + 1] as LngLat;
    const seg = haversineDistance(a, b);
    if (acc + seg >= half) {
      const t = seg === 0 ? 0 : (half - acc) / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    acc += seg;
  }
  return coords[coords.length - 1] as LngLat;
}

/**
 * One representative point per incident, so a single marker is placed regardless
 * of geometry: the point itself, the centroid of a MultiPoint's affected points
 * (e.g. the two ends of a "between X and Y" closure), a line's length-midpoint,
 * the longest line of a MultiLineString, a polygon's first vertex, or (for a
 * GeometryCollection) the first member geometry that yields a point.
 */
export function representativePoint(
  // `coordinates` is optional so a real GeoJSON `Geometry` union type-checks
  // here too — its `GeometryCollection` member has no `coordinates` of its
  // own, only nested `geometries`, which the branch below reads separately.
  geometry: { type: string; coordinates?: unknown } | null | undefined,
): LngLat | null {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  if (type === "Point") return coordinates as LngLat;
  if (type === "MultiPoint") {
    const pts = coordinates as LngLat[];
    if (pts.length === 0) return null;
    let sx = 0;
    let sy = 0;
    for (const [x, y] of pts) {
      sx += x;
      sy += y;
    }
    return [sx / pts.length, sy / pts.length];
  }
  if (type === "LineString") return midpointOfLine(coordinates as number[][]);
  if (type === "MultiLineString") {
    let best: number[][] | null = null;
    let bestLen = -1;
    for (const line of coordinates as number[][][]) {
      const len = lineLength(line);
      if (len > bestLen) {
        bestLen = len;
        best = line;
      }
    }
    return best ? midpointOfLine(best) : null;
  }
  if (type === "Polygon") {
    const ring = (coordinates as number[][][])[0];
    return ring && ring.length > 0 ? (ring[0] as LngLat) : null;
  }
  if (type === "MultiPolygon") {
    const ring = (coordinates as number[][][][])[0]?.[0];
    return ring && ring.length > 0 ? (ring[0] as LngLat) : null;
  }
  if (type === "GeometryCollection") {
    const geometries =
      (
        geometry as unknown as {
          geometries?: Array<{ type: string; coordinates: unknown }>;
        }
      ).geometries ?? [];
    for (const g of geometries) {
      const rep = representativePoint(g);
      if (rep) return rep;
    }
    return null;
  }
  return null;
}

/**
 * Marker placement point(s) for one incident: every real endpoint for a
 * MultiPoint, otherwise the single {@link representativePoint}. A MultiPoint
 * from these feeds carries only the endpoints of a linear event ("zwischen X
 * und Y") with NO road path between them — often the two ends of a motorway
 * closure kilometres apart. A marker at each real endpoint reads honestly;
 * `representativePoint`'s centroid for the same geometry is a straight-line
 * average that can land on a curving road's shoulder or off the road
 * entirely, which is why callers that place actual markers must use this
 * instead of calling `representativePoint` directly for a MultiPoint. Shared
 * so every consumer that draws these markers agrees on where an event is.
 */
export function markerPoints(
  geometry: { type: string; coordinates?: unknown } | null | undefined,
): LngLat[] {
  if (
    geometry?.type === "MultiPoint" &&
    Array.isArray(geometry.coordinates) &&
    geometry.coordinates.length > 0
  ) {
    return geometry.coordinates as LngLat[];
  }
  const rep = representativePoint(geometry);
  return rep ? [rep] : [];
}
