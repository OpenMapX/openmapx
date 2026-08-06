import { describe, expect, it } from "vitest";
import {
  createOverlayStore,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
} from "../createOverlayStore";
import {
  getOverlayEntry,
  type OverlayChangeOrigin,
  type OverlayEntry,
  registerOverlayEntry,
  setOverlayLayerVisible,
} from "../overlayRegistry";

// The overlay store/registry map is module-global and entries can't be
// unregistered, so every test uses its own unique overlay ids.
let seq = 0;
function nextId(): string {
  seq += 1;
  return `visibility-setter-overlay-${seq}`;
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

const USER: OverlayChangeOrigin = { kind: "user" };
const AUTOMATION: OverlayChangeOrigin = { kind: "automation", owner: "test" };

describe("setOverlayLayerVisible", () => {
  it("returns undefined and does not throw for an unregistered overlay id", () => {
    expect(setOverlayLayerVisible("does-not-exist", true, USER)).toBeUndefined();
  });

  it("bumps userRevision for a 'user' origin write", () => {
    const id = makeOverlay();
    const before = requireEntry(id).getState().userRevision;

    setOverlayLayerVisible(id, true, USER);

    expect(requireEntry(id).getState().layerVisible).toBe(true);
    expect(requireEntry(id).getState().userRevision).toBe(before + 1);
  });

  it("does not bump userRevision for an 'automation' origin write", () => {
    const id = makeOverlay();
    const before = requireEntry(id).getState().userRevision;

    setOverlayLayerVisible(id, true, AUTOMATION);

    expect(requireEntry(id).getState().layerVisible).toBe(true);
    expect(requireEntry(id).getState().userRevision).toBe(before);
  });

  it("does not change panelOpen", () => {
    const id = makeOverlay();
    expect(requireEntry(id).getState().panelOpen).toBe(false);

    setOverlayLayerVisible(id, true, USER);
    expect(requireEntry(id).getState().panelOpen).toBe(false);

    requireEntry(id).getState().openPanel();
    setOverlayLayerVisible(id, false, USER);
    expect(requireEntry(id).getState().panelOpen).toBe(true);
  });

  it("does not close exclusion peers — the pure-refactor guarantee", () => {
    const peer = makeOverlay();
    const target = makeOverlay([peer]);
    requireEntry(peer).getState().openPanel();
    expect(requireEntry(peer).getState().panelOpen).toBe(true);

    setOverlayLayerVisible(target, true, USER);

    expect(requireEntry(target).getState().layerVisible).toBe(true);
    expect(requireEntry(peer).getState().panelOpen).toBe(true);
  });

  it("returns a record whose before/after reflect the change", () => {
    const id = makeOverlay();
    const record = setOverlayLayerVisible(id, true, USER);

    expect(record).toBeDefined();
    if (!record) throw new Error("expected a record");
    expect(record.targetId).toBe(id);
    expect(record.origin).toEqual(USER);
    const beforeEntry = record.before.find((e) => e.id === id);
    const afterEntry = record.after.find((e) => e.id === id);
    expect(beforeEntry?.layerVisible).toBe(false);
    expect(afterEntry?.layerVisible).toBe(true);
  });
});
