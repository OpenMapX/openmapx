import { afterEach, describe, expect, it } from "vitest";
import { PANEL } from "../panels/ids";
import { createPlace } from "../types/placeIds";
import { usePlaceStore } from "./placeStore";
import { useSidebarStore } from "./sidebarStore";

const place = createPlace({
  primaryScheme: "stylePoi",
  ids: { stylePoi: "1" },
  name: "Grotesque",
  address: "Grotesque",
  coordinates: [6.08, 50.78],
});

afterEach(() => {
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  usePlaceStore.setState({ selectedPlace: null });
});

describe("opening a place detail", () => {
  it("keeps a standalone selected place in the full sidebar", () => {
    usePlaceStore.setState({ selectedPlace: place });
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.PLACE,
      activeDetailId: null,
      collapsed: false,
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(place);
  });

  it("does not duplicate a place already in the full sidebar", () => {
    usePlaceStore.setState({ selectedPlace: place });
    useSidebarStore.setState({ activeSidebarId: PANEL.PLACE });
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.PLACE,
      activeDetailId: null,
      collapsed: false,
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(place);
  });

  it("floats beside a visible results sidebar", () => {
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY });
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.CATEGORY,
      activeDetailId: PANEL.PLACE_CARD,
      collapsed: false,
    });
  });

  it("opens the full place sidebar when the other rail is collapsed", () => {
    usePlaceStore.setState({ selectedPlace: place });
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY, collapsed: true });
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.PLACE,
      activeDetailId: null,
      collapsed: false,
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(place);
  });

  it("clears a stale card when the full place sidebar opens", () => {
    usePlaceStore.setState({ selectedPlace: place });
    useSidebarStore.setState({ activeSidebarId: PANEL.CATEGORY, activeDetailId: PANEL.PLACE_CARD });
    useSidebarStore.getState().openSidebar(PANEL.PLACE);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.PLACE,
      activeDetailId: null,
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(place);
  });
});
