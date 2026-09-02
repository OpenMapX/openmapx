import { useMapStore, useNavigationStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";

const reduced = { current: false };
vi.mock("@/lib/reducedMotion", () => ({ prefersReducedMotion: () => reduced.current }));

const ctx = { mapRef: { current: null as unknown }, styleVersion: 0 };
vi.mock("@/integration-api/map/MapContext", () => ({ useMapOptional: () => ctx }));

const compute = vi.fn();
vi.mock("./streetGrid", async () => ({
  ...(await vi.importActual<typeof import("./streetGrid")>("./streetGrid")),
  computeStreetGridAlignment: (...args: unknown[]) => compute(...args),
}));

import { useAlignToStreets } from "./useAlignToStreets";

describe("useAlignToStreets", () => {
  let fake: FakeMap;
  beforeEach(() => {
    fake = createFakeMap({ zoom: 15 });
    ctx.mapRef.current = fake.map;
    useMapStore.setState({ zoom: 15 });
    compute.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    useMapStore.setState({ zoom: 2 });
    useNavigationStore.setState({ status: "idle" });
  });

  it("is available when zoomed in and not navigating", () => {
    const { result, rerender } = renderHook(() => useAlignToStreets());
    expect(result.current.available).toBe(true);
    act(() => useMapStore.setState({ zoom: 12 }));
    rerender();
    expect(result.current.available).toBe(false);
    act(() => useMapStore.setState({ zoom: 15 }));
    act(() => useNavigationStore.setState({ status: "navigating" }));
    rerender();
    expect(result.current.available).toBe(false);
  });

  it("eases to the computed bearing programmatically and memoises per camera key", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const { result } = renderHook(() => useAlignToStreets());
    let status: string | undefined;
    act(() => {
      status = result.current.align();
    });
    expect(status).toBe("ok");
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "easeTo",
      options: { bearing: 30, duration: 300 },
      eventData: { programmatic: true },
    });
    act(() => {
      result.current.align();
    });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("expires the memo a fixed window after the computation, not after the last tap", () => {
    vi.useFakeTimers();
    compute.mockReturnValue({ status: "no-grid" });
    const { result } = renderHook(() => useAlignToStreets());
    act(() => {
      result.current.align();
    });
    vi.advanceTimersByTime(300);
    act(() => {
      result.current.align();
    });
    vi.advanceTimersByTime(699);
    act(() => {
      result.current.align();
    });
    expect(compute).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    act(() => {
      result.current.align();
    });
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("jumps under reduced motion and reports non-ok statuses without moving", () => {
    reduced.current = true;
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const { result } = renderHook(() => useAlignToStreets());
    act(() => {
      result.current.align();
    });
    expect(fake.state.cameraTransitions.at(-1)?.options).toMatchObject({
      bearing: 30,
      duration: 0,
    });
    reduced.current = false;
    compute.mockReturnValue({ status: "no-grid" });
    fake.state.bearing = 5;
    let status: string | undefined;
    act(() => {
      status = result.current.align();
    });
    expect(status).toBe("no-grid");
    expect(fake.state.cameraTransitions).toHaveLength(1);
  });
});
