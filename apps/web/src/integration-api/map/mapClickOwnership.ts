import { useParkingStore } from "@openmapx/core";

/** `marker`: a DOM marker took the click; see `bindMapMarkerActivation`. */
type MapClickOwner = "parking" | "crowd" | "measurement" | "travel-time" | "marker";
type ModeOwner = Exclude<MapClickOwner, "parking" | "marker">;
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

  const owner: MapClickOwner | null = useParkingStore.getState().picking
    ? "parking"
    : readToolOwner();
  const captured = { owner, claimed: false };
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
