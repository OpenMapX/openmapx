// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, render } from "@/test";

vi.mock("@/integration-api/map/MapContext", () => {
  const mapContext = { mapRef: { current: null as unknown }, mapReady: true, styleVersion: 0 };
  return { __test: mapContext, useMap: () => mapContext };
});

import {
  createPlace,
  PANEL,
  useDirectionsStore,
  useMapClickStore,
  useNavigationStore,
  useParkingStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import * as mapContextModule from "@/integration-api/map/MapContext";
import { consumeLongPressClick, LONG_PRESS_MS } from "@/lib/mapTouch";
import { MapClickHandler } from "./MapClickHandler";

const mapContextTest = (mapContextModule as unknown as { __test: { mapRef: { current: unknown } } })
  .__test;

let fake: ReturnType<typeof createFakeMap>;

const PLACE = createPlace({
  primaryScheme: "coordinate",
  ids: { coordinate: "50.000000-6.000000" },
  name: "Somewhere",
  address: "Somewhere",
  coordinates: [6, 50],
});

function click(pointerType: "mouse" | "touch"): void {
  fake.emit("click", {
    lngLat: { lng: 6.1, lat: 50.1 },
    point: { x: 10, y: 10 },
    originalEvent: { pointerType },
  });
}

function touch(type: string, points: Array<[number, number]>): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: points.map(([clientX, clientY]) => ({ clientX, clientY })),
  });
  fake.state.canvas.dispatchEvent(event);
}

function openPlace(): void {
  usePlaceStore.getState().setSelectedPlace(PLACE);
  useSidebarStore.getState().openSidebar(PANEL.PLACE);
}

beforeEach(() => {
  fake = createFakeMap();
  fake.map.unproject = (() => ({ lng: 7, lat: 51 })) as never;
  mapContextTest.mapRef.current = fake.map;
  useMapClickStore.getState().setClickedLngLat(null);
  usePlaceStore.getState().setSelectedPlace(null);
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  useDirectionsStore.getState().close();
  useNavigationStore.setState({ status: "idle" });
  useParkingStore.setState({ picking: false });
  consumeLongPressClick();
});

afterEach(() => {
  touch("touchend", []);
  vi.useRealTimers();
});

describe("MapClickHandler with a mouse", () => {
  it("drops the gray pin on a click, as before", () => {
    render(<MapClickHandler />);
    openPlace();
    click("mouse");
    expect(useMapClickStore.getState().clickedLngLat).toEqual([6.1, 50.1]);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });
});

describe("MapClickHandler on a touch screen", () => {
  it("only puts away the open place on a tap, without dropping a pin", () => {
    render(<MapClickHandler />);
    openPlace();
    click("touch");
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    expect(useSidebarStore.getState().activeSidebarId).toBeNull();
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
  });

  it("takes a dropped pin away on a tap before anything else", () => {
    render(<MapClickHandler />);
    useMapClickStore.getState().setClickedLngLat([6, 50]);
    click("touch");
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
  });

  it("drops the pin on a long-press, closing the open place", () => {
    vi.useFakeTimers();
    render(<MapClickHandler />);
    openPlace();
    touch("touchstart", [[20, 30]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(useMapClickStore.getState().clickedLngLat).toEqual([7, 51]);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();

    // The click some browsers fire as the finger lifts leaves the pin alone.
    click("touch");
    expect(useMapClickStore.getState().clickedLngLat).toEqual([7, 51]);
  });

  it("keeps the pin when the finger lifts long after it dropped", () => {
    vi.useFakeTimers();
    render(<MapClickHandler />);
    touch("touchstart", [[20, 30]]);
    vi.advanceTimersByTime(LONG_PRESS_MS + 2500);
    touch("touchend", []);
    click("touch");
    expect(useMapClickStore.getState().clickedLngLat).toEqual([7, 51]);

    // The next tap is a tap of its own, and clears the pin.
    touch("touchstart", [[20, 30]]);
    touch("touchend", []);
    click("touch");
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
  });

  it("leaves a long-press to the parking picker while it is choosing a spot", () => {
    vi.useFakeTimers();
    useParkingStore.setState({ picking: true });
    render(<MapClickHandler />);
    touch("touchstart", [[20, 30]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
  });

  it("drops no pin during guidance", () => {
    vi.useFakeTimers();
    useNavigationStore.setState({ status: "navigating" });
    render(<MapClickHandler />);
    touch("touchstart", [[20, 30]]);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(useMapClickStore.getState().clickedLngLat).toBeNull();
  });
});
