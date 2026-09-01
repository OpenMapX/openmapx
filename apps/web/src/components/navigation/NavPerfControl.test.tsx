import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap } from "@/test";

vi.mock("@/integration-api/map/MapContext", () => {
  const value = {
    mapRef: { current: null as unknown },
    mapReady: true,
    styleVersion: 0,
    notifyMapReady: () => {},
    notifyStyleReload: () => {},
    flyTo: () => {},
    fitBounds: () => {},
    zoomIn: () => {},
    zoomOut: () => {},
    resetBearing: () => {},
  };
  return { __test: value, useMapOptional: () => value, useMap: () => value };
});

import { useNavigationStore } from "@openmapx/core";
import * as mapContext from "@/integration-api/map/MapContext";
import { NavPerfControl } from "./NavPerfControl";

const mapContextTest = (mapContext as unknown as { __test: { mapRef: { current: unknown } } })
  .__test;

let fake: FakeMap;
let observerCount: number;
let blobs: Blob[];
/** Frame callbacks and intervals still outstanding — the cleanup assertions. */
let liveFrames: Set<number>;
let liveIntervals: Set<number>;
let createObjectURL: ReturnType<typeof vi.fn>;
let anchorClicks: number;
let realAnchorClick: () => void;
let realCreateObjectURL: typeof URL.createObjectURL;
let realRevokeObjectURL: typeof URL.revokeObjectURL;

class StubPerformanceObserver {
  static supportedEntryTypes = ["longtask", "resource"];
  constructor(callback: () => void) {
    observerCount += 1;
    void callback;
  }
  observe() {}
  disconnect() {}
}

const setQuery = (search: string) => {
  window.history.replaceState({}, "", search);
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  observerCount = 0;
  blobs = [];
  anchorClicks = 0;
  liveFrames = new Set();
  liveIntervals = new Set();
  fake = createFakeMap();
  mapContextTest.mapRef.current = fake.map;

  const realRequestFrame = globalThis.requestAnimationFrame;
  const realCancelFrame = globalThis.cancelAnimationFrame;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const handle = realRequestFrame((t: number) => {
      liveFrames.delete(handle);
      callback(t);
    });
    liveFrames.add(handle);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    liveFrames.delete(handle);
    realCancelFrame(handle);
  });
  vi.stubGlobal("setInterval", (handler: TimerHandler, timeout?: number) => {
    const id = realSetInterval(handler as () => void, timeout) as unknown as number;
    liveIntervals.add(id);
    return id;
  });
  vi.stubGlobal("clearInterval", (id: number) => {
    liveIntervals.delete(id);
    realClearInterval(id as unknown as ReturnType<typeof setInterval>);
  });
  vi.stubGlobal("PerformanceObserver", StubPerformanceObserver);

  // jsdom has no object-URL support; patch the two statics the export uses and
  // restore them afterwards (stubbing the whole URL class would break `new URL`).
  createObjectURL = vi.fn((...args: unknown[]) => {
    blobs.push(args[0] as Blob);
    return "blob:navperf";
  });
  realCreateObjectURL = URL.createObjectURL;
  realRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = () => {};
  realAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = () => {
    anchorClicks += 1;
  };
});

afterEach(() => {
  cleanup();
  HTMLAnchorElement.prototype.click = realAnchorClick;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  setQuery("/");
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
  useNavigationStore.getState().stopNavigation();
});

const mapHandlerCount = () =>
  ["render", "move", "moveend", "idle"].reduce(
    (sum, event) => sum + (fake.state.handlers.get(event)?.size ?? 0),
    0,
  );

const click = (testId: string) => {
  act(() => {
    fireEvent.click(screen.getByTestId(testId));
  });
};

const readout = (testId: string) => screen.getByTestId(testId).textContent ?? "";

describe("NavPerfControl", () => {
  it("renders nothing and creates no listeners, observers, timers or frames without the query flag", () => {
    setQuery("/");
    render(<NavPerfControl />);
    expect(screen.queryByTestId("nav-perf-control")).toBeNull();
    expect(mapHandlerCount()).toBe(0);
    expect(observerCount).toBe(0);
    expect(liveIntervals.size).toBe(0);
    expect(liveFrames.size).toBe(0);
  });

  it("renders the HUD with the query flag but stays idle until started", () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    expect(screen.queryByTestId("nav-perf-control")).not.toBeNull();
    expect(mapHandlerCount()).toBe(0);
    expect(observerCount).toBe(0);
    expect(liveIntervals.size).toBe(0);
    expect(liveFrames.size).toBe(0);
  });

  it("attaches to the map and the navigation store on start, and detaches on stop", () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    click("nav-perf-start");
    expect(mapHandlerCount()).toBe(4);
    expect(observerCount).toBe(2);
    expect(liveIntervals.size).toBe(1);
    expect(liveFrames.size).toBe(1);
    click("nav-perf-start");
    expect(mapHandlerCount()).toBe(0);
    expect(liveIntervals.size).toBe(0);
    expect(liveFrames.size).toBe(0);
  });

  it("refreshes the readout at most once per second", () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    click("nav-perf-start");
    expect(readout("nav-perf-map")).toContain("r0");
    act(() => {
      for (let i = 0; i < 5; i += 1) fake.emit("render");
    });
    act(() => {
      vi.advanceTimersByTime(900);
    });
    expect(readout("nav-perf-map")).toContain("r0");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(readout("nav-perf-map")).toContain("r5");
  });

  it("counts navigation progress publications", () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    click("nav-perf-start");
    act(() => {
      useNavigationStore.getState().applyProgress({
        alongMeters: 10,
        deviationMeters: 2,
        distanceRemaining: 100,
        durationRemaining: 60,
        etaEpochMs: 0,
        currentStepIndex: 0,
        distanceToNextManeuver: 50,
        snapped: [0, 0],
        bearing: 90,
        speedMps: 10,
        segmentIndex: 0,
      });
    });
    act(() => {
      vi.advanceTimersByTime(1100);
    });
    expect(readout("nav-perf-progress")).toContain("progress 1 of");
  });

  it("resets the aggregates without detaching", () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    click("nav-perf-start");
    act(() => {
      for (let i = 0; i < 3; i += 1) fake.emit("render");
    });
    click("nav-perf-reset");
    expect(readout("nav-perf-map")).toContain("r0");
    expect(mapHandlerCount()).toBe(4);
  });

  it("exports only on an explicit click", () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    click("nav-perf-start");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(createObjectURL).toHaveBeenCalledTimes(0);
    click("nav-perf-export");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClicks).toBe(1);
  });

  it("exports aggregates and manually entered metadata, with no URLs or coordinates", async () => {
    setQuery("/?navperf=1");
    render(<NavPerfControl />);
    click("nav-perf-start");
    click("nav-perf-meta-toggle");
    click("nav-perf-scenario-city");
    const input = screen.getByTestId("nav-perf-meta-device").querySelector("input");
    act(() => {
      fireEvent.change(input as Element, { target: { value: "Pixel 7a" } });
    });
    click("nav-perf-export");

    const text = await blobs[0].text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed)).toContain("frames");
    expect(Object.keys(parsed)).toContain("resources");
    expect(text).toContain("Pixel 7a");
    expect(text).toContain("city");
    expect(text.includes("http")).toBe(false);
    expect(/\d+\.\d{4,}/.test(text)).toBe(false);
  });

  it("stops the monitor and clears its timer when unmounted", () => {
    setQuery("/?navperf=1");
    const view = render(<NavPerfControl />);
    click("nav-perf-start");
    expect(liveIntervals.size).toBe(1);
    view.unmount();
    expect(mapHandlerCount()).toBe(0);
    expect(liveIntervals.size).toBe(0);
    expect(liveFrames.size).toBe(0);
  });
});
