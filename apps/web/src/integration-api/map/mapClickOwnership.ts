import { useParkingStore } from "@openmapx/core";

type MapClickOwner = "parking" | "crowd" | "measurement" | "travel-time";
interface Ownership {
  owner: MapClickOwner | null;
  claimed: boolean;
}

const ownership = new WeakMap<object, Ownership>();
let readToolOwner: () => Exclude<MapClickOwner, "parking"> | null = () => null;

/** The map shell supplies integration state; this API stays independent of it. */
export function configureMapClickOwnership(
  resolver: () => Exclude<MapClickOwner, "parking"> | null,
): void {
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
