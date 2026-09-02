import { useMapStore, useNavigationStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const reduced = { current: false };
vi.mock("@/lib/reducedMotion", () => ({ prefersReducedMotion: () => reduced.current }));

const ctx = { mapRef: { current: null as unknown }, styleVersion: 0 };
vi.mock("@/integration-api/map/MapContext", () => ({ useMapOptional: () => ctx }));

const compute = vi.fn();
vi.mock("./streetGrid", async () => ({
  ...(await vi.importActual<typeof import("./streetGrid")>("./streetGrid")),
  computeStreetGridAlignment: (...args: unknown[]) => compute(...args),
}));

import { clearAlignAnnouncement, useAlignAnnouncement } from "./alignAnnouncement";
import { frameBoundsInstant } from "./cameraFraming";
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
    clearAlignAnnouncement();
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
    act(() => {
      result.current.align();
    });
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

  it("jumps under reduced motion and reports non-ok outcomes without moving", () => {
    reduced.current = true;
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const { result } = renderHook(() => ({
      align: useAlignToStreets().align,
      announcement: useAlignAnnouncement(),
    }));
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
    act(() => {
      result.current.align();
    });
    expect(result.current.announcement?.text).toBe("map.alignNoGrid");
    expect(fake.state.cameraTransitions).toHaveLength(1);
  });

  it.each([
    ["no-grid", "map.alignNoGrid"],
    ["zoomed-out", "map.alignZoomIn"],
    ["aligned", "map.alignAlready"],
  ] as const)("announces %s for whoever asked to align", (status, message) => {
    compute.mockReturnValue({ status });
    const { result } = renderHook(() => ({
      align: useAlignToStreets().align,
      announcement: useAlignAnnouncement(),
    }));
    act(() => {
      result.current.align();
    });
    expect(result.current.announcement?.text).toBe(message);
  });

  it("survives the next framing: a search result lands without straightening the grid", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const { result } = renderHook(() => useAlignToStreets());
    act(() => {
      result.current.align();
    });
    // The fake keeps `bearing` a test-driven input, so land the ease by hand.
    fake.state.bearing = 30;

    frameBoundsInstant(fake.map, [
      [8, 50],
      [8.1, 50.1],
    ]);
    expect(fake.state.cameraTransitions.at(-1)).toMatchObject({
      method: "jumpTo",
      options: { bearing: 30 },
    });
  });

  it("stays silent when the map rotates", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const { result } = renderHook(() => ({
      align: useAlignToStreets().align,
      announcement: useAlignAnnouncement(),
    }));
    act(() => {
      result.current.align();
    });
    expect(result.current.announcement).toBeNull();
  });
});
