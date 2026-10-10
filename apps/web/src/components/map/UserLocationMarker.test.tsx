// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/components/panels/MyLocationCard", () => ({
  MyLocationCard: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      my-location-card
    </button>
  ),
}));
vi.mock("@/integration-api/map/MapContext", () => {
  const value = {
    mapReady: false,
    mapRef: { current: null as { container: HTMLElement } | null },
  };
  return {
    __test: value,
    useMap: () => value,
  };
});

const { setLngLat } = vi.hoisted(() => ({ setLngLat: vi.fn() }));

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    constructor(private readonly options: { element: HTMLElement }) {}

    addTo(map: { container: HTMLElement }) {
      map.container.append(this.options.element);
      return this;
    }

    remove = vi.fn();

    setLngLat(lngLat: [number, number]) {
      setLngLat(lngLat);
      return this;
    }
  }
  return { Marker: FakeMarker };
});

import { useMapStore, useNavigationStore, useParkingStore } from "@openmapx/core";
import * as mapContext from "@/integration-api/map/MapContext";
import { UserLocationMarker } from "./UserLocationMarker";

const mapContextTest = (
  mapContext as unknown as {
    __test: {
      mapReady: boolean;
      mapRef: { current: { container: HTMLElement } | null };
    };
  }
).__test;

afterEach(() => {
  useParkingStore.getState().reset();
  cleanup();
  vi.clearAllMocks();
  useMapStore.setState({ userLocation: null });
  useNavigationStore.setState({ status: "idle", kind: "ground", transitProgress: null });
  mapContextTest.mapReady = false;
  mapContextTest.mapRef.current = null;
});

describe("UserLocationMarker", () => {
  it("suppresses a pointer during picking but preserves keyboard activation", async () => {
    const mapContainer = document.createElement("div");
    mapContextTest.mapRef.current = { container: mapContainer };
    mapContextTest.mapReady = true;
    useMapStore.setState({ userLocation: [13.4, 52.5] });
    render(<UserLocationMarker />);
    await waitFor(() => expect(mapContainer.children).toHaveLength(1));
    useParkingStore.getState().setPicking(true);
    fireEvent.click(mapContainer.firstElementChild as HTMLElement);
    expect(screen.queryByText("my-location-card")).toBeNull();
    fireEvent.keyDown(mapContainer.firstElementChild as HTMLElement, { key: " " });
    expect(screen.getByText("my-location-card")).toBeInTheDocument();
  });
  it("adds a location published before map readiness when the map becomes ready", async () => {
    const mapContainer = document.createElement("div");
    useMapStore.setState({ userLocation: [13.4, 52.5] });

    const view = render(<UserLocationMarker />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mapContainer.children).toHaveLength(0);

    mapContextTest.mapRef.current = { container: mapContainer };
    mapContextTest.mapReady = true;
    view.rerender(<UserLocationMarker />);

    await waitFor(() => expect(mapContainer.children).toHaveLength(1));
  });

  it("opens the location card when the marker is clicked", async () => {
    const mapContainer = document.createElement("div");
    mapContextTest.mapRef.current = { container: mapContainer };
    mapContextTest.mapReady = true;
    useMapStore.setState({ userLocation: [13.4, 52.5] });

    render(<UserLocationMarker />);
    await waitFor(() => expect(mapContainer.children).toHaveLength(1));

    expect(screen.queryByText("my-location-card")).toBeNull();
    act(() => {
      (mapContainer.firstElementChild as HTMLElement).click();
    });
    expect(screen.getByText("my-location-card")).toBeInTheDocument();

    act(() => {
      screen.getByText("my-location-card").click();
    });
    expect(screen.queryByText("my-location-card")).toBeNull();
  });

  it("follows transit navigation's fixes without moving the stored location", async () => {
    const mapContainer = document.createElement("div");
    mapContextTest.mapRef.current = { container: mapContainer };
    mapContextTest.mapReady = true;
    useMapStore.setState({ userLocation: [13.4, 52.5] });
    useNavigationStore.setState({
      status: "navigating",
      kind: "transit",
      transitProgress: {
        currentLegIndex: 1,
        position: [6.1, 50.78],
        snapped: [6.1001, 50.7801],
        fractionAlongLeg: 0,
        deviationMeters: 10,
        arrived: false,
        phase: "waiting-to-board",
      },
    });

    render(<UserLocationMarker />);
    await waitFor(() => expect(mapContainer.children).toHaveLength(1));
    expect(setLngLat).toHaveBeenLastCalledWith([6.1, 50.78]);
    expect(useMapStore.getState().userLocation).toEqual([13.4, 52.5]);

    act(() => useNavigationStore.setState({ status: "idle", transitProgress: null }));
    await waitFor(() => expect(setLngLat).toHaveBeenLastCalledWith([13.4, 52.5]));
  });
});
