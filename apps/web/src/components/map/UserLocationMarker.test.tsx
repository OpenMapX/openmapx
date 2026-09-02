// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    constructor(private readonly options: { element: HTMLElement }) {}

    addTo(map: { container: HTMLElement }) {
      map.container.append(this.options.element);
      return this;
    }

    remove = vi.fn();

    setLngLat() {
      return this;
    }
  }
  return { Marker: FakeMarker };
});

import { useMapStore } from "@openmapx/core";
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
  cleanup();
  vi.clearAllMocks();
  useMapStore.setState({ userLocation: null });
  mapContextTest.mapReady = false;
  mapContextTest.mapRef.current = null;
});

describe("UserLocationMarker", () => {
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
});
