// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  createOverlayStore,
  getRegisteredOverlayStore,
  type OverlayStoreBase,
} from "../../stores/createOverlayStore";
import {
  getOverlayEntry,
  type OverlayEntry,
  registerOverlayEntry,
} from "../../stores/overlayRegistry";
import { useOverlayExclusion } from "../useOverlayExclusion";

// The overlay store/registry map is module-global and entries can't be
// unregistered, so every test uses its own unique overlay ids.
let seq = 0;
function nextId(): string {
  seq += 1;
  return `exclusion-hook-overlay-${seq}`;
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

describe("useOverlayExclusion", () => {
  it("closes an open peer when layerVisible flips to true", () => {
    const peer = makeOverlay();
    const target = makeOverlay([peer]);
    requireEntry(peer).getState().openPanel();

    const { rerender } = renderHook(({ visible }) => useOverlayExclusion(target, visible), {
      initialProps: { visible: false },
    });
    expect(requireEntry(peer).getState().panelOpen).toBe(true);

    rerender({ visible: true });
    expect(requireEntry(peer).getState().panelOpen).toBe(false);
  });

  it("is a no-op (never bumps the peer's userRevision) once the peer is already closed — the case right after a contextual-automation transaction already handled it", () => {
    const peer = makeOverlay();
    const target = makeOverlay([peer]);
    const revisionBefore = requireEntry(peer).getState().userRevision;

    const { rerender } = renderHook(({ visible }) => useOverlayExclusion(target, visible), {
      initialProps: { visible: false },
    });
    rerender({ visible: true });

    expect(requireEntry(peer).getState().panelOpen).toBe(false);
    expect(requireEntry(peer).getState().userRevision).toBe(revisionBefore);
  });
});
