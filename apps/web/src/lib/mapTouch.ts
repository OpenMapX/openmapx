import type * as maplibregl from "maplibre-gl";

/** How long a finger has to rest on the map before it counts as a long-press. */
export const LONG_PRESS_MS = 500;
/** How far it may wander meanwhile — farther is a pan. */
const LONG_PRESS_TOLERANCE_PX = 10;
/** A click this soon after a touch came from that touch, whatever the browser reports. */
const TOUCH_CLICK_WINDOW_MS = 1000;

let lastTouchAt = Number.NEGATIVE_INFINITY;
/** Fingers on the screen right now. */
let touchesDown = 0;
/** Whether the finger still down has already made a long-press. */
let longPressHeld = false;
/** When the finger of the last long-press lifted. */
let longPressReleasedAt = Number.NEGATIVE_INFINITY;

function noteTouches(event: TouchEvent): void {
  lastTouchAt = performance.now();
  touchesDown = event.touches.length;
}

// Page-wide, so any code asking `cameFromTouch` sees every touch, whichever
// component is mounted; capturing, so the count is current for the map's own
// listeners. Never removed: the page lives as long as they do.
if (typeof window !== "undefined") {
  for (const type of ["touchstart", "touchend", "touchcancel"] as const) {
    window.addEventListener(type, noteTouches, { capture: true, passive: true });
  }
}

/**
 * Whether a map click or context-menu event came from a finger. Chrome and
 * Firefox say so on the event itself. Safari does not, and neither does the
 * `contextmenu` MapLibre makes up for a touch long-press (a plain MouseEvent),
 * so a finger on the screen, or one that just lifted, is taken as the source too.
 */
export function cameFromTouch(event: unknown): boolean {
  const pointerEvent = event as
    | { pointerType?: string; sourceCapabilities?: { firesTouchEvents?: boolean } | null }
    | undefined;
  if (pointerEvent?.pointerType === "touch") return true;
  if (pointerEvent?.sourceCapabilities?.firesTouchEvents === true) return true;
  return touchesDown > 0 || performance.now() - lastTouchAt < TOUCH_CLICK_WINDOW_MS;
}

/** Forgets every touch seen so far, as a fresh page would. */
export function resetMapTouchForTests(): void {
  lastTouchAt = Number.NEGATIVE_INFINITY;
  touchesDown = 0;
  longPressHeld = false;
  longPressReleasedAt = Number.NEGATIVE_INFINITY;
}

/**
 * Whether this click is the one some browsers (iOS Safari among them) still
 * fire when the finger of a long-press lifts — however long it was held, as
 * the window opens at the lift. Consumes it, so a later click goes through.
 * A new touch closes the window: its click is a tap of its own.
 */
export function consumeLongPressClick(): boolean {
  const pending = longPressHeld || performance.now() - longPressReleasedAt < TOUCH_CLICK_WINDOW_MS;
  longPressHeld = false;
  longPressReleasedAt = Number.NEGATIVE_INFINITY;
  return pending;
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
    if (event.touches.length === 1) {
      longPressHeld = false;
      longPressReleasedAt = Number.NEGATIVE_INFINITY;
    }
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
      longPressHeld = true;
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

  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length === 0 && longPressHeld) {
      longPressHeld = false;
      longPressReleasedAt = performance.now();
    }
    cancel();
  };

  container.addEventListener("touchstart", onTouchStart, { passive: true });
  container.addEventListener("touchmove", onTouchMove, { passive: true });
  container.addEventListener("touchend", onTouchEnd, { passive: true });
  container.addEventListener("touchcancel", onTouchEnd, { passive: true });
  return () => {
    cancel();
    longPressHeld = false;
    container.removeEventListener("touchstart", onTouchStart);
    container.removeEventListener("touchmove", onTouchMove);
    container.removeEventListener("touchend", onTouchEnd);
    container.removeEventListener("touchcancel", onTouchEnd);
  };
}
