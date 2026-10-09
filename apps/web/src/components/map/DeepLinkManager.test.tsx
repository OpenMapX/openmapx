// @vitest-environment jsdom

import {
  ALL_CATEGORIES as NATURAL_EVENT_CATEGORIES,
  useNaturalEventStore,
} from "@integrations/overlay-natural-events/store";
import { useWildfireStore } from "@integrations/overlay-wildfires/store";
import {
  createOverlayStore,
  getRegisteredOverlayStore,
  isOverlayActive,
  type OverlayStoreBase,
  PANEL,
  registerOverlayEntry,
  runOverlayTransaction,
  useCategorySearchStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: true }),
}));

import { DeepLinkManager } from "./DeepLinkManager";

const FALLBACK: OverlayStoreBase = {
  panelOpen: false,
  layerVisible: false,
  userRevision: 0,
  openPanel: () => {},
  closePanel: () => {},
  setLayerVisible: () => {},
};

function resetOverlay(id: string, excludes: string[] = []): void {
  createOverlayStore({ overlayId: id, extra: {} });
  registerOverlayEntry({
    id,
    getState: () => getRegisteredOverlayStore(id)?.getState() ?? FALLBACK,
    useActive: () => false,
    excludes,
  });
}

beforeEach(() => {
  // A deep-linked overlay excluding another, so applying it exercises the
  // exclusion-peer capture runOverlayTransaction now routes through.
  resetOverlay("weather", ["air-quality"]);
  resetOverlay("air-quality", ["weather"]);
  window.history.replaceState(null, "", "/");
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  usePlaceStore.setState({ selectedPlace: null });
  useCategorySearchStore.getState().clearCategory();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const grotesquePlace = "place=stylePoi%3A1&at=50.78%2C6.08&name=Grotesque";

describe("DeepLinkManager place shells", () => {
  it("docks a legacy standalone place-card URL", () => {
    window.history.replaceState(null, "", `/?panel=place-card&${grotesquePlace}`);
    render(<DeepLinkManager />);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.PLACE,
      activeDetailId: null,
    });
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Grotesque");
  });

  it("restores a place card beside its category sidebar", () => {
    window.history.replaceState(
      null,
      "",
      `/?panel=category&categoryId=restaurants&${grotesquePlace}`,
    );
    render(<DeepLinkManager />);

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.CATEGORY,
      activeDetailId: PANEL.PLACE_CARD,
    });
    expect(useCategorySearchStore.getState().activeCategory).toBe("restaurants");
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Grotesque");
  });

  it("rehydrates a legacy standalone card on browser history navigation", () => {
    window.history.replaceState(
      null,
      "",
      `/?panel=category&categoryId=restaurants&${grotesquePlace}`,
    );
    render(<DeepLinkManager />);

    act(() => {
      window.history.pushState(null, "", `/?panel=place-card&${grotesquePlace}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.PLACE,
      activeDetailId: null,
    });
    expect(useCategorySearchStore.getState().activeCategory).toBeNull();
  });
});

describe("DeepLinkManager overlay application", () => {
  it("opens a deep-linked overlay (user intent) and closes its exclusion peer through the transaction", () => {
    getRegisteredOverlayStore("air-quality")?.getState().openPanel();
    expect(isOverlayActive("air-quality")).toBe(true);

    window.history.replaceState(null, "", "/?ov=weather");
    render(<DeepLinkManager />);

    expect(isOverlayActive("weather")).toBe(true);
    expect(isOverlayActive("air-quality")).toBe(false);
  });

  it("closes an overlay no longer named by the link", () => {
    getRegisteredOverlayStore("weather")?.getState().openPanel();
    expect(isOverlayActive("weather")).toBe(true);

    window.history.replaceState(null, "", "/?ov=air-quality");
    render(<DeepLinkManager />);

    expect(isOverlayActive("air-quality")).toBe(true);
    expect(isOverlayActive("weather")).toBe(false);
    expect(window.location.search).toContain("ov=air-quality");
    expect(window.location.search).not.toContain("overlay-air-quality");
  });

  it("keeps only the natural-event categories the layer shows", () => {
    useNaturalEventStore.setState({ activeCategories: new Set(NATURAL_EVENT_CATEGORIES) });

    window.history.replaceState(null, "", "/?neCat=snow");
    render(<DeepLinkManager />);
    expect([...useNaturalEventStore.getState().activeCategories]).toEqual([
      ...NATURAL_EVENT_CATEGORIES,
    ]);

    window.history.replaceState(null, "", "/?neCat=snow,floods");
    render(<DeepLinkManager />);
    expect([...useNaturalEventStore.getState().activeCategories]).toEqual(["floods"]);
  });

  it("reads the hotspot sensor of a wildfire link as an instrument family", () => {
    useWildfireStore.setState({ source: "viirs" });

    window.history.replaceState(null, "", "/?fire=2,modis,0");
    render(<DeepLinkManager />);
    expect(useWildfireStore.getState()).toMatchObject({ dayRange: 2, source: "modis" });

    window.history.replaceState(null, "", "/?fire=1,VIIRS_SNPP_NRT,0");
    render(<DeepLinkManager />);
    expect(useWildfireStore.getState()).toMatchObject({ dayRange: 1, source: "modis" });
  });

  it("leaves an automation-opened overlay alone when the link does not name it", () => {
    // Contextual automation (e.g. transit directions) opened this overlay; its
    // userRevision is untouched because nobody chose it by hand.
    runOverlayTransaction("air-quality", { panelOpen: true }, { kind: "automation", owner: "t" });
    expect(isOverlayActive("air-quality")).toBe(true);

    // A link that only carries a camera says nothing about overlays.
    window.history.replaceState(null, "", "/?map=52.5,13.4,11,0,0");
    render(<DeepLinkManager />);

    expect(isOverlayActive("air-quality")).toBe(true);
    expect(getRegisteredOverlayStore("air-quality")?.getState().userRevision).toBe(0);
    expect(window.location.search).toContain("ov=air-quality");
  });
});
