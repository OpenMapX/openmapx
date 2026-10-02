// @vitest-environment jsdom

import { useCrowdReportStore } from "@integrations/crowd-reports/store";
import { MeasurementLayer } from "@integrations/overlay-tool-measurement/map-layer";
import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { TravelTimeLayer } from "@integrations/overlay-tool-travel-time/map-layer";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { useParkingStore } from "@openmapx/core";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap } from "@/test/fakeMap";
import { MapClickHandler } from "./MapClickHandler";

const context = vi.hoisted(() => ({
  mapRef: { current: null as unknown },
  mapReady: true,
  styleVersion: 0,
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => context }));
vi.mock("@/integration-api/map/useGeoJsonSourceDataBridge", () => ({
  useGeoJsonSourceDataBridge: () => ({ publish: () => undefined }),
}));
vi.mock("@/integration-api/overlay/useMapAttributions", () => ({
  useMapAttributions: () => undefined,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useIsochrone: () => ({ data: undefined }),
  useTransitIsochrone: () => ({ data: undefined }),
  useTransitReachability: () => ({ data: undefined }),
}));

function reset() {
  useParkingStore.getState().reset();
  useCrowdReportStore.getState().stopPicking();
  useMeasurementStore.getState().deactivate();
  useTravelTimeStore.getState().deactivate();
}

beforeEach(reset);
afterEach(() => {
  cleanup();
  reset();
});

function toolMap() {
  const fake = createFakeMap();
  Object.assign(fake.map, { doubleClickZoom: { enable: vi.fn(), disable: vi.fn() } });
  context.mapRef.current = fake.map;
  return fake;
}

describe("physical map click ownership", () => {
  it.each(
    [true, false].flatMap((pickerFirst) =>
      ["parking", "crowd"].map((mode) => ({ pickerFirst, mode })),
    ),
  )(
    "captures $mode without adding tool points (picker first: $pickerFirst)",
    ({ pickerFirst, mode }) => {
      const fake = toolMap();
      act(() => {
        useMeasurementStore.getState().activate();
        useTravelTimeStore.getState().activate();
        if (mode === "parking") useParkingStore.getState().setPicking(true);
        else useCrowdReportStore.getState().startPicking();
      });
      render(
        pickerFirst ? (
          <>
            <MapClickHandler />
            <MeasurementLayer />
            <TravelTimeLayer />
          </>
        ) : (
          <>
            <TravelTimeLayer />
            <MeasurementLayer />
            <MapClickHandler />
          </>
        ),
      );
      act(() =>
        fake.emit("click", {
          point: { x: 1, y: 2 },
          lngLat: { lng: 8, lat: 50 },
          originalEvent: new MouseEvent("click"),
        }),
      );
      if (mode === "parking") expect(useParkingStore.getState().pickedCoords).toEqual([8, 50]);
      else expect(useCrowdReportStore.getState().location).toEqual([8, 50]);
      expect(useMeasurementStore.getState().points).toEqual([]);
      expect(useTravelTimeStore.getState().origin).toBeNull();
    },
  );

  it("gives measurement priority over travel-time when both tools are active", () => {
    const fake = toolMap();
    act(() => {
      useMeasurementStore.getState().activate();
      useTravelTimeStore.getState().activate();
    });
    render(
      <>
        <TravelTimeLayer />
        <MeasurementLayer />
        <MapClickHandler />
      </>,
    );
    act(() =>
      fake.emit("click", {
        point: { x: 1, y: 2 },
        lngLat: { lng: 8, lat: 50 },
        originalEvent: new MouseEvent("click"),
      }),
    );
    expect(useMeasurementStore.getState().points).toEqual([[8, 50]]);
    expect(useTravelTimeStore.getState().origin).toBeNull();
  });

  it("captures an unanchored travel-time origin once", () => {
    const fake = toolMap();
    useTravelTimeStore.getState().activate();
    render(
      <>
        <TravelTimeLayer />
        <MapClickHandler />
      </>,
    );
    act(() =>
      fake.emit("click", {
        point: { x: 1, y: 2 },
        lngLat: { lng: 8, lat: 50 },
        originalEvent: new MouseEvent("click"),
      }),
    );
    expect(useTravelTimeStore.getState().origin).toEqual([8, 50]);
  });

  it("adds one measurement point across duplicate wrappers of the same physical click", () => {
    const fake = toolMap();
    useMeasurementStore.getState().activate();
    render(<MeasurementLayer />);
    const originalEvent = new MouseEvent("click");
    act(() => {
      fake.emit("click", { originalEvent, point: { x: 1, y: 2 }, lngLat: { lng: 8, lat: 50 } });
      fake.emit("click", { originalEvent, point: { x: 1, y: 2 }, lngLat: { lng: 8, lat: 50 } });
      fake.emit("click", {
        originalEvent: new MouseEvent("click"),
        point: { x: 3, y: 4 },
        lngLat: { lng: 9, lat: 51 },
      });
    });
    expect(useMeasurementStore.getState().points).toEqual([
      [8, 50],
      [9, 51],
    ]);
  });

  it("keeps an anchored travel-time origin when clicking elsewhere", () => {
    const fake = toolMap();
    useTravelTimeStore.getState().activateAnchored([7, 49]);
    render(<TravelTimeLayer />);
    act(() =>
      fake.emit("click", {
        originalEvent: new MouseEvent("click"),
        point: { x: 1, y: 2 },
        lngLat: { lng: 8, lat: 50 },
      }),
    );
    expect(useTravelTimeStore.getState().origin).toEqual([7, 49]);
  });

  it("does not change finalized measurement points", () => {
    const fake = toolMap();
    useMeasurementStore.getState().activate();
    useMeasurementStore.getState().addPoint([7, 49]);
    useMeasurementStore.getState().addPoint([8, 50]);
    useMeasurementStore.getState().finalize();
    render(<MeasurementLayer />);
    act(() =>
      fake.emit("click", {
        originalEvent: new MouseEvent("click"),
        point: { x: 1, y: 2 },
        lngLat: { lng: 9, lat: 51 },
      }),
    );
    expect(useMeasurementStore.getState().points).toEqual([
      [7, 49],
      [8, 50],
    ]);
  });
});
