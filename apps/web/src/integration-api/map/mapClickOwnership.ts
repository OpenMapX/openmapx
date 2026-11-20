import { useParkingStore } from "@openmapx/core";

/**
 * `marker`: a DOM marker took the click; see `bindMapMarkerActivation`.
 * `custom-content`: content drawn by a custom layer (3D models) is under the
 * pointer; see `registerCustomMapHitTester`.
 */
type MapClickOwner =
  | "parking"
  | "crowd"
  | "measurement"
  | "travel-time"
  | "marker"
  | "custom-content";
type ModeOwner = Exclude<MapClickOwner, "parking" | "marker" | "custom-content">;

/** Point in map canvas pixels, as on a MapLibre mouse event. */
interface CanvasPoint {
  x: number;
  y: number;
}

const customHitTesters = new WeakMap<object, Map<string, (point: CanvasPoint) => boolean>>();

/**
 * Custom layers are invisible to `queryRenderedFeatures`, and the map's own
 * click handlers may run before a lazily loaded layer's. A layer registers a
 * tester here; when it reports a hit, the click is owned by `custom-content`
 * from the first moment any handler asks, so pins and POI cards stay away.
 */
export function registerCustomMapHitTester(
  map: object,
  id: string,
  hit: (point: CanvasPoint) => boolean,
): () => void {
  let testers = customHitTesters.get(map);
  if (!testers) {
    testers = new Map();
    customHitTesters.set(map, testers);
  }
  testers.set(id, hit);
  return () => {
    if (customHitTesters.get(map)?.get(id) === hit) customHitTesters.get(map)?.delete(id);
  };
}

function hitsCustomContent(event: object): boolean {
  const target = "target" in event ? event.target : undefined;
  const point = "point" in event ? (event.point as CanvasPoint | undefined) : undefined;
  if (!target || typeof target !== "object" || !point) return false;
  for (const hit of customHitTesters.get(target)?.values() ?? []) {
    try {
      if (hit(point)) return true;
    } catch {
      // A failing tester must not break the map's click handling.
    }
  }
  return false;
}
interface Ownership {
  owner: MapClickOwner | null;
  claimed: boolean;
}

const ownership = new WeakMap<object, Ownership>();
let readToolOwner: () => ModeOwner | null = () => null;

/** The map shell supplies integration state; this API stays independent of it. */
export function configureMapClickOwnership(resolver: () => ModeOwner | null): void {
  readToolOwner = resolver;
}

function getOwnership(event: object): Ownership {
  // Global/delegated MapLibre events and native marker callbacks share the
  // original DOM event, even when a listener receives a different wrapper.
  const originalEvent = "originalEvent" in event ? event.originalEvent : undefined;
  const key = originalEvent && typeof originalEvent === "object" ? originalEvent : event;
  const existing = ownership.get(key);
  if (existing) return existing;

  let owner: MapClickOwner | null = useParkingStore.getState().picking
    ? "parking"
    : readToolOwner();
  if (!owner && hitsCustomContent(event)) owner = "custom-content";
  const captured = { owner, claimed: owner === "custom-content" };
  ownership.set(key, captured);
  return captured;
}

/** Freeze ownership before any listener can capture a point and clear its mode. */
export function getMapClickOwner(event: object): MapClickOwner | null {
  return getOwnership(event).owner;
}

/** Only the owning picker/tool may mutate coordinates, once per physical click. */
export function claimMapClick(event: object, owner: MapClickOwner): boolean {
  const captured = getOwnership(event);
  if (captured.owner !== owner || captured.claimed) return false;
  captured.claimed = true;
  return true;
}

/**
 * A DOM marker takes a click no picker or tool owns. Every map click handler
 * then sees an owner and leaves the click alone, while listeners outside the
 * map (click-away dismissal) still receive it.
 */
export function claimMapClickForMarker(event: object): boolean {
  const captured = getOwnership(event);
  if (captured.owner) return false;
  captured.owner = "marker";
  captured.claimed = true;
  return true;
}
