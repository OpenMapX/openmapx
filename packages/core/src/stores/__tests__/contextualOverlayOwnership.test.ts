import { describe, expect, it } from "vitest";
import { createContextualOverlayOwnership } from "../contextualOverlayOwnership";
import {
  createOverlayStore,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
} from "../createOverlayStore";
import { getOverlayEntry, type OverlayEntry, registerOverlayEntry } from "../overlayRegistry";

let seq = 0;
function nextId(): string {
  seq += 1;
  return `owner-overlay-${seq}`;
}

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

function makeOverlay(excludes: string[] = []): string {
  const id = nextId();
  createOverlayStore({ overlayId: id, extra: {} });
  registerOverlayEntry({
    id,
    getState: () => getRegisteredOverlayStore(id)?.getState() ?? FALLBACK,
    useActive: () => false,
    excludes,
  });
  return id;
}

/** Every test here registers its overlays through makeOverlay first, so the
 * entry always exists. */
function requireEntry(id: string): OverlayEntry {
  const entry = getOverlayEntry(id);
  if (!entry) throw new Error(`test overlay ${id} was not registered`);
  return entry;
}

function isActive(id: string): boolean {
  const state = requireEntry(id).getState();
  return state.panelOpen && state.layerVisible;
}

describe("createContextualOverlayOwnership", () => {
  it("opens the overlay on first acquire and restores it on the matching release", () => {
    const ownership = createContextualOverlayOwnership("session-a");
    const id = makeOverlay();

    ownership.acquire(id, "owner-1");
    expect(isActive(id)).toBe(true);

    ownership.release(id, "owner-1");
    expect(isActive(id)).toBe(false);
  });

  it("two owners on one overlay: the first release does not restore, only the last does", () => {
    const ownership = createContextualOverlayOwnership("session-b");
    const id = makeOverlay();

    ownership.acquire(id, "owner-1");
    ownership.acquire(id, "owner-2");
    expect(isActive(id)).toBe(true);

    ownership.release(id, "owner-1");
    expect(isActive(id)).toBe(true);

    ownership.release(id, "owner-2");
    expect(isActive(id)).toBe(false);
  });

  it("a second acquire while already held does not re-snapshot — a direct write to the peer in between still wins at release", () => {
    const ownership = createContextualOverlayOwnership("session-c");
    const peer = makeOverlay();
    const id = makeOverlay([peer]);
    requireEntry(peer).getState().openPanel(); // peer starts on, direct call

    ownership.acquire(id, "owner-1");
    expect(isActive(peer)).toBe(false); // displaced; snapshot says "was on"

    // A direct write lands on the peer while a second owner still holds `id`
    // — opened, then explicitly closed again, landing on the OPPOSITE of what
    // the stale snapshot ("was on") would restore.
    requireEntry(peer).getState().openPanel();
    ownership.acquire(id, "owner-2");
    requireEntry(peer).getState().closePanel();

    ownership.release(id, "owner-1");
    expect(isActive(peer)).toBe(false); // untouched — still owned by owner-2

    ownership.release(id, "owner-2");
    // The peer's userRevision moved after the original snapshot was taken, so
    // the direct write — not the stale "was on" snapshot — wins.
    expect(isActive(peer)).toBe(false);
  });

  it("releaseAll restores every currently held overlay for every owner", () => {
    const ownership = createContextualOverlayOwnership("session-d");
    const first = makeOverlay();
    const second = makeOverlay();

    ownership.acquire(first, "owner-1");
    ownership.acquire(second, "owner-1");
    expect(isActive(first)).toBe(true);
    expect(isActive(second)).toBe(true);

    ownership.releaseAll();
    expect(isActive(first)).toBe(false);
    expect(isActive(second)).toBe(false);
  });

  it("acquiring and releasing an unregistered overlay id is a no-op, not a throw", () => {
    const ownership = createContextualOverlayOwnership("session-e");
    expect(() => ownership.acquire("does-not-exist", "owner-1")).not.toThrow();
    expect(() => ownership.release("does-not-exist", "owner-1")).not.toThrow();
  });
});
