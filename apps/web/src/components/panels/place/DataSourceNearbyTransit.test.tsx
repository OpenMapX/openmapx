import { createPlace, type Place, usePlaceStore, useSidebarStore } from "@openmapx/core";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DataSourceNearbyTransit } from "./DataSourceNearbyTransit";

const stop: TransitStop = {
  id: "db:A",
  name: "Station A",
  lat: 50,
  lng: 8,
  modes: ["bus"],
  provider: "db",
};
const resolveStop = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useStopsNearby: () => ({ data: [stop], isLoading: false }),
  resolveStopAsPlace: (...args: unknown[]) => resolveStop(...args),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));

const parking = createPlace({
  primaryScheme: "parking",
  ids: { parking: "P" },
  name: "Parking",
  address: "",
  coordinates: [8, 50],
});
const enriched = createPlace({
  primaryScheme: "osm",
  ids: { osm: "node/1", db: "A" },
  name: "Station A",
  address: "",
  coordinates: [8, 50],
});

function ParkingDetail() {
  const selected = usePlaceStore((state) => state.selectedPlace);
  return selected?.id === parking.id ? (
    <DataSourceNearbyTransit coordinates={[8, 50]} />
  ) : (
    <span>{selected?.name}</span>
  );
}

beforeEach(() => {
  resolveStop.mockReset();
  useSidebarStore.getState().closeAll();
  usePlaceStore.getState().setSelectedPlace(parking);
});

describe("nearby transit selection", () => {
  it.each(["current", "new-place", "clear"])(
    "survives its own detail unmount but respects %s ownership",
    async (action) => {
      let finish!: (place: Place) => void;
      const request = new Promise<Place>((resolve) => {
        finish = resolve;
      });
      resolveStop.mockReturnValue(request);
      render(<ParkingDetail />);
      fireEvent.click(screen.getByText("Station A"));
      expect(usePlaceStore.getState().selectedPlace?.ids.db).toBe("A");
      expect(screen.queryByRole("button")).toBeNull();
      act(() => {
        if (action === "new-place") usePlaceStore.getState().setSelectedPlace(parking);
        if (action === "clear") usePlaceStore.getState().setSelectedPlace(null);
      });
      const selected = usePlaceStore.getState().selectedPlace;
      await act(async () => {
        finish(enriched);
        await request;
      });
      expect(usePlaceStore.getState().selectedPlace).toBe(
        action === "current" ? enriched : selected,
      );
    },
  );
});
