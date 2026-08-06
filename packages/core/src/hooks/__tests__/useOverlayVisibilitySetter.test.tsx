// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
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
import { useOverlayVisibilitySetter } from "../useOverlayVisibilitySetter";

// The overlay store/registry map is module-global and entries can't be
// unregistered, so every test uses its own unique overlay ids.
let seq = 0;
function nextId(): string {
  seq += 1;
  return `visibility-setter-hook-overlay-${seq}`;
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

function requireEntry(id: string): OverlayEntry {
  const entry = getOverlayEntry(id);
  if (!entry) throw new Error(`test overlay ${id} was not registered`);
  return entry;
}

describe("useOverlayVisibilitySetter", () => {
  it("sets layerVisible through a user-origin write without touching panelOpen", () => {
    const id = makeOverlay();
    const { result } = renderHook(() => useOverlayVisibilitySetter(id));

    act(() => {
      result.current(true);
    });

    expect(requireEntry(id).getState().layerVisible).toBe(true);
    expect(requireEntry(id).getState().panelOpen).toBe(false);
    expect(requireEntry(id).getState().userRevision).toBe(1);
  });

  it("does not close exclusion peers", () => {
    const peer = makeOverlay();
    const target = makeOverlay([peer]);
    requireEntry(peer).getState().openPanel();

    const { result } = renderHook(() => useOverlayVisibilitySetter(target));
    act(() => {
      result.current(true);
    });

    expect(requireEntry(peer).getState().panelOpen).toBe(true);
  });

  it("is a safe no-op for an unregistered overlay id", () => {
    const { result } = renderHook(() => useOverlayVisibilitySetter("nope-not-registered"));
    expect(() => {
      act(() => {
        result.current(true);
      });
    }).not.toThrow();
  });

  it("returns a stable callback across rerenders for the same overlayId", () => {
    const id = makeOverlay();
    const { result, rerender } = renderHook(() => useOverlayVisibilitySetter(id));
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
