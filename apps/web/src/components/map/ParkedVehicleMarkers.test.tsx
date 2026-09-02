// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => {
  const value = { mapReady: true, mapRef: { current: null as { container: HTMLElement } | null } };
  return { __test: value, useMap: () => value };
});

vi.mock("maplibre-gl", () => {
  class FakeMarker {
    constructor(private readonly options: { element: HTMLElement }) {}
    addTo(map: { container: HTMLElement }) {
      map.container.append(this.options.element);
      return this;
    }
    remove = vi.fn(() => {
      this.options.element.remove();
    });
    setLngLat() {
      return this;
    }
  }
  return { Marker: FakeMarker };
});

const state = vi.hoisted(() => ({ parked: [] as unknown[], vehicles: [] as unknown[] }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useParkedLocations: () => ({ data: state.parked }),
  useVehicles: () => ({ data: state.vehicles }),
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { PANEL, useParkingStore, useSidebarStore } from "@openmapx/core";
import * as mapContext from "@/integration-api/map/MapContext";
import { ParkedVehicleMarkers } from "./ParkedVehicleMarkers";

const mapContextTest = (
  mapContext as unknown as { __test: { mapRef: { current: { container: HTMLElement } | null } } }
).__test;

const RECORD = {
  id: "p1",
  vehicleId: null,
  lat: 51.55,
  lng: 6.6,
  address: null,
  note: null,
  expiresAt: null,
  source: "manual",
  accuracyMeters: null,
  savedAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:00:00.000Z",
};

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  mapContextTest.mapRef.current = { container };
  state.parked = [RECORD];
  state.vehicles = [];
  useParkingStore.getState().reset();
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ParkedVehicleMarkers", () => {
  it("renders one marker per parked record", async () => {
    render(<ParkedVehicleMarkers />);
    await waitFor(() => expect(container.children).toHaveLength(1));
  });

  it("renders nothing when there is no parked record", async () => {
    state.parked = [];
    render(<ParkedVehicleMarkers />);
    await settle();
    expect(container.children).toHaveLength(0);
  });

  it("opens the parking panel for the clicked record", async () => {
    render(<ParkedVehicleMarkers />);
    await waitFor(() => expect(container.children).toHaveLength(1));

    (container.firstElementChild as HTMLElement).click();

    expect(useParkingStore.getState().selectedParkedId).toBe("p1");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PARKING);
  });

  it("labels the marker with the vehicle name when one is assigned", async () => {
    state.vehicles = [{ id: "v1", name: "Blue Golf", isDefault: true }];
    state.parked = [{ ...RECORD, vehicleId: "v1" }];
    render(<ParkedVehicleMarkers />);
    await waitFor(() => expect(container.textContent).toContain("Blue Golf"));
  });

  it("removes its markers on unmount", async () => {
    const view = render(<ParkedVehicleMarkers />);
    await waitFor(() => expect(container.children).toHaveLength(1));
    view.unmount();
    await waitFor(() => expect(container.children).toHaveLength(0));
  });
});
