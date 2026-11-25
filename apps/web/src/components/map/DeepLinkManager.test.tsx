// @vitest-environment jsdom

import {
  ALL_CATEGORIES as NATURAL_EVENT_CATEGORIES,
  useNaturalEventStore,
} from "@integrations/overlay-natural-events/store";
import { useWildfireStore } from "@integrations/overlay-wildfires/store";
import {
  createOverlayStore,
  createPlace,
  getRegisteredOverlayStore,
  HISTORY_STATE_KEY,
  idsFromPrimaryOrCoords,
  isOverlayActive,
  type OverlayStoreBase,
  PANEL,
  registerOverlayEntry,
  runOverlayTransaction,
  setOverlayLayerVisible,
  toggleOverlay,
  useCategorySearchStore,
  useDirectionsStore,
  useNavigationStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nth } from "@/test";

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: true }),
  useMapOptional: () => null,
}));

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: null, isPending: false, error: null }),
}));

import { DirectionsPanelContent } from "@/components/panels/directions/DirectionsPanelContent";
import { resetBackNavigationForTests } from "@/lib/backNavigation";
import { DEEPLINK_OPEN_EVENT, DEEPLINK_UPDATE_EVENT } from "@/lib/deepLink";
import { settleHistory } from "@/test/history";
import { createQueryWrapper } from "@/test/query";
import { ContextualOverlays } from "./ContextualOverlays";
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
  resetBackNavigationForTests();
  useSidebarStore.setState({ activeSidebarId: null, activeDetailId: null, collapsed: false });
  usePlaceStore.setState({ selectedPlace: null });
  useCategorySearchStore.getState().clearCategory();
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
});

const grotesquePlace = "place=style-poi%3A1&placeLocation=50.78%2C6.08&placeName=Grotesque";

describe("DeepLinkManager place shells", () => {
  it("opens a place by its id", () => {
    window.history.replaceState(null, "", `/?panel=place&${grotesquePlace}`);
    render(<DeepLinkManager />);

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "style-poi:1",
      name: "Grotesque",
      coordinates: [6.08, 50.78],
    });
  });

  it("opens a place whose id does not parse at its coordinates", () => {
    window.history.replaceState(
      null,
      "",
      "/?panel=place&place=stylePoi%3A1&placeLocation=50.78%2C6.08&placeName=Grotesque",
    );
    render(<DeepLinkManager />);

    expect(usePlaceStore.getState().selectedPlace).toMatchObject({
      id: "coordinate:50.780000,6.080000",
      name: "Grotesque",
      coordinates: [6.08, 50.78],
    });
  });

  it("applies a native incoming location instead of overwriting it from the current stores", () => {
    render(<DeepLinkManager />);
    act(() => {
      window.history.replaceState(
        null,
        "",
        "/?panel=place&place=geo%3A48.137%2C11.575&placeLocation=48.137%2C11.575&placeName=Marienplatz",
      );
      window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
    });
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Marienplatz");
    expect(usePlaceStore.getState().selectedPlace?.coordinates).toEqual([11.575, 48.137]);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
  });

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
      `/?panel=category&category=restaurants&${grotesquePlace}`,
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
      `/?panel=category&category=restaurants&${grotesquePlace}`,
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

    window.history.replaceState(null, "", "/?overlay=weather");
    render(<DeepLinkManager />);

    expect(isOverlayActive("weather")).toBe(true);
    expect(isOverlayActive("air-quality")).toBe(false);
  });

  it("closes an overlay no longer named by the link", () => {
    getRegisteredOverlayStore("weather")?.getState().openPanel();
    expect(isOverlayActive("weather")).toBe(true);

    window.history.replaceState(null, "", "/?overlay=air-quality");
    render(<DeepLinkManager />);

    expect(isOverlayActive("air-quality")).toBe(true);
    expect(isOverlayActive("weather")).toBe(false);
    expect(window.location.search).toContain("overlay=air-quality");
    expect(window.location.search).not.toContain("overlay-air-quality");
  });

  it("keeps only the natural-event categories the layer shows", () => {
    useNaturalEventStore.setState({ activeCategories: new Set(NATURAL_EVENT_CATEGORIES) });

    window.history.replaceState(null, "", "/?naturalEventCategories=snow");
    render(<DeepLinkManager />);
    expect([...useNaturalEventStore.getState().activeCategories]).toEqual([
      ...NATURAL_EVENT_CATEGORIES,
    ]);

    act(() => {
      window.history.replaceState(null, "", "/?naturalEventCategories=snow,floods");
      window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
    });
    expect([...useNaturalEventStore.getState().activeCategories]).toEqual(["floods"]);
  });

  it("reads the hotspot sensor of a wildfire link as an instrument family", () => {
    useWildfireStore.setState({ source: "viirs" });

    window.history.replaceState(null, "", "/?wildfires=2,modis,0");
    render(<DeepLinkManager />);
    expect(useWildfireStore.getState()).toMatchObject({ dayRange: 2, source: "modis" });

    act(() => {
      window.history.replaceState(null, "", "/?wildfires=1,VIIRS_SNPP_NRT,0");
      window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
    });
    expect(useWildfireStore.getState()).toMatchObject({ dayRange: 1, source: "modis" });

    act(() => {
      window.history.replaceState(null, "", "/?wildfires=3,slstr,0");
      window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
    });
    expect(useWildfireStore.getState()).toMatchObject({ dayRange: 3, source: "slstr" });
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
    expect(window.location.search).toContain("overlay=air-quality");
  });
});

describe("DeepLinkManager and trip overlays", () => {
  function page() {
    return (
      <>
        <ContextualOverlays />
        <DeepLinkManager />
      </>
    );
  }

  function writeNow(): void {
    act(() => {
      window.dispatchEvent(new Event(DEEPLINK_UPDATE_EVENT));
    });
  }

  beforeEach(() => {
    resetOverlay("traffic-flow");
    useDirectionsStore.setState({ isOpen: false, mode: "driving" });
    useNavigationStore.setState({ status: "idle", kind: "ground", mode: "driving" });
  });

  afterEach(() => {
    cleanup();
    useNavigationStore.setState({ status: "idle", kind: "ground", mode: "driving" });
  });

  it("keeps an overlay the trip switched on out of the URL, so a reload mid-trip still turns it off at End", () => {
    render(page());
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(isOverlayActive("traffic-flow")).toBe(true);
    writeNow();
    expect(window.location.search).not.toContain("traffic-flow");

    // The page reloads mid-trip (the shell's WebView restarts) at the same
    // URL, and the native session brings navigation back.
    const tripUrl = `${window.location.pathname}${window.location.search}`;
    cleanup();
    resetOverlay("traffic-flow");
    useNavigationStore.setState({ status: "idle" });
    window.history.replaceState(null, "", tripUrl);
    render(page());
    act(() => useNavigationStore.setState({ status: "navigating" }));
    expect(isOverlayActive("traffic-flow")).toBe(true);

    act(() => useNavigationStore.setState({ status: "idle" }));
    expect(isOverlayActive("traffic-flow")).toBe(false);
  });

  it("still writes a trip overlay the user had on before the trip", () => {
    toggleOverlay("traffic-flow", { kind: "user" });
    render(page());
    act(() => useNavigationStore.setState({ status: "navigating" }));
    writeNow();
    expect(window.location.search).toContain("overlay=traffic-flow");
  });

  it("writes a trip overlay once the user chooses it during the trip", () => {
    render(page());
    act(() => useNavigationStore.setState({ status: "navigating" }));
    act(() => setOverlayLayerVisible("traffic-flow", true, { kind: "user" }));
    writeNow();
    expect(window.location.search).toContain("overlay=traffic-flow");
  });
});

describe("DeepLinkManager history entries", () => {
  async function settled(): Promise<void> {
    await act(settleHistory);
  }

  function writeNow(): void {
    act(() => {
      window.dispatchEvent(new Event(DEEPLINK_UPDATE_EVENT));
    });
  }

  it("gives an opened place card its own entry, which Back closes without rebuilding the list", async () => {
    window.history.replaceState(null, "", "/?panel=category&category=restaurants");
    render(<DeepLinkManager />);
    const listRevision = useCategorySearchStore.getState().searchRevision;

    act(() => {
      usePlaceStore.getState().setSelectedPlace(
        createPlace({
          ...idsFromPrimaryOrCoords("style-poi:1", [6.08, 50.78]),
          name: "Grotesque",
          address: "Grotesque",
          coordinates: [6.08, 50.78],
        }),
      );
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    });
    writeNow();
    expect(window.location.search).toContain("place=");
    expect(window.history.state[HISTORY_STATE_KEY].depth).toBe(1);

    window.history.back();
    await settled();

    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    expect(useSidebarStore.getState()).toMatchObject({
      activeSidebarId: PANEL.CATEGORY,
      activeDetailId: null,
    });
    expect(useCategorySearchStore.getState().activeCategory).toBe("restaurants");
    // Closed in place: the list was not cleared and searched again.
    expect(useCategorySearchStore.getState().searchRevision).toBe(listRevision);
    expect(window.location.search).not.toContain("place=");
  });

  it("rewrites the card's entry when its own close control is used, so Back does not reopen it", async () => {
    window.history.pushState(null, "", "/elsewhere");
    window.history.pushState(null, "", "/?panel=category&category=restaurants");
    resetBackNavigationForTests();
    render(<DeepLinkManager />);
    act(() => {
      usePlaceStore.getState().setSelectedPlace(
        createPlace({
          ...idsFromPrimaryOrCoords("style-poi:1", [6.08, 50.78]),
          name: "Grotesque",
          address: "Grotesque",
          coordinates: [6.08, 50.78],
        }),
      );
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    });
    writeNow();
    expect(window.history.state[HISTORY_STATE_KEY].depth).toBe(1);

    act(() => {
      usePlaceStore.getState().setSelectedPlace(null);
      useSidebarStore.getState().closeDetail();
    });
    writeNow();
    expect(window.history.state[HISTORY_STATE_KEY].depth).toBe(1);
    expect(window.location.search).not.toContain("place=");

    // The entry below shows the same list, so Back steps over it and closes
    // the list's page instead of doing nothing visible.
    window.history.back();
    await settled();
    expect(window.location.pathname).toBe("/elsewhere");
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });

  it("restores a text search from its link", () => {
    window.history.replaceState(
      null,
      "",
      "/?panel=category&search=pizza&bounds=6.0%2C50.7%2C6.1%2C50.8",
    );
    render(<DeepLinkManager />);

    expect(useCategorySearchStore.getState()).toMatchObject({
      mode: "text",
      textQuery: "pizza",
      activeCategory: null,
    });
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(window.location.search).toContain("search=pizza");
  });
});

describe("DeepLinkManager directions waypoints", () => {
  const aachen: [number, number] = [6.08, 50.78];
  const koeln: [number, number] = [6.96, 50.94];
  const berlin: [number, number] = [13.405, 52.52];

  beforeEach(() => {
    cleanup();
    useDirectionsStore.getState().close();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    useDirectionsStore.getState().close();
  });

  function writeNow(): void {
    act(() => {
      window.dispatchEvent(new Event(DEEPLINK_UPDATE_EVENT));
    });
  }

  function wp(): string[] {
    return new URLSearchParams(window.location.search).getAll("waypoint");
  }

  /** What a reload or an opened shared link does: reset, then read the URL. */
  function reopen(search: string): void {
    act(() => {
      useDirectionsStore.getState().close();
      window.history.replaceState(null, "", `/${search}`);
      window.dispatchEvent(new Event(DEEPLINK_OPEN_EVENT));
    });
  }

  function slots() {
    return useDirectionsStore.getState().waypoints.map((w) => ({
      coords: w.coords,
      label: w.label,
      schedule: w.schedule,
    }));
  }

  function openDirections(): void {
    useDirectionsStore.getState().open();
    useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
  }

  it("puts a blank origin and a destination back into their own fields", () => {
    render(<DeepLinkManager />);
    act(() => {
      useDirectionsStore.getState().setWaypoint(1, berlin, "Berlin");
      openDirections();
    });
    writeNow();
    expect(wp()).toEqual(["", "52.52,13.405,Berlin"]);

    reopen(window.location.search);
    expect(nth(slots(), 0).coords).toBeNull();
    expect(slots()[1]).toMatchObject({ coords: berlin, label: "Berlin" });
  });

  it("keeps a blank intermediate stop in its slot", () => {
    render(<DeepLinkManager />);
    act(() => {
      const d = useDirectionsStore.getState();
      d.addWaypoint(0);
      d.setWaypoint(0, aachen, "Aachen");
      d.setWaypoint(2, berlin, "Berlin");
      openDirections();
    });
    writeNow();

    reopen(window.location.search);
    expect(slots()).toHaveLength(3);
    expect(nth(slots(), 1).coords).toBeNull();
    expect(slots()[2]).toMatchObject({ coords: berlin, label: "Berlin" });
  });

  it("keeps a schedule on its own stop after a blank one", () => {
    const schedule = { arriveBy: "2026-09-02T14:00", dwellSeconds: 1800 };
    render(<DeepLinkManager />);
    act(() => {
      const d = useDirectionsStore.getState();
      d.addWaypoint(0);
      d.addWaypoint(1);
      d.setWaypoint(0, aachen, "Aachen");
      d.setWaypoint(2, koeln, "Koeln");
      d.setWaypoint(3, berlin, "Berlin");
      d.setWaypointSchedule(2, schedule);
      openDirections();
    });
    writeNow();

    reopen(window.location.search);
    expect(slots()[2]).toMatchObject({ coords: koeln, label: "Koeln", schedule });
    expect(nth(slots(), 3).schedule).toBeUndefined();
  });

  it("keeps a schedule on the destination after a blank stop", () => {
    render(<DeepLinkManager />);
    act(() => {
      const d = useDirectionsStore.getState();
      d.addWaypoint(0);
      d.setWaypoint(0, aachen, "Aachen");
      d.setWaypoint(2, berlin, "Berlin");
      d.setWaypointSchedule(2, { arriveBy: "2026-09-02T14:00" });
      openDirections();
    });
    writeNow();

    reopen(window.location.search);
    expect(slots()[2]).toMatchObject({
      coords: berlin,
      label: "Berlin",
      schedule: { arriveBy: "2026-09-02T14:00" },
    });
  });

  it("opens an existing fully specified link unchanged", () => {
    window.history.replaceState(
      null,
      "",
      "/?panel=directions&waypoint=50.78%2C6.08%2CAachen&waypoint=52.52%2C13.405%2CBerlin",
    );
    render(<DeepLinkManager />);

    expect(slots()).toHaveLength(2);
    expect(slots()[0]).toMatchObject({ coords: aachen, label: "Aachen" });
    expect(slots()[1]).toMatchObject({ coords: berlin, label: "Berlin" });
    expect(wp()).toEqual(["50.78,6.08,Aachen", "52.52,13.405,Berlin"]);
  });

  it("reads a three-stop cycling link with a stop schedule into the store and the panel", () => {
    // The panel's own requests are not under test; every one of them fails.
    vi.stubGlobal("fetch", async () => Response.json({ error: "unavailable" }, { status: 503 }));
    const link =
      "/?panel=directions&mode=cycling&bikeProfile=road&avoid=ferries" +
      "&waypoint=50.78%2C6.08%2CAachen&waypoint=50.94%2C6.96%2CKoeln&waypoint=52.52%2C13.405%2CBerlin" +
      "&schedule=1%7C1%2Ca%3D2026-09-02T14%3A00%2Cw%3D30";
    window.history.replaceState(null, "", link);

    render(
      <>
        <DeepLinkManager />
        <DirectionsPanelContent />
      </>,
      { wrapper: createQueryWrapper() },
    );

    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
    expect(useDirectionsStore.getState()).toMatchObject({
      isOpen: true,
      mode: "cycling",
      bikeProfile: "road",
      avoidFerries: true,
      avoidHighways: false,
      avoidTolls: false,
    });
    expect(slots()).toEqual([
      { coords: aachen, label: "Aachen", schedule: undefined },
      {
        coords: koeln,
        label: "Koeln",
        schedule: { arriveBy: "2026-09-02T14:00", dwellSeconds: 1800 },
      },
      { coords: berlin, label: "Berlin", schedule: undefined },
    ]);
    expect(
      screen.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Aachen", "Koeln", "Berlin"]);
    expect(
      (screen.getByRole("radio", { name: "directions.cycling" }) as HTMLInputElement).checked,
    ).toBe(true);

    writeNow();
    const written = new URLSearchParams(window.location.search);
    expect(written.getAll("waypoint")).toEqual([
      "50.78,6.08,Aachen",
      "50.94,6.96,Koeln",
      "52.52,13.405,Berlin",
    ]);
    expect(written.get("schedule")).toBe("1|1,a=2026-09-02T14:00,w=30");
    expect(written.get("mode")).toBe("cycling");
  });

  it("still reads an existing single-waypoint link as the origin", () => {
    window.history.replaceState(null, "", "/?panel=directions&waypoint=50.78%2C6.08%2CAachen");
    render(<DeepLinkManager />);

    expect(slots()[0]).toMatchObject({ coords: aachen, label: "Aachen" });
    expect(nth(slots(), 1).coords).toBeNull();
  });
});
