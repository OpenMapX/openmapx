import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMapObstructionInsets,
  measuredExtent,
  publishMapObstruction,
  subscribeMapObstructions,
  useMapObstruction,
  useMapObstructionInsets,
  useMeasuredMapObstruction,
} from "./mapObstructions";

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  observed: Element[] = [];
  constructor(readonly callback: () => void) {
    ResizeObserverStub.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.observed = [];
  }
}

const ids = ["a", "b", "c", "m"];

describe("map obstruction registry", () => {
  beforeEach(() => vi.stubGlobal("ResizeObserver", ResizeObserverStub));
  afterEach(() => {
    for (const id of ids) publishMapObstruction(id, "left", null);
    ResizeObserverStub.instances = [];
    vi.unstubAllGlobals();
  });

  it("takes the max per edge and drops entries on null, zero, or non-finite", () => {
    publishMapObstruction("a", "left", 400);
    publishMapObstruction("b", "left", 800);
    publishMapObstruction("c", "top", 72);
    expect(getMapObstructionInsets()).toEqual({ top: 72, bottom: 0, left: 800, right: 0 });
    publishMapObstruction("b", "left", null);
    expect(getMapObstructionInsets().left).toBe(400);
    publishMapObstruction("a", "left", Number.NaN);
    publishMapObstruction("c", "top", 0);
    expect(getMapObstructionInsets()).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });

  it("notifies subscribers only when the effective insets change", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMapObstructions(listener);
    publishMapObstruction("a", "left", 400);
    publishMapObstruction("a", "left", 400);
    publishMapObstruction("b", "left", 100);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("registers through the declarative hook and removes on unmount", () => {
    const { result, rerender, unmount } = renderHook(
      ({ px }: { px: number | null }) => {
        useMapObstruction("a", "bottom", px);
        return useMapObstructionInsets();
      },
      { initialProps: { px: 300 as number | null } },
    );
    expect(result.current.bottom).toBe(300);
    rerender({ px: null });
    expect(result.current.bottom).toBe(0);
    rerender({ px: 120 });
    expect(result.current.bottom).toBe(120);
    unmount();
    expect(getMapObstructionInsets().bottom).toBe(0);
  });

  it("measures an element's extent from its edge and follows resizes", () => {
    vi.stubGlobal("innerWidth", 1000);
    vi.stubGlobal("innerHeight", 800);
    const el = document.createElement("div");
    const rect = { top: 12, bottom: 68, left: 12, right: 388 };
    el.getBoundingClientRect = () => rect as DOMRect;
    const { unmount } = renderHook(() => useMeasuredMapObstruction("m", "top", el));
    expect(getMapObstructionInsets().top).toBe(68);
    rect.bottom = 112;
    const ro = ResizeObserverStub.instances.find((i) => i.observed.includes(el));
    act(() => ro?.callback());
    expect(getMapObstructionInsets().top).toBe(112);
    unmount();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("computes measured extents per edge", () => {
    const rect = { top: 600, bottom: 800, left: 900, right: 1000 };
    const viewport = { width: 1000, height: 800 };
    expect(measuredExtent("top", rect, viewport)).toBe(800);
    expect(measuredExtent("bottom", rect, viewport)).toBe(200);
    expect(measuredExtent("left", rect, viewport)).toBe(1000);
    expect(measuredExtent("right", rect, viewport)).toBe(100);
  });
});
