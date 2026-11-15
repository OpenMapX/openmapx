// @vitest-environment jsdom

import { useNavigationStore } from "@openmapx/core";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Handler = () => void;
const map = vi.hoisted(() => {
  const handlers = new Map<string, Set<Handler>>();
  return {
    handlers,
    instance: {
      getContainer: () => ({ clientHeight: 800 }),
      // 64 px span ≈ 73 m, which reads as a 50 m bar.
      unproject: ([x]: [number, number]) => ({
        distanceTo: (other: { x: number }) => Math.abs(other.x - x) * (73 / 64),
        x,
      }),
      on: (event: string, handler: Handler) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)?.add(handler);
      },
      off: (event: string, handler: Handler) => handlers.get(event)?.delete(handler),
    },
    emit(event: string) {
      for (const handler of handlers.get(event) ?? []) handler();
    },
  };
});
const screenSize = vi.hoisted(() => ({ phone: true }));
// One context object, as MapProvider keeps one ref for the map's lifetime.
const mapContext = vi.hoisted(() => ({ mapRef: { current: null as unknown }, mapReady: true }));

vi.mock("@/integration-api/map/MapContext", () => ({
  useMapOptional: () => mapContext,
}));
vi.mock("@mui/material/useMediaQuery", () => ({ default: () => screenSize.phone }));

import { MapScaleBar } from "./MapScaleBar";

beforeEach(() => {
  mapContext.mapRef.current = map.instance;
  vi.useFakeTimers();
  screenSize.phone = true;
  map.handlers.clear();
});

afterEach(() => {
  vi.useRealTimers();
  act(() => useNavigationStore.getState().stopNavigation());
});

const overlayOpacity = () =>
  getComputedStyle(screen.getByTestId("map-scale").parentElement as HTMLElement).opacity;

describe("MapScaleBar", () => {
  it("reads a round distance in the footer", () => {
    render(<MapScaleBar />);
    expect(screen.getByTestId("map-scale").textContent).toBe("50 m");
  });

  it("shows the phone overlay while the map zooms, then fades it out", () => {
    render(<MapScaleBar variant="overlay" />);
    expect(overlayOpacity()).toBe("0");

    act(() => map.emit("zoom"));
    expect(overlayOpacity()).toBe("1");

    act(() => map.emit("zoomend"));
    act(() => vi.advanceTimersByTime(1500));
    expect(overlayOpacity()).toBe("0");
  });

  it("has no overlay on wider screens or during turn-by-turn guidance", () => {
    screenSize.phone = false;
    const { unmount } = render(<MapScaleBar variant="overlay" />);
    expect(screen.queryByTestId("map-scale")).toBeNull();
    unmount();

    screenSize.phone = true;
    act(() => useNavigationStore.setState({ status: "navigating", kind: "ground" }));
    render(<MapScaleBar variant="overlay" />);
    expect(screen.queryByTestId("map-scale")).toBeNull();
  });
});
