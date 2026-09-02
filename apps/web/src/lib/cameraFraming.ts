import type { LngLat } from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { getCameraPaddingTarget, type ResolvedPadding } from "./cameraPadding";

export type MapBounds = [[number, number], [number, number]];
export type InnerPadding = number | maplibregl.PaddingOptions;

/** Breathing room left inside the visible strip when a caller does not ask for more. */
export const DEFAULT_INNER_PADDING = 80;
/** A request this young is simply re-issued; older ones ease over what is left. */
const RETARGET_FRESH_MS = 100;
const RETARGET_MIN_MS = 300;
/** How long past its own duration a request stays worth retargeting. */
const REQUEST_STALE_SLACK_MS = 100;
/**
 * An instant request has no duration to age against, so it carries its own
 * window: long enough for chrome opening alongside the framing to register and
 * be framed against, short enough that a panel opened later re-frames nothing.
 */
const INSTANT_REQUEST_WINDOW_MS = 300;

const REQUEST_EVENT_DATA = { programmatic: true, cameraRequest: true };

interface RequestBase {
  duration: number;
  startedAt: number;
  /** The padding target the request was issued against. */
  padding: ResolvedPadding;
}

export type CameraRequest =
  | (RequestBase & { kind: "flyTo"; center: LngLat; zoom?: number })
  | (RequestBase & {
      kind: "fitBounds";
      bounds: MapBounds;
      inner: ResolvedPadding;
      maxZoom?: number;
    });

export interface CameraTarget {
  center: LngLat;
  zoom?: number;
  bearing?: number;
}

/** Drops `undefined` members: MapLibre treats `'bearing' in options` as a request. */
export function compact<T extends object>(options: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function toInsets(padding: InnerPadding | undefined, fallback: number): ResolvedPadding {
  if (typeof padding === "number") {
    return { top: padding, bottom: padding, left: padding, right: padding };
  }
  if (!padding) return { top: fallback, bottom: fallback, left: fallback, right: fallback };
  return {
    top: padding.top ?? 0,
    bottom: padding.bottom ?? 0,
    left: padding.left ?? 0,
    right: padding.right ?? 0,
  };
}

function toLngLat(value: maplibregl.LngLatLike): LngLat {
  if (Array.isArray(value)) return [value[0], value[1]];
  if ("lng" in value) return [value.lng, value.lat];
  return [value.lon, value.lat];
}

/**
 * Scales one axis' breathing room down until the framed box keeps a positive
 * extent. MapLibre derives the zoom from `visible - inner` and bails on a
 * non-positive width, which a narrow phone plus a wide panel can produce.
 */
function fitInner(near: number, far: number, visible: number): [number, number] {
  const total = near + far;
  const budget = Math.max(0, visible - 1);
  if (total <= budget || total === 0) return [near, far];
  const scale = budget / total;
  return [near * scale, far * scale];
}

/**
 * The camera a request resolves to when the map carries the request's padding
 * target. `cameraForBounds` measures against the map's *current* padding, so
 * the inner breathing room carries the difference to the target — negative
 * where the target is the smaller of the two, which is exactly what a closing
 * panel needs.
 */
export function cameraForRequest(map: maplibregl.Map, request: CameraRequest): CameraTarget | null {
  if (request.kind === "flyTo") return compact({ center: request.center, zoom: request.zoom });
  const target = request.padding;
  const current = map.getPadding();
  const container = map.getContainer();
  const [left, right] = fitInner(
    request.inner.left,
    request.inner.right,
    container.clientWidth - target.left - target.right,
  );
  const [top, bottom] = fitInner(
    request.inner.top,
    request.inner.bottom,
    container.clientHeight - target.top - target.bottom,
  );
  const padding: ResolvedPadding = {
    top: top + target.top - (current.top ?? 0),
    bottom: bottom + target.bottom - (current.bottom ?? 0),
    left: left + target.left - (current.left ?? 0),
    right: right + target.right - (current.right ?? 0),
  };
  // MapLibre centres the box on the asymmetry of the padding it is handed, but
  // only the inner asymmetry belongs there — the target half is already carried
  // by the camera's own centre offset, and counting it twice pushes the box off
  // the visible strip. `offset` cancels the excess, in screen pixels: framing
  // resolves at bearing 0, so no rotation stands between the two.
  const offset: [number, number] = [
    (left - right - (padding.left - padding.right)) / 2,
    (top - bottom - (padding.top - padding.bottom)) / 2,
  ];
  const camera = map.cameraForBounds(
    request.bounds,
    compact({ padding, offset, maxZoom: request.maxZoom }),
  );
  if (!camera?.center) return null;
  return compact({ center: toLngLat(camera.center), zoom: camera.zoom, bearing: camera.bearing });
}

interface FramingState {
  request: CameraRequest | null;
  lastInstantAt: number;
}

// Kept here rather than on the map context, which integrations consume and
// could null or corrupt, and keyed per map so a replaced map cannot leak.
const framingStates = new WeakMap<maplibregl.Map, FramingState>();

function framingState(map: maplibregl.Map): FramingState {
  const existing = framingStates.get(map);
  if (existing) return existing;
  const created: FramingState = { request: null, lastInstantAt: Number.NEGATIVE_INFINITY };
  framingStates.set(map, created);
  return created;
}

function retargetWindow(request: CameraRequest): number {
  if (request.duration === 0) return INSTANT_REQUEST_WINDOW_MS;
  return request.duration + REQUEST_STALE_SLACK_MS;
}

/** The framing request still worth retargeting on `map`, or null. */
export function activeCameraRequest(map: maplibregl.Map): CameraRequest | null {
  const state = framingStates.get(map);
  const request = state?.request;
  if (!state || !request) return null;
  if (performance.now() - request.startedAt > retargetWindow(request)) {
    state.request = null;
    return null;
  }
  return request;
}

export function clearCameraRequest(map: maplibregl.Map): void {
  const state = framingStates.get(map);
  if (state) state.request = null;
}

/** `performance.now()` of the last instant (duration 0) framing request. */
export function lastInstantRequestAt(map: maplibregl.Map): number {
  return framingStates.get(map)?.lastInstantAt ?? Number.NEGATIVE_INFINITY;
}

/**
 * Moves the camera for `request`, carrying its padding target. The
 * `programmatic` event data marks these as app-driven moves (not user
 * gestures) so map-move listeners such as explore auto-refresh can ignore them.
 */
export function issueCameraRequest(
  map: maplibregl.Map,
  request: CameraRequest,
  method: "flyTo" | "easeTo" = "flyTo",
): void {
  const camera = cameraForRequest(map, request);
  if (!camera) return;
  const state = framingState(map);
  const options = compact({ ...camera, padding: request.padding });
  if (request.duration === 0) {
    // Stamped first: `jumpTo` fires `moveend` synchronously, and the padding
    // sync reads this while handling it.
    state.lastInstantAt = performance.now();
    map.jumpTo(options, REQUEST_EVENT_DATA);
    // Kept on record like a timed request, and for the same reason: chrome
    // registering just after the jump has to re-frame these bounds against the
    // new visible strip, not merely shift where the centre is drawn.
    state.request = request;
    return;
  }
  const animation = { ...options, duration: request.duration };
  if (method === "easeTo") map.easeTo(animation, REQUEST_EVENT_DATA);
  else map.flyTo(animation, REQUEST_EVENT_DATA);
  // Recorded only once the call returns: starting an animation stops whatever
  // was running and fires a synchronous `moveend`, whose handler clears this.
  state.request = request;
}

/** Continues `request` toward `padding` from wherever the camera is now. */
export function retargetCameraRequest(
  map: maplibregl.Map,
  request: CameraRequest,
  padding: ResolvedPadding,
): void {
  // An instant framing re-frames instantly, however late: the caller asked for
  // no animation. Its original `startedAt` rides along, so the retargetable
  // window closes on the framing itself instead of being pushed out by each
  // retarget.
  if (request.duration === 0) {
    issueCameraRequest(map, { ...request, padding });
    return;
  }
  const now = performance.now();
  const elapsed = now - request.startedAt;
  if (elapsed < RETARGET_FRESH_MS) {
    issueCameraRequest(map, { ...request, padding, startedAt: now }, "flyTo");
    return;
  }
  const duration = Math.max(RETARGET_MIN_MS, request.duration - elapsed);
  issueCameraRequest(map, { ...request, padding, startedAt: now, duration }, "easeTo");
}

/** Frames `bounds` instantly in the visible viewport (deep links, explore launches). */
export function frameBoundsInstant(
  map: maplibregl.Map,
  bounds: MapBounds,
  inner?: InnerPadding,
  maxZoom?: number,
): void {
  issueCameraRequest(map, {
    kind: "fitBounds",
    bounds,
    inner: toInsets(inner, DEFAULT_INNER_PADDING),
    maxZoom,
    duration: 0,
    startedAt: performance.now(),
    padding: getCameraPaddingTarget(map),
  });
}

/** Sets the view instantly while keeping the visible-viewport padding. */
export function jumpToView(
  map: maplibregl.Map,
  view: { center: LngLat; zoom?: number; bearing?: number; pitch?: number },
): void {
  const state = framingState(map);
  state.request = null;
  state.lastInstantAt = performance.now();
  map.jumpTo(compact({ ...view, padding: getCameraPaddingTarget(map) }), REQUEST_EVENT_DATA);
}
