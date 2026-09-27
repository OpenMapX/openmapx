import { useMapStore, useNavigationStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const reduced = { current: false };
vi.mock("@/lib/reducedMotion", () => ({ prefersReducedMotion: () => reduced.current }));

const ctx = { mapRef: { current: null as unknown }, mapReady: true, styleVersion: 0 };
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
    vi.useFakeTimers();
    fake = createFakeMap({ zoom: 15 });
    fake.map.addLayer({
      id: "road",
      type: "line",
      source: "roads",
      "source-layer": "transportation",
    });
    ctx.mapRef.current = fake.map;
    ctx.mapReady = true;
    ctx.styleVersion = 0;
    useMapStore.setState({ zoom: 15 });
    compute.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearAlignAnnouncement();
    useMapStore.setState({ zoom: 2 });
    useNavigationStore.setState({ status: "idle" });
  });

  it("hides until a settled probe finds a grid, then gates on zoom and navigation", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const { result, rerender } = renderHook(() => useAlignToStreets());
    expect(result.current.available).toBe(false);
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.available).toBe(true);
    act(() => useMapStore.setState({ zoom: 12 }));
    rerender();
    expect(result.current.available).toBe(false);
    act(() => useMapStore.setState({ zoom: 15 }));
    act(() => useNavigationStore.setState({ status: "navigating" }));
    rerender();
    expect(result.current.available).toBe(false);
  });

  it("tracks no-grid, late road tiles, and a later no-grid view without probing on render or unrelated idle", () => {
    compute.mockReturnValue({ status: "no-grid" });
    const { result } = renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.available).toBe(false);
    expect(compute).toHaveBeenCalledTimes(1);
    act(() => fake.emit("idle"));
    act(() => vi.advanceTimersByTime(0));
    expect(compute).toHaveBeenCalledTimes(1);

    compute.mockReturnValue({ status: "aligned" });
    act(() => fake.emit("sourcedata", { dataType: "source", sourceId: "roads" }));
    act(() => fake.emit("idle"));
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.available).toBe(true);
    expect(compute).toHaveBeenCalledTimes(2);

    compute.mockReturnValue({ status: "no-grid" });
    fake.state.center.lng = 1;
    act(() => fake.emit("moveend"));
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.available).toBe(false);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("does not inspect style or probe for unrelated source updates", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const getStyle = vi.spyOn(fake.map, "getStyle");
    renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    const reads = getStyle.mock.calls.length;
    act(() => {
      for (let i = 0; i < 10; i += 1) {
        fake.emit("sourcedata", { dataType: "source", sourceId: "overlay" });
        fake.emit("idle");
      }
    });
    act(() => vi.advanceTimersByTime(0));
    expect(getStyle).toHaveBeenCalledTimes(reads);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("probes changed pitch or padding after settling", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    fake.state.pitch = 20;
    act(() => fake.emit("moveend"));
    act(() => vi.advanceTimersByTime(0));
    fake.state.padding = { top: 0, right: 40, bottom: 0, left: 0 };
    act(() => fake.emit("moveend"));
    act(() => vi.advanceTimersByTime(0));
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it("shares one sample and listeners across consumers and cleans up after the last", () => {
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const first = renderHook(() => useAlignToStreets());
    const second = renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    expect(first.result.current.available).toBe(true);
    expect(second.result.current.available).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(fake.state.handlers.get("moveend")?.size).toBe(1);
    first.unmount();
    expect(fake.state.handlers.get("moveend")?.size).toBe(1);
    second.unmount();
    expect(fake.state.handlers.get("moveend")?.size).toBe(0);
    expect(fake.state.handlers.get("sourcedata")?.size).toBe(0);
    expect(fake.state.handlers.get("idle")?.size).toBe(0);
  });

  it("keeps availability after a move that lands on the same sampling key", () => {
    compute.mockReturnValue({ status: "aligned" });
    const { result } = renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.available).toBe(true);
    act(() => {
      fake.emit("movestart");
      fake.emit("moveend");
    });
    act(() => vi.advanceTimersByTime(0));
    expect(result.current.available).toBe(true);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("waits for readiness and invalidates on style reload", () => {
    ctx.mapReady = false;
    compute.mockReturnValue({ status: "ok", bearing: 30 });
    const view = renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    expect(compute).not.toHaveBeenCalled();
    ctx.mapReady = true;
    view.rerender();
    act(() => vi.advanceTimersByTime(0));
    expect(view.result.current.available).toBe(true);
    ctx.styleVersion = 1;
    compute.mockReturnValue({ status: "no-grid" });
    view.rerender();
    expect(view.result.current.available).toBe(false);
    act(() => vi.advanceTimersByTime(0));
    expect(view.result.current.available).toBe(false);
    expect(compute).toHaveBeenCalledTimes(2);
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
    compute.mockReturnValue({ status: "no-grid" });
    const { result } = renderHook(() => useAlignToStreets());
    act(() => vi.advanceTimersByTime(0));
    compute.mockClear();
    act(() => {
      result.current.align();
    });
    act(() => vi.advanceTimersByTime(300));
    act(() => {
      result.current.align();
    });
    act(() => vi.advanceTimersByTime(699));
    act(() => {
      result.current.align();
    });
    expect(compute).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
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
