import { createPlace, type Place, usePlaceStore } from "@openmapx/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { usePlaceEnrichment } from "./usePlaceEnrichment";

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
const placeB = createPlace({
  primaryScheme: "osm",
  ids: { osm: "node/2" },
  name: "B",
  address: "",
  coordinates: [9, 51],
});
beforeEach(() => {
  usePlaceStore.getState().setSelectedPlace(null);
});

describe("place enrichment lifecycle", () => {
  it("publishes a provisional place immediately and enriches across a rerender", async () => {
    let finish!: (place: Place) => void;
    const request = new Promise<Place>((resolve) => {
      finish = resolve;
    });
    const view = renderHook(() => usePlaceEnrichment());
    act(() => view.result.current.selectWithEnrichment(provisional, () => request));
    expect(usePlaceStore.getState().selectedPlace).toBe(provisional);
    view.rerender();
    await act(async () => {
      finish(enriched);
      await request;
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(enriched);
  });

  it.each(["ordinary", "same-place", "clear", "cancel", "unmount", "another-hook"])(
    "rejects the older request after %s",
    async (action) => {
      let finish!: (place: Place) => void;
      const request = new Promise<Place>((resolve) => {
        finish = resolve;
      });
      const first = renderHook(() => usePlaceEnrichment());
      const second = renderHook(() => usePlaceEnrichment());
      act(() => first.result.current.selectWithEnrichment(provisional, () => request));
      await act(async () => {
        if (action === "ordinary") usePlaceStore.getState().setSelectedPlace(placeB);
        if (action === "same-place") usePlaceStore.getState().setSelectedPlace(provisional);
        if (action === "clear") usePlaceStore.getState().setSelectedPlace(null);
        if (action === "cancel") first.result.current.cancelEnrichment();
        if (action === "unmount") first.unmount();
        if (action === "another-hook") {
          second.result.current.selectWithEnrichment(placeB, async () => placeB);
          first.result.current.cancelEnrichment();
        }
      });
      const selected = usePlaceStore.getState().selectedPlace;
      await act(async () => {
        finish(enriched);
        await request;
      });
      expect(usePlaceStore.getState().selectedPlace).toBe(selected);
      first.unmount();
      second.unmount();
    },
  );

  it("retains the provisional place if enrichment fails", async () => {
    const view = renderHook(() => usePlaceEnrichment());
    await act(async () =>
      view.result.current.selectWithEnrichment(provisional, async () => {
        throw new Error("unavailable");
      }),
    );
    expect(usePlaceStore.getState().selectedPlace).toBe(provisional);
  });

  it("keeps the newer pending owner when the older request finishes first", async () => {
    let finishA!: (place: Place) => void;
    let finishB!: (place: Place) => void;
    const requestA = new Promise<Place>((resolve) => {
      finishA = resolve;
    });
    const requestB = new Promise<Place>((resolve) => {
      finishB = resolve;
    });
    const view = renderHook(() => usePlaceEnrichment());
    act(() => {
      view.result.current.selectWithEnrichment(provisional, () => requestA);
      view.result.current.selectWithEnrichment(placeB, () => requestB);
    });
    await act(async () => {
      finishA(enriched);
      await requestA;
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(placeB);
    const enrichedB = { ...placeB, name: "B enriched" };
    await act(async () => {
      finishB(enrichedB);
      await requestB;
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(enrichedB);
  });
});
