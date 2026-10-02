import type { MergedDeparture } from "@openmapx/mobility-core/transit";
import { beforeEach, describe, expect, it } from "vitest";
import { createPlace } from "../types/placeIds";
import { usePlaceStore } from "./placeStore";

const provisional = createPlace({
  primaryScheme: "db",
  ids: { db: "A" },
  name: "A",
  address: "",
  coordinates: [8, 50],
});
const enriched = createPlace({
  primaryScheme: "osm",
  ids: { osm: "node/1", db: "A" },
  name: "A enriched",
  address: "",
  coordinates: [8, 50],
});
beforeEach(() => {
  usePlaceStore.getState().setSelectedPlace(null);
});

describe("place selection ownership", () => {
  it("advances ownership for every explicit selection, including the same place and clearing", () => {
    const initial = usePlaceStore.getState().selectionRevision;
    usePlaceStore.getState().setSelectedPlace(provisional);
    usePlaceStore.getState().setSelectedPlace(provisional);
    usePlaceStore.getState().setSelectedPlace(null);
    expect(usePlaceStore.getState().selectionRevision).toBe(initial + 3);
  });
  it("rejects an older intent even when the same place was reselected", () => {
    usePlaceStore.getState().setSelectedPlace(provisional);
    const revision = usePlaceStore.getState().selectionRevision;
    usePlaceStore.getState().setSelectedPlace(provisional);
    expect(usePlaceStore.getState().enrichSelectedPlace(revision, enriched)).toBe(false);
    expect(usePlaceStore.getState().selectedPlace).toBe(provisional);
  });
  it("does not enrich a cleared selection", () => {
    usePlaceStore.getState().setSelectedPlace(null);
    expect(
      usePlaceStore
        .getState()
        .enrichSelectedPlace(usePlaceStore.getState().selectionRevision, enriched),
    ).toBe(false);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });
  it("promotes current identity without resetting the current transit detail", () => {
    usePlaceStore.getState().setSelectedPlace(provisional);
    const revision = usePlaceStore.getState().selectionRevision;
    const dep = { tripId: "trip" } as MergedDeparture;
    usePlaceStore.getState().setActiveRouteId("route");
    usePlaceStore.getState().setActiveTripDep(dep);
    usePlaceStore
      .getState()
      .focusTransitMapFeature({ kind: "platform", id: "platform" }, { reveal: true });
    const focus = usePlaceStore.getState().transitMapFocus;
    expect(usePlaceStore.getState().enrichSelectedPlace(revision, enriched)).toBe(true);
    expect(usePlaceStore.getState()).toMatchObject({
      selectedPlace: enriched,
      selectionRevision: revision,
      activeRouteId: "route",
      activeTripDep: dep,
      transitMapFocus: focus,
    });
  });
});
