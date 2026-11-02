import type * as maplibregl from "maplibre-gl";

/** How long a finger has to rest on the map before it counts as a long-press. */
export const LONG_PRESS_MS = 500;
/** How far it may wander meanwhile — farther is a pan. */
const LONG_PRESS_TOLERANCE_PX = 10;
/** A click this soon after a touch came from that touch, whatever the browser reports. */
const TOUCH_CLICK_WINDOW_MS = 1000;

let lastTouchAt = Number.NEGATIVE_INFINITY;
let lastLongPressAt = Number.NEGATIVE_INFINITY;

/**
 * Whether a map click came from a finger. Chrome and Firefox say so on the
 * click itself; Safari does not, so a touch that just happened on the map is
 * taken as the source too.
 */
export function isTouchClick(event: unknown): boolean {
  const pointerEvent = event as
    | { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } }
    | undefined;
  if (pointerEvent?.pointerType === "touch") return true;
  if (pointerEvent?.sourceCapabilities?.firesTouchEvents === true) return true;
  return performance.now() - lastTouchAt < TOUCH_CLICK_WINDOW_MS;
}

/**
 * Whether this click is the one some browsers still fire when the finger of a
 * long-press lifts. Consumes the long-press, so a later click goes through.
 */
export function consumeLongPressClick(): boolean {
  const recent = performance.now() - lastLongPressAt < TOUCH_CLICK_WINDOW_MS;
  lastLongPressAt = Number.NEGATIVE_INFINITY;
  return recent;
}

/**
 * Calls `onLongPress` when one finger rests still on the map canvas for
 * `LONG_PRESS_MS`. A second finger, moving away, lifting, or starting on a
 * marker or control above the canvas cancels it. The press event itself is
 * passed along so map-click ownership can be checked against it.
 */
export function bindMapLongPress(
  map: maplibregl.Map,
  onLongPress: (lngLat: [number, number], event: TouchEvent) => void,
): () => void {
  const container = map.getCanvasContainer();
  const canvas = map.getCanvas();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number } | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    start = null;
  };

  const onTouchStart = (event: TouchEvent) => {
    lastTouchAt = performance.now();
    cancel();
    if (event.touches.length !== 1 || event.target !== canvas) return;
    const touch = event.touches[0];
    start = { x: touch.clientX, y: touch.clientY };
    timer = setTimeout(() => {
      timer = null;
      if (!start) return;
      const rect = canvas.getBoundingClientRect();
      const lngLat = map.unproject([start.x - rect.left, start.y - rect.top]);
      start = null;
      lastLongPressAt = performance.now();
      onLongPress([lngLat.lng, lngLat.lat], event);
    }, LONG_PRESS_MS);
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!start) return;
    const touch = event.touches[0];
    if (
      event.touches.length !== 1 ||
      !touch ||
      Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > LONG_PRESS_TOLERANCE_PX
    ) {
      cancel();
    }
  };

  const onTouchEnd = () => {
    lastTouchAt = performance.now();
    cancel();
  };

  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: true });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    cancel();
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
  };
}
