// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/MapContext", () => {
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
import * as mapContext from "@/lib/MapContext";
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
});
