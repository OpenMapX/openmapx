import { describe, expect, it } from "vitest";
import {
  createOverlayStore,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
  runInOverlayTransaction,
} from "../createOverlayStore";
import {
  getOverlayEntry,
  type OverlayChangeOrigin,
  type OverlayEntry,
  overlayTransactionClosure,
  registerOverlayEntry,
  restoreOverlaySnapshot,
  runOverlayTransaction,
  toggleOverlay,
} from "../overlayRegistry";

// The overlay store/registry map is module-global and entries can't be
// unregistered, so every test uses its own unique overlay ids.
let seq = 0;
function nextId(): string {
  seq += 1;
  return `txn-overlay-${seq}`;
}

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

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

/** Every test here registers its overlays through makeOverlay first, so the
 * entry always exists — this makes that guarantee explicit instead of
 * scattering non-null assertions (or untyped `?.` chains that would let
 * `undefined` silently leak into values the assertions below expect to be
 * real numbers/booleans) through every test. */
function requireEntry(id: string): OverlayEntry {
  const entry = getOverlayEntry(id);
  if (!entry) throw new Error(`test overlay ${id} was not registered`);
  return entry;
}

function requireStore(id: string) {
  const store = getRegisteredOverlayStore(id);
  if (!store) throw new Error(`test overlay ${id} was not registered`);
  return store;
}

const USER: OverlayChangeOrigin = { kind: "user" };
const AUTOMATION: OverlayChangeOrigin = { kind: "automation", owner: "test" };

describe("createOverlayStore userRevision", () => {
  it("bumps on every direct openPanel/closePanel/setLayerVisible call", () => {
    const id = makeOverlay();
    const store = requireStore(id);
    expect(store.getState().userRevision).toBe(0);

    store.getState().openPanel();
    expect(store.getState().userRevision).toBe(1);

    store.getState().setLayerVisible(false);
    expect(store.getState().userRevision).toBe(2);

    store.getState().closePanel();
    expect(store.getState().userRevision).toBe(3);
  });

  it("does not bump for writes made inside runInOverlayTransaction", () => {
    const id = makeOverlay();
    const store = requireStore(id);

    runInOverlayTransaction(() => {
      store.getState().openPanel();
      store.getState().setLayerVisible(false);
      store.getState().closePanel();
    });

    expect(store.getState().userRevision).toBe(0);
  });
});

describe("runOverlayTransaction / toggleOverlay", () => {
  it("returns undefined and does not throw for an unregistered overlay id", () => {
    expect(runOverlayTransaction("does-not-exist", { panelOpen: true }, USER)).toBeUndefined();
    expect(toggleOverlay("does-not-exist", USER)).toBeUndefined();
  });

  it("captures the full exclusion closure and applies the write through the public actions without bumping userRevision", () => {
    const b = makeOverlay();
    const a = makeOverlay([b]);
    requireEntry(b).getState().openPanel(); // peer is on before the transaction (direct call — bumps to revision 1)
    const bRevisionBeforeTransaction = requireEntry(b).getState().userRevision;

    const record = runOverlayTransaction(a, { panelOpen: true }, AUTOMATION);
    expect(record).toBeDefined();
    if (!record) throw new Error("expected a record");
    expect(record.before.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(record.after.map((e) => e.id).sort()).toEqual([a, b].sort());

    expect(requireEntry(a).getState().panelOpen).toBe(true);
    expect(requireEntry(b).getState().panelOpen).toBe(false);
    // The peer was displaced through the transaction, so its revision must
    // stay exactly what it was going in — a later restore has to be able to
    // tell this apart from the user closing it themselves.
    expect(requireEntry(a).getState().userRevision).toBe(0);
    expect(requireEntry(b).getState().userRevision).toBe(bRevisionBeforeTransaction);
  });

  it("a 'user'-origin transaction bumps userRevision on every write it touches — only 'automation' is suppressed", () => {
    const b = makeOverlay();
    const a = makeOverlay([b]);
    requireEntry(b).getState().openPanel(); // peer starts on, direct call — revision 1

    runOverlayTransaction(a, { panelOpen: true }, USER);
    expect(requireEntry(a).getState().panelOpen).toBe(true);
    expect(requireEntry(b).getState().panelOpen).toBe(false);
    // A real person's action (a layer-selector click, a deep link) has to
    // read as user intent on every overlay it touches, target and displaced
    // peer alike — otherwise a later contextual restore can't tell it apart
    // from automation's own writes.
    expect(requireEntry(a).getState().userRevision).toBe(1);
    expect(requireEntry(b).getState().userRevision).toBe(2);
  });

  it("toggleOverlay flips panelOpen and returns a record with an incrementing global revision", () => {
    const id = makeOverlay();
    const first = toggleOverlay(id, USER);
    const second = toggleOverlay(id, USER);
    expect(requireEntry(id).getState().panelOpen).toBe(false);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second?.revision ?? -1).toBeGreaterThan(first?.revision ?? -1);
  });
});

describe("restoreOverlaySnapshot", () => {
  it("restores an entry whose userRevision is unchanged since the snapshot", () => {
    const id = makeOverlay();
    requireEntry(id).getState().openPanel(); // pre-existing "on" state, direct call
    const before = {
      id,
      panelOpen: true,
      layerVisible: true,
      userRevision: requireEntry(id).getState().userRevision,
    };

    runInOverlayTransaction(() => requireEntry(id).getState().closePanel());
    expect(requireEntry(id).getState().panelOpen).toBe(false);

    restoreOverlaySnapshot([before]);
    expect(requireEntry(id).getState().panelOpen).toBe(true);
  });

  it("skips an entry whose userRevision moved — including a direct write that reset the same value", () => {
    const id = makeOverlay();
    const before = { id, panelOpen: true, layerVisible: true, userRevision: 0 };

    // Automation displaces it (suppressed, revision unchanged)...
    runInOverlayTransaction(() => requireEntry(id).getState().closePanel());
    // ...then the user directly re-opens it — same eventual value automation
    // would restore to, but a real, revision-bumping write.
    requireEntry(id).getState().openPanel();
    expect(requireEntry(id).getState().userRevision).toBe(1);

    restoreOverlaySnapshot([before]);
    // Still open — restore must not have run closePanel/openPanel again over
    // the user's write (which would be a no-op here, but the point is that it
    // is SKIPPED, verified by the revision no longer matching being the
    // reason, not a coincidence).
    expect(requireEntry(id).getState().panelOpen).toBe(true);
    expect(requireEntry(id).getState().userRevision).toBe(1);
  });

  it("skips an unregistered id without throwing", () => {
    expect(() =>
      restoreOverlaySnapshot([
        { id: "nope", panelOpen: true, layerVisible: true, userRevision: 0 },
      ]),
    ).not.toThrow();
  });
});

describe("nested exclusion chains", () => {
  it("closes only the direct peer, not a peer's peer, and restores just that closure", () => {
    const c = makeOverlay();
    const b = makeOverlay([c]);
    const a = makeOverlay([b]);

    requireEntry(b).getState().openPanel();
    requireEntry(c).getState().openPanel();

    expect(overlayTransactionClosure(a)).toEqual([a, b]);
    expect(overlayTransactionClosure(b)).toEqual([b, c]);

    const record = runOverlayTransaction(a, { panelOpen: true }, AUTOMATION);
    // A's closure only reaches B — C (B's peer, not A's) is untouched.
    expect(requireEntry(a).getState().panelOpen).toBe(true);
    expect(requireEntry(b).getState().panelOpen).toBe(false);
    expect(requireEntry(c).getState().panelOpen).toBe(true);

    expect(record).toBeDefined();
    if (!record) throw new Error("expected a record");
    restoreOverlaySnapshot(record.before);
    expect(requireEntry(a).getState().panelOpen).toBe(false);
    expect(requireEntry(b).getState().panelOpen).toBe(true);
    expect(requireEntry(c).getState().panelOpen).toBe(true);
  });

  it("capturing B's own transaction reaches its full closure (B and C)", () => {
    const c = makeOverlay();
    const b = makeOverlay([c]);
    requireEntry(c).getState().openPanel();

    const record = runOverlayTransaction(b, { panelOpen: true }, AUTOMATION);
    expect(requireEntry(b).getState().panelOpen).toBe(true);
    expect(requireEntry(c).getState().panelOpen).toBe(false);

    expect(record).toBeDefined();
    if (!record) throw new Error("expected a record");
    restoreOverlaySnapshot(record.before);
    expect(requireEntry(b).getState().panelOpen).toBe(false);
    expect(requireEntry(c).getState().panelOpen).toBe(true);
  });
});

describe("overlay store instance replacement", () => {
  it("restoreOverlaySnapshot resolves the CURRENT instance and never throws across a replacement", () => {
    const id = makeOverlay();
    requireEntry(id).getState().openPanel();
    requireEntry(id).getState().openPanel(); // bump userRevision to a known non-zero value
    const revisionBeforeReplace = requireEntry(id).getState().userRevision;
    expect(revisionBeforeReplace).toBeGreaterThan(0);
    const before = { id, panelOpen: true, layerVisible: true, userRevision: revisionBeforeReplace };

    // Simulate a lazy-loaded map-layer chunk replacing the auto-created store.
    createOverlayStore({ overlayId: id, extra: {} });
    expect(requireEntry(id).getState().userRevision).toBe(0);

    expect(() => restoreOverlaySnapshot([before])).not.toThrow();
    // The fresh instance's revision (0) doesn't match the snapshot's (>0), so
    // the conservative rule applies: an indeterminate state is never assumed
    // to still be automation's to restore.
    expect(requireEntry(id).getState().panelOpen).toBe(false);
  });
});
