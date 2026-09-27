import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import type { CategoryCardEnrichmentRequest, CategoryPlace, SearchIntent } from "@openmapx/core";
import {
  API_ENDPOINTS,
  ApiClientError,
  ApiRequestAbortedError,
  apiClient,
  useCategoryFacetStore,
  useCategorySearchStore,
  useFilterSearch,
  useMapStore,
  useNlpSearchStore,
  useOpeningHoursStore,
  usePlaceStore,
  useSettingsStore,
} from "@openmapx/core";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchInAreaChip } from "@/components/map/SearchInAreaChip";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import { MapProvider, useMap } from "@/integration-api/map/MapContext";
import { act, createFakeMap, type FakeMap, fireEvent, render, screen, waitFor } from "@/test";
import { createQueryWrapper } from "@/test/query";
import { CategoryResultsContent } from "./CategoryResultsContent";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

// Real explore results come from live Overpass/NLP hooks; the panel tests only
// need to control the shape CategoryResultsContent renders against, so the
// hook is mocked and given an idle default (matches the "no active
// category" state every real disabled query resolves to).
const mockUseExploreReachResults = vi.fn();
vi.mock("@/lib/useExploreReachResults", () => ({
  useExploreReachResults: () => mockUseExploreReachResults(),
}));

beforeEach(() => {
  act(() => {
    useCategorySearchStore.getState().clearCategory();
    useCategoryFacetStore.getState().reset();
    useTravelTimeStore.getState().deactivate();
    useMapStore.getState().setUserLocation(null);
  });
  mockUseExploreReachResults.mockReturnValue({
    filtered: undefined,
    isLoading: false,
    isError: false,
    error: null,
    partial: false,
    truncated: false,
    total: undefined,
    relaxed: [],
    isTransitCategory: false,
    refetch: vi.fn(),
  });
});

// No active category/text query means every underlying search hook stays
// disabled — the panel mounts idle, which is all the tap-to-expand wiring
// under test needs.
function MapProbe({ map }: { map: { zoomIn: () => void; zoomOut: () => void } }) {
  useMap().mapRef.current = map as never;
  return null;
}

function renderPanel(
  snapTo: (detent: "peek" | "mid" | "full") => void,
  map?: { zoomIn: () => void; zoomOut: () => void },
) {
  const Wrapper = createQueryWrapper();
  return render(
    <Wrapper>
      <MapProvider>
        {map && <MapProbe map={map} />}
        <MobileSheetContext.Provider
          value={{ detent: "peek", inSheet: true, isExpanded: false, snapTo }}
        >
          <CategoryResultsContent />
        </MobileSheetContext.Provider>
      </MapProvider>
    </Wrapper>,
  );
}

function ReadyMapProbe({ fake }: { fake: FakeMap }) {
  const { mapRef, notifyMapReady } = useMap();
  useEffect(() => {
    mapRef.current = fake.map;
    notifyMapReady();
  }, [fake, mapRef, notifyMapReady]);
  return null;
}

function ActiveFilterQueryProbe() {
  const filter = useCategorySearchStore((s) => s.adHocFilter);
  const bbox = useCategorySearchStore((s) => s.searchBbox);
  useFilterSearch(filter, bbox);
  return null;
}

function renderReadyPanel(fake: FakeMap, queryProbe = false, searchChip = false) {
  const Wrapper = createQueryWrapper();
  return render(
    <Wrapper>
      <MapProvider>
        <ReadyMapProbe fake={fake} />
        {queryProbe && <ActiveFilterQueryProbe />}
        {searchChip && <SearchInAreaChip />}
        <MobileSheetContext.Provider
          value={{ detent: "peek", inSheet: true, isExpanded: false, snapTo: vi.fn() }}
        >
          <CategoryResultsContent />
        </MobileSheetContext.Provider>
      </MapProvider>
    </Wrapper>,
  );
}

describe("category activation search area", () => {
  const resolved = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };
  const viewport = { west: 7, south: 49, east: 9, north: 51 };
  const later = { west: 10, south: 50, east: 12, north: 52 };
  const filter: SearchIntent["filter"] = {
    selectors: [{ tags: [{ key: "amenity", op: "=", value: "cafe" }] }],
  };
  const intent: SearchIntent = {
    filter,
    spatial_constraint: { type: "near_place", place_name: "Berlin" },
    time_constraint: null,
    sort_by: "relevance",
    unmapped_attributes: [],
    confidence: 1,
    explanation: "cafes near Berlin",
  };

  beforeEach(() => useNlpSearchStore.getState().clear());
  afterEach(() => {
    useNlpSearchStore.getState().clear();
    vi.restoreAllMocks();
  });

  function activateNlp() {
    act(() => {
      useNlpSearchStore.getState().activate(intent, resolved, "test");
      useCategorySearchStore
        .getState()
        .setAdHocFilter(filter, intent.explanation, { source: "nlp" });
      useCategorySearchStore.getState().setSearchBbox(resolved);
      useCategorySearchStore.getState().setMapMoved(true);
    });
  }

  it("keeps resolved NLP bounds as the filter query area when the ready map shows elsewhere", async () => {
    activateNlp();
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({ results: [], partial: false });
    renderReadyPanel(createFakeMap({ bounds: viewport }), true);

    await waitFor(() => expect(useCategorySearchStore.getState().mapMoved).toBe(false));
    expect(useCategorySearchStore.getState().searchBbox).toEqual(resolved);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(
        API_ENDPOINTS.poiFilter,
        expect.objectContaining(resolved),
        expect.any(Object),
      ),
    );
    expect(
      post.mock.calls.every(([, body]) => (body as { west: number }).west === resolved.west),
    ).toBe(true);
  });

  it.each(["category", "brand"] as const)(
    "captures current map bounds for an ordinary %s activation",
    async (kind) => {
      act(() => {
        useCategorySearchStore.getState().setSearchBbox(resolved);
        if (kind === "category") useCategorySearchStore.getState().setActiveCategory("restaurants");
        else
          useCategorySearchStore
            .getState()
            .setBrandFilter({ qid: "Q1", name: "Example", kind: ["brand"] }, filter);
      });
      renderReadyPanel(createFakeMap({ bounds: viewport }));
      await waitFor(() => expect(useCategorySearchStore.getState().searchBbox).toEqual(viewport));
    },
  );

  it("allows an intentional later auto-refresh to replace the resolved NLP area", async () => {
    activateNlp();
    const mapOptions = { bounds: viewport };
    const fake = createFakeMap(mapOptions);
    act(() => useCategorySearchStore.getState().setAutoRefresh(true));
    renderReadyPanel(fake);
    await waitFor(() => expect(useCategorySearchStore.getState().mapMoved).toBe(false));
    expect(useCategorySearchStore.getState().searchBbox).toEqual(resolved);

    mapOptions.bounds = later;
    act(() => fake.emit("moveend", {}));
    expect(useCategorySearchStore.getState().searchBbox).toEqual(later);
  });

  it("allows Search this area after a pan to replace the resolved NLP area", async () => {
    activateNlp();
    vi.spyOn(apiClient, "get").mockResolvedValue({ sources: [] });
    const mapOptions = { bounds: viewport };
    const fake = createFakeMap(mapOptions);
    renderReadyPanel(fake, false, true);
    await waitFor(() => expect(useCategorySearchStore.getState().mapMoved).toBe(false));
    expect(useCategorySearchStore.getState().searchBbox).toEqual(resolved);

    mapOptions.bounds = later;
    act(() => fake.emit("moveend", {}));
    expect(useCategorySearchStore.getState().mapMoved).toBe(true);
    fireEvent.click(screen.getByText("search.searchInArea"));
    expect(useCategorySearchStore.getState().searchBbox).toEqual(later);
  });
});

describe("CategoryResultsContent mobile sheet interactions", () => {
  it("tapping the collapsed results list expands the sheet to mid", () => {
    const snapTo = vi.fn();
    const { container } = renderPanel(snapTo);

    fireEvent.click(container.firstElementChild as Element);

    expect(snapTo).toHaveBeenCalledWith("mid");
  });

  it("does nothing once the sheet is past peek", () => {
    const snapTo = vi.fn();
    const Wrapper = createQueryWrapper();
    const { container } = render(
      <Wrapper>
        <MapProvider>
          <MobileSheetContext.Provider
            value={{ detent: "mid", inSheet: true, isExpanded: true, snapTo }}
          >
            <CategoryResultsContent />
          </MobileSheetContext.Provider>
        </MapProvider>
      </Wrapper>,
    );

    fireEvent.click(container.firstElementChild as Element);

    expect(snapTo).not.toHaveBeenCalled();
  });
});

describe("CategoryResultsContent recovery", () => {
  const bbox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };

  it("announces advisory result notices politely without interrupting the results", () => {
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: true,
      truncated: true,
      total: 300,
      relaxed: [{ key: "diet:vegan", op: "=", value: "yes" }],
      isTransitCategory: false,
    });
    renderPanel(vi.fn());

    const statuses = screen.getAllByRole("status");
    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toHaveTextContent("search.partialResults");
    expect(statuses[1]).toHaveTextContent("search.relaxedFilters");
    expect(screen.queryByText(/search.truncatedResults/)).toBeNull();
  });

  it("offers retry for a failed request and does not call it for a valid empty result", () => {
    const refetch = vi.fn();
    const stalePlace = {
      id: "stale-place",
      name: "Cached cafe",
      coordinates: [13.4, 52.5],
    } as CategoryPlace;
    mockUseExploreReachResults.mockReturnValue({
      filtered: [stalePlace],
      isLoading: false,
      isError: true,
      error: new Error("offline"),
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch,
    });
    const view = renderPanel(vi.fn());
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("search.failedToLoad");
    expect(notice.contains(screen.getByRole("button", { name: "common.retry" }))).toBe(true);
    expect(notice).not.toHaveTextContent("common.retry");
    expect(screen.queryByText("search.noResultsFound")).toBeNull();
    expect(screen.queryByText("Cached cafe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);

    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch,
    });
    view.unmount();
    renderPanel(vi.fn());
    expect(screen.getByText("search.noResultsFound")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("offers zoom in for an oversized area without blindly retrying", () => {
    const refetch = vi.fn();
    const zoomIn = vi.fn();
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: true,
      error: new Error("area_too_large"),
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch,
    });
    renderPanel(vi.fn(), { zoomIn, zoomOut: vi.fn() });
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("search.zoomInToSearch");
    expect(notice.contains(screen.getByRole("button", { name: "map.zoomIn" }))).toBe(true);
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "map.zoomIn" }));
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });

  it("clears hours, every facet and reachability while preserving the search area", () => {
    act(() => {
      useCategorySearchStore.getState().setActiveCategory("restaurants");
      useCategorySearchStore.getState().setSearchBbox(bbox);
      useOpeningHoursStore.getState().setOpenAtFilter(2, 14);
      useCategoryFacetStore.getState().toggleFacet("outdoorSeating");
      useCategoryFacetStore.getState().toggleFacet("wheelchairAccessible");
      useCategoryFacetStore.getState().setMultiFacet("cuisine", ["italian"]);
      useCategoryFacetStore.getState().setMultiFacet("brand", ["Q123"]);
      useTravelTimeStore.getState().activateAnchored([13.4, 52.5]);
      useTravelTimeStore.getState().setOnlyWithinReach(true);
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch: vi.fn(),
    });
    renderPanel(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "search.clearFilters" }));

    expect(useOpeningHoursStore.getState()).toMatchObject({
      openingHoursFilter: "any",
      openAtDay: null,
      openAtHour: null,
    });
    expect(useCategoryFacetStore.getState().selections).toEqual({});
    expect(useTravelTimeStore.getState()).toMatchObject({
      isActive: true,
      anchored: true,
      onlyWithinReach: false,
      origin: [13.4, 52.5],
    });
    expect(useCategorySearchStore.getState()).toMatchObject({
      activeCategory: "restaurants",
      searchBbox: bbox,
    });
  });

  it("clears ad-hoc require and exclude predicates while retaining the selector and bounds", () => {
    const filter = {
      selectors: [{ tags: [{ key: "amenity", op: "=" as const, value: "cafe" }] }],
      require: [{ key: "outdoor_seating", op: "=" as const, value: "yes" }],
      exclude: [{ key: "smoking", op: "=" as const, value: "yes" }],
    };
    act(() => {
      useCategorySearchStore.getState().setAdHocFilter(filter, "Outdoor cafes");
      useCategorySearchStore.getState().setSearchBbox(bbox);
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch: vi.fn(),
    });
    renderPanel(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "search.clearFilters" }));

    expect(useCategorySearchStore.getState()).toMatchObject({
      activeCategory: "nlp:filter",
      searchBbox: bbox,
      adHocLabel: "",
      adHocFilter: { selectors: filter.selectors },
    });
    expect(useCategorySearchStore.getState().adHocFilter?.require).toBeUndefined();
    expect(useCategorySearchStore.getState().adHocFilter?.exclude).toBeUndefined();
  });

  it("clears text-result facets without changing the text query or bounds", () => {
    act(() => {
      useCategorySearchStore.getState().setExploreText("coffee shops");
      useCategorySearchStore.getState().setSearchBbox(bbox);
      useCategoryFacetStore.getState().toggleFacet("outdoorSeating");
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch: vi.fn(),
    });
    renderPanel(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "search.clearFilters" }));

    expect(useCategoryFacetStore.getState().selections).toEqual({});
    expect(useCategorySearchStore.getState()).toMatchObject({
      mode: "text",
      textQuery: "coffee shops",
      searchBbox: bbox,
    });
  });

  it("shows a transit request failure instead of an empty-stop message and retries its query", async () => {
    const get = vi
      .spyOn(apiClient, "get")
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ data: [], attributions: [], freshness: undefined } as never);
    act(() => {
      useCategorySearchStore.getState().setActiveCategory("transit");
      useCategorySearchStore.getState().setSearchBbox(bbox);
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: undefined,
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: true,
      refetch: vi.fn(),
    });
    renderPanel(vi.fn());
    await waitFor(() => expect(screen.getByText("search.failedToLoad")).toBeInTheDocument(), {
      timeout: 3_000,
    });
    expect(
      screen.getByRole("alert").contains(screen.getByRole("button", { name: "common.retry" })),
    ).toBe(true);
    expect(screen.queryByText("search.noStopsFound")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    await waitFor(() => expect(screen.getByText("search.noStopsFound")).toBeInTheDocument());
    expect(get).toHaveBeenCalledTimes(3);
  });

  it("offers zoom in for an oversized transit stop area instead of retry", async () => {
    const get = vi.spyOn(apiClient, "get").mockRejectedValue(new Error("area_too_large"));
    const zoomIn = vi.fn();
    act(() => {
      useCategorySearchStore.getState().setActiveCategory("transit");
      useCategorySearchStore.getState().setSearchBbox(bbox);
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: undefined,
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: true,
      refetch: vi.fn(),
    });
    renderPanel(vi.fn(), { zoomIn, zoomOut: vi.fn() });
    await waitFor(() => expect(screen.getByText("search.zoomInToSearch")).toBeInTheDocument());
    expect(
      screen.getByRole("status").contains(screen.getByRole("button", { name: "map.zoomIn" })),
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "map.zoomIn" }));
    expect(zoomIn).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("offers an explicit map action for an unconstrained empty search", () => {
    const zoomOut = vi.fn();
    act(() => {
      useCategorySearchStore.getState().setActiveCategory("restaurants");
      useCategorySearchStore.getState().setSearchBbox(bbox);
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
      refetch: vi.fn(),
    });
    renderPanel(vi.fn(), { zoomIn: vi.fn(), zoomOut });
    expect(screen.getByText("search.moveMapToSearch")).toBeInTheDocument();
    expect(useCategorySearchStore.getState().searchBbox).toEqual(bbox);
    fireEvent.click(screen.getByRole("button", { name: "map.zoomOut" }));
    expect(zoomOut).toHaveBeenCalledTimes(1);
    expect(useCategorySearchStore.getState().searchBbox).toEqual(bbox);
  });
});

describe("category place hours", () => {
  it("keeps uncertain syntax off the result button while allowing selection", () => {
    const place = {
      id: "unknown-hours",
      name: "Café Maybe",
      coordinates: [13.4, 52.5],
      openingHours: "Mo-Fr 09:00-17:00; PH off",
      openingHoursInfo: {
        status: { isOpen: false, isUnknown: true, text: "Mo-Fr 09:00-17:00; PH off" },
      },
    } as CategoryPlace;
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: 1,
      relaxed: [],
      isTransitCategory: false,
    });

    renderPanel(vi.fn());
    const result = screen.getByRole("button", { name: /Café Maybe/ });
    expect(result).toHaveTextContent("openingHours.unconfirmed");
    expect(result).not.toHaveTextContent("Mo-Fr 09:00-17:00; PH off");
    fireEvent.click(result);
    expect(usePlaceStore.getState().selectedPlace?.openingHours).toBe(place.openingHours);
  });
});

describe("category result activation", () => {
  it("keeps touch hover inert and selects on the first native click", () => {
    const place = {
      id: "osm:node/91",
      name: "Touch cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    renderPanel(vi.fn());
    const row = screen.getByRole("button", { name: /Touch cafe/ });
    fireEvent.pointerEnter(row, { pointerType: "touch" });
    fireEvent.mouseEnter(row);
    expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBeNull();
    fireEvent.click(row);
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Touch cafe");
  });

  it("still synchronizes real mouse hover with the map", () => {
    const place = {
      id: "osm:node/92",
      name: "Mouse cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    renderPanel(vi.fn());
    const row = screen.getByRole("button", { name: /Mouse cafe/ });
    fireEvent.pointerEnter(row, { pointerType: "mouse" });
    expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBe(place.id);
    fireEvent.pointerLeave(row, { pointerType: "mouse" });
    expect(useCategorySearchStore.getState().hoveredCategoryPlaceId).toBeNull();
  });
});

describe("visible category card enrichment", () => {
  function mountVisibleCards(places: CategoryPlace[]) {
    let notifyIntersection: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: places,
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    const view = renderPanel(vi.fn());
    const intersect = (ids: string[], isIntersecting = true) => {
      act(() =>
        notifyIntersection(
          ids.map((id) => ({
            target: observed.find((row) => row.getAttribute("data-card-id") === id),
            isIntersecting,
          })) as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
    };
    return { intersect, view, observed };
  }

  async function advanceCardTimers(milliseconds: number) {
    await act(async () => vi.advanceTimersByTimeAsync(milliseconds));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a transient batch failure once and displays the recovered photo", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let notifyIntersection: IntersectionObserverCallback = () => {};
    let observed: Element | undefined;
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }
      observe(element: Element) {
        observed = element;
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const place = {
      id: "osm:node/recover",
      name: "Recovering cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValue({
        results: [
          {
            id: place.id,
            photo: { url: "https://upload.wikimedia.org/Recovered.jpg", source: "osm" },
            outcomes: { photo: { status: "available" }, rating: { status: "absent" } },
          },
        ],
      } as never);
    act(() => useCategorySearchStore.setState({ activeCategory: "cafes" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    try {
      renderPanel(vi.fn());
      act(() =>
        notifyIntersection(
          [{ target: observed, isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await act(async () => vi.advanceTimersByTimeAsync(50));
      expect(post).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(2_500));
      expect(post).toHaveBeenCalledTimes(2);
      expect(
        screen.getByRole("button", { name: /Recovering cafe/ }).querySelector("img"),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("retries only a failed rating and preserves the successful photo", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const place = {
      id: "osm:node/partial",
      name: "Partial cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const photo = { url: "https://upload.wikimedia.org/Partial.jpg", source: "osm" };
    let calls = 0;
    const post = vi.spyOn(apiClient, "post").mockImplementation(
      async () =>
        (++calls === 1
          ? {
              results: [
                {
                  id: place.id,
                  photo,
                  outcomes: {
                    photo: { status: "available" },
                    rating: { status: "failed", retryAfterMs: 100 },
                  },
                },
              ],
            }
          : {
              results: [
                {
                  id: place.id,
                  rating: { stars: 4.2, count: 4, source: "mangrove" },
                  outcomes: { rating: { status: "available" } },
                },
              ],
            }) as never,
    );
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    expect(screen.getByRole("button", { name: /Partial cafe/ }).querySelector("img")).toBeTruthy();
    await advanceCardTimers(2_500);
    expect(post).toHaveBeenCalledTimes(2);
    expect((post.mock.calls[1]?.[1] as CategoryCardEnrichmentRequest).places[0]?.fields).toEqual([
      "rating",
    ]);
    const row = screen.getByRole("button", { name: /Partial cafe/ });
    expect(row.querySelector("img")).toBeTruthy();
    expect(row).toHaveTextContent("4.2");
  });

  it("does not retry a confirmed absence or a permanent invalid request", async () => {
    vi.useFakeTimers();
    const absent = {
      id: "osm:node/absent",
      name: "Absent cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const invalid = {
      id: "osm:node/invalid",
      name: "Invalid cafe",
      coordinates: [6.09, 50.77],
    } as CategoryPlace;
    let calls = 0;
    const post = vi.spyOn(apiClient, "post").mockImplementation(async () => {
      if (++calls === 1)
        return {
          results: [
            {
              id: absent.id,
              outcomes: { photo: { status: "absent" }, rating: { status: "absent" } },
            },
          ],
        } as never;
      throw new ApiClientError(400, null, null);
    });
    const { intersect } = mountVisibleCards([absent, invalid]);
    intersect([absent.id]);
    await advanceCardTimers(50);
    intersect([invalid.id]);
    await advanceCardTimers(50);
    await advanceCardTimers(5_000);
    intersect([absent.id, invalid.id]);
    await advanceCardTimers(100);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("does not retry an explicitly aborted request", async () => {
    vi.useFakeTimers();
    const place = {
      id: "osm:node/abort",
      name: "Aborted cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValue(new ApiRequestAbortedError("aborted"));
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    await advanceCardTimers(3_000);
    intersect([place.id]);
    await advanceCardTimers(100);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("treats an omitted item as a failure and retries it once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const place = {
      id: "osm:node/omitted",
      name: "Omitted cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    let calls = 0;
    const post = vi.spyOn(apiClient, "post").mockImplementation(
      async () =>
        (++calls === 1
          ? { results: [] }
          : {
              results: [
                {
                  id: place.id,
                  photo: { url: "https://upload.wikimedia.org/Omitted.jpg", source: "osm" },
                  outcomes: { photo: { status: "available" }, rating: { status: "absent" } },
                },
              ],
            }) as never,
    );
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    expect(screen.getByRole("button", { name: /Omitted cafe/ }).querySelector("img")).toBeNull();
    await advanceCardTimers(2_500);
    expect(post).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /Omitted cafe/ }).querySelector("img")).toBeTruthy();
  });

  it("caps dispatches across same-search effect resets even when requests are cancelled", async () => {
    vi.useFakeTimers();
    const place = {
      id: "osm:node/rerender",
      name: "Rerender cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi.spyOn(apiClient, "post").mockImplementation(
      async (_path, _body, options) =>
        new Promise((_resolve, reject) => {
          (options as { signal?: AbortSignal })?.signal?.addEventListener("abort", () =>
            reject(new ApiRequestAbortedError("aborted")),
          );
        }),
    );
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    expect(post).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 2; i++) {
      mockUseExploreReachResults.mockReturnValue({
        filtered: [place],
        isLoading: false,
        isError: false,
        partial: false,
        isTransitCategory: false,
      });
      act(() =>
        useOpeningHoursStore.setState({ openingHoursFilter: i === 0 ? "open_now" : "any" }),
      );
      intersect([place.id]);
      await advanceCardTimers(50);
    }
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("refreshes confirmed card data after each cache TTL", async () => {
    vi.useFakeTimers();
    const place = {
      id: "osm:node/ttl",
      name: "TTL cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      results: [
        { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
      ],
    } as never);
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    for (let i = 0; i < 2; i++) {
      await advanceCardTimers(600_001);
      intersect([place.id]);
      await advanceCardTimers(50);
    }
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("waits for HTTP Retry-After before retrying a rate-limited request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const place = {
      id: "osm:node/rate-limit",
      name: "Rate limited cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(new ApiClientError(429, null, 5))
      .mockResolvedValue({
        results: [
          { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
        ],
      } as never);
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    await advanceCardTimers(4_900);
    expect(post).toHaveBeenCalledTimes(1);
    await advanceCardTimers(150);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("retries an upstream 408 request timeout once", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const place = {
      id: "osm:node/upstream-timeout",
      name: "Upstream timeout cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(new ApiClientError(408, null, null))
      .mockResolvedValue({
        results: [
          { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
        ],
      } as never);
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    await advanceCardTimers(2_500);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("keeps a distant server retry time within the timer range", async () => {
    vi.useFakeTimers();
    const place = {
      id: "osm:node/long-wait",
      name: "Long wait cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      results: [
        {
          id: place.id,
          outcomes: {
            photo: { status: "failed", retryAfterMs: 3_000_000_000 },
            rating: { status: "absent" },
          },
        },
      ],
    } as never);
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    expect(post).toHaveBeenCalledTimes(1);
    expect(
      timeout.mock.calls.every(([, delay]) => typeof delay !== "number" || delay <= 2_147_483_647),
    ).toBe(true);
  });

  it("defers a failed field while its row is out of view", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const place = {
      id: "osm:node/scrolled",
      name: "Scrolled cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValue({
        results: [
          { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
        ],
      } as never);
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    intersect([place.id], false);
    await advanceCardTimers(3_000);
    expect(post).toHaveBeenCalledTimes(1);
    intersect([place.id]);
    await advanceCardTimers(50);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("defers a retry while offline or the document is hidden", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let online = true;
    let visibility: DocumentVisibilityState = "visible";
    const originalOnline = Object.getOwnPropertyDescriptor(navigator, "onLine");
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    });
    const place = {
      id: "osm:node/paused",
      name: "Paused cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    const post = vi
      .spyOn(apiClient, "post")
      .mockRejectedValueOnce(new TypeError("Network failed"))
      .mockResolvedValue({
        results: [
          { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
        ],
      } as never);
    const { intersect } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    online = false;
    act(() => window.dispatchEvent(new Event("offline")));
    await advanceCardTimers(3_000);
    expect(post).toHaveBeenCalledTimes(1);
    online = true;
    visibility = "hidden";
    act(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advanceCardTimers(100);
    expect(post).toHaveBeenCalledTimes(1);
    visibility = "visible";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advanceCardTimers(50);
    expect(post).toHaveBeenCalledTimes(2);
    if (originalOnline) Object.defineProperty(navigator, "onLine", originalOnline);
    else Reflect.deleteProperty(navigator, "onLine");
    if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  });

  it("clears delayed retries and aborts in-flight work on unmount", async () => {
    vi.useFakeTimers();
    const place = {
      id: "osm:node/unmount",
      name: "Unmount cafe",
      coordinates: [6.08, 50.77],
    } as CategoryPlace;
    let signal: AbortSignal | undefined;
    const post = vi.spyOn(apiClient, "post").mockImplementation(async (_path, _body, options) => {
      signal = (options as { signal?: AbortSignal })?.signal;
      return new Promise((_resolve, reject) =>
        signal?.addEventListener("abort", () => reject(new ApiRequestAbortedError("aborted"))),
      );
    });
    const { intersect, view } = mountVisibleCards([place]);
    intersect([place.id]);
    await advanceCardTimers(50);
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await advanceCardTimers(3_000);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("drops malformed image tags so one bad row does not reject its visible batch", async () => {
    let notifyIntersection: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const places = [
      {
        id: "osm:node/8",
        name: "Bad image tag",
        coordinates: [6.08, 50.77],
        osmTags: { image: "https://", wikipedia: "localhost/:Article" },
      },
      {
        id: "osm:node/9",
        name: "Good image tag",
        coordinates: [6.09, 50.77],
        osmTags: { image: "File:Good.jpg" },
      },
    ] as CategoryPlace[];
    const post = vi
      .spyOn(apiClient, "post")
      .mockResolvedValue({ results: places.map(({ id }) => ({ id })) } as never);
    act(() => useCategorySearchStore.setState({ activeCategory: "museums" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: places,
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    try {
      renderPanel(vi.fn());
      act(() =>
        notifyIntersection(
          observed.map((target) => ({
            target,
            isIntersecting: true,
          })) as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(
        (
          post.mock.calls[0]?.[1] as { places: Array<{ photoTags?: Record<string, string> }> }
        ).places.map((place) => place.photoTags),
      ).toEqual([{}, { image: "File:Good.jpg" }]);
    } finally {
      vi.unstubAllGlobals();
      post.mockRestore();
    }
  });
  it("loads only intersecting rows and reuses their summaries on repeat visibility", async () => {
    let notifyIntersection: IntersectionObserverCallback = () => {};
    const observed: Element[] = [];
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const post = vi.spyOn(apiClient, "post").mockImplementation(
      async (_path, body) =>
        ({
          results: (body as { places: CategoryPlace[] }).places.map((place) => ({ id: place.id })),
        }) as never,
    );
    const places = Array.from({ length: 200 }, (_, index) => ({
      id: `osm:node/${index + 1}`,
      name: `Museum ${index + 1}`,
      coordinates: [6.08 + index * 0.00001, 50.77],
      osmTags: { wikidata: `Q${index + 1}` },
    })) as CategoryPlace[];
    act(() => useCategorySearchStore.setState({ activeCategory: "museums" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: places,
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    try {
      renderPanel(vi.fn());
      expect(post).not.toHaveBeenCalled();
      const first = observed.find((node) => node.getAttribute("data-card-id") === places[0].id);
      const second = observed.find((node) => node.getAttribute("data-card-id") === places[1].id);
      const offscreen = observed.find(
        (node) => node.getAttribute("data-card-id") === places[199].id,
      );
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      expect(offscreen).toBeDefined();
      act(() =>
        notifyIntersection(
          [
            { target: first, isIntersecting: true },
            { target: second, isIntersecting: true },
            {
              target: offscreen,
              isIntersecting: true,
              boundingClientRect: { top: 1400, bottom: 1500, left: 0, right: 200 },
            },
          ] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      expect(
        (post.mock.calls[0]?.[1] as { places: CategoryPlace[] }).places.map((place) => place.id),
      ).toEqual([places[0].id, places[1].id]);
      act(() =>
        notifyIntersection(
          [
            { target: first, isIntersecting: true },
            { target: second, isIntersecting: true },
          ] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(post).toHaveBeenCalledTimes(1);
      const later = Date.now() + 600_001;
      vi.spyOn(Date, "now").mockReturnValue(later);
      act(() =>
        notifyIntersection(
          [{ target: first, isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      post.mockRestore();
    }
  });

  it("shows credited photo and sourced rating outside an independent attribution link", async () => {
    let notifyIntersection: IntersectionObserverCallback = () => {};
    let observed: Element | undefined;
    class Observer {
      constructor(callback: IntersectionObserverCallback) {
        notifyIntersection = callback;
      }
      observe(element: Element) {
        observed = element;
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const place = {
      id: "osm:way/20470246",
      name: "Aachener Dom",
      coordinates: [6.08, 50.77],
      osmTags: { wikimedia_commons: "File:Dom.jpg" },
    } as CategoryPlace;
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Dom.jpg",
      source: "wikimedia",
      author: "Draupnir3",
      authorUrl: "https://commons.wikimedia.org/wiki/User:Draupnir3",
      license: "CC BY-SA 3.0",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Dom.jpg",
    };
    const post = vi.spyOn(apiClient, "post").mockResolvedValue({
      results: [{ id: place.id, photo, rating: { stars: 4.3, count: 12, source: "mangrove" } }],
    } as never);
    act(() => useCategorySearchStore.setState({ activeCategory: "museums" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    try {
      const { container } = renderPanel(vi.fn());
      act(() =>
        notifyIntersection(
          [{ target: observed, isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      const credit = await screen.findByRole("link", { name: "Draupnir3" });
      const row = screen.getByRole("button", { name: /Aachener Dom/ });
      expect(row).toHaveTextContent("4.3");
      expect(row).toHaveTextContent("12");
      expect(row).toHaveTextContent("ratedReviews");
      expect(row).toHaveTextContent("mangrove");
      expect(row.contains(credit)).toBe(false);
      const image = container.querySelector('img[src*="image-proxy"]') as HTMLImageElement;
      expect(image).toBeInTheDocument();
      fireEvent.click(credit);
      expect(usePlaceStore.getState().selectedPlace?.name).not.toBe(place.name);
      fireEvent.error(image);
      expect(container.querySelector('img[src*="image-proxy"]')).toBeNull();
      expect(screen.queryByRole("link", { name: "Draupnir3" })).toBeNull();
      expect(row).toHaveTextContent("4.3");
    } finally {
      vi.unstubAllGlobals();
      post.mockRestore();
    }
  });

  it("refetches changed photo tags and ignores a late result from the old search", async () => {
    const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
    class Observer {
      private current: { callback: IntersectionObserverCallback; targets: Element[] };
      constructor(callback: IntersectionObserverCallback) {
        this.current = { callback, targets: [] };
        observers.push(this.current);
      }
      observe(element: Element) {
        this.current.targets.push(element);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Observer);
    const first = {
      id: "osm:way/1",
      name: "Changed place",
      coordinates: [6.08, 50.77],
      osmTags: { image: "File:Old.jpg" },
    } as CategoryPlace;
    const second = { ...first, osmTags: { image: "File:New.jpg" } };
    let releaseOld: (value: unknown) => void = () => {};
    let calls = 0;
    const post = vi.spyOn(apiClient, "post").mockImplementation(() => {
      calls++;
      if (calls === 1)
        return new Promise((resolve) => {
          releaseOld = resolve;
        }) as never;
      return Promise.resolve({
        results: [
          { id: first.id, photo: { url: "https://upload.wikimedia.org/New.jpg", source: "osm" } },
        ],
      }) as never;
    });
    act(() => useCategorySearchStore.setState({ activeCategory: "museums" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [first],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
    });
    try {
      renderPanel(vi.fn());
      const old = observers.at(-1);
      if (!old) throw new Error("Expected observer for original search");
      act(() =>
        old.callback(
          [{ target: old.targets[0], isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
      mockUseExploreReachResults.mockReturnValue({
        filtered: [second],
        isLoading: false,
        isError: false,
        partial: false,
        isTransitCategory: false,
      });
      act(() =>
        useCategorySearchStore.setState({
          searchRevision: useCategorySearchStore.getState().searchRevision + 1,
        }),
      );
      const current = observers.at(-1);
      if (!current) throw new Error("Expected observer for revised search");
      act(() =>
        current.callback(
          [{ target: current.targets[0], isIntersecting: true }] as IntersectionObserverEntry[],
          {} as IntersectionObserver,
        ),
      );
      await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
      releaseOld({
        results: [
          { id: first.id, photo: { url: "https://upload.wikimedia.org/Old.jpg", source: "osm" } },
        ],
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { name: /Changed place/ })
            .querySelector("img")
            ?.getAttribute("src"),
        ).toContain("New.jpg"),
      );
      expect(
        screen
          .getByRole("button", { name: /Changed place/ })
          .querySelector("img")
          ?.getAttribute("src"),
      ).not.toContain("Old.jpg");
    } finally {
      vi.unstubAllGlobals();
      post.mockRestore();
    }
  });
});

describe("category result details", () => {
  const place = {
    id: "cafe",
    name: "Café",
    coordinates: [0, 0.01],
    osmTags: { cuisine: "italian", outdoor_seating: "yes", wheelchair: "limited" },
  } as CategoryPlace;

  it("shows at most two known attributes and metric distance from the shared search reference", () => {
    act(() => useSettingsStore.setState({ units: "metric" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
      distanceReference: { kind: "search_origin", coordinates: [0, 0], name: "Station" },
    });
    renderPanel(vi.fn());
    const row = screen.getByRole("button", { name: /Café/ });
    expect(row).toHaveTextContent("1.1 km");
    expect(row).toHaveTextContent("Italian");
    expect(row).toHaveTextContent("place.outdoorSeating");
    expect(row).not.toHaveTextContent("place.wheelchairLimited");
    expect(screen.getByText("search.distanceFromOrigin")).toBeInTheDocument();
  });

  it("uses imperial units and omits distance for bad coordinates", () => {
    act(() => useSettingsStore.setState({ units: "imperial" }));
    mockUseExploreReachResults.mockReturnValue({
      filtered: [place, { ...place, id: "bad", name: "Bad", coordinates: [Number.NaN, 0] }],
      isLoading: false,
      isError: false,
      partial: false,
      isTransitCategory: false,
      distanceReference: { kind: "search_area_center", coordinates: [0, 0] },
    });
    renderPanel(vi.fn());
    expect(screen.getByRole("button", { name: /Café/ })).toHaveTextContent("3648 ft");
    expect(screen.getByRole("button", { name: /Bad/ })).not.toHaveTextContent(/mi|ft/);
    expect(screen.getByText("search.distanceFromAreaCenter")).toBeInTheDocument();
  });
});

describe("category result ordering", () => {
  const far = { id: "far", name: "Far", coordinates: [0, 2] } as CategoryPlace;
  const near = { id: "near", name: "Near", coordinates: [0, 0.1] } as CategoryPlace;
  const bbox = { west: -1, east: 1, south: -1, north: 1 };

  function shownOrder() {
    const farButton = screen.getByRole("button", { name: /Far/ });
    const nearButton = screen.getByRole("button", { name: /Near/ });
    return farButton.compareDocumentPosition(nearButton) & Node.DOCUMENT_POSITION_FOLLOWING
      ? ["far", "near"]
      : ["near", "far"];
  }

  function openSortMenu() {
    fireEvent.click(screen.getByRole("button", { name: /search.sortShownResults/ }));
  }

  function chooseSort(name: string) {
    openSortMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name }));
  }

  beforeEach(() => {
    act(() => {
      useCategorySearchStore.getState().setActiveCategory("cafes");
      useCategorySearchStore.getState().setSearchBbox(bbox);
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [far, near],
      providerFiltered: [far, near],
      defaultSort: undefined,
      isLoading: false,
      isError: false,
      partial: false,
      truncated: true,
      total: 300,
      isTransitCategory: false,
      distanceReference: { kind: "search_area_center", coordinates: [0, 0] },
    });
  });

  it("keeps provider order by default and sorts only shown rows after a distance choice", () => {
    renderPanel(vi.fn());
    expect(shownOrder()).toEqual(["far", "near"]);
    expect(
      screen.getByRole("button", { name: /search.sortShownResults: search.sortRelevance/ }),
    ).toBeInTheDocument();
    chooseSort("search.sortDistance");
    expect(shownOrder()).toEqual(["near", "far"]);
    chooseSort("search.sortRelevance");
    expect(shownOrder()).toEqual(["far", "near"]);
  });

  it("supports keyboard sort selection and closes the menu", () => {
    renderPanel(vi.fn());
    openSortMenu();
    const relevance = screen.getByRole("menuitemradio", { name: "search.sortRelevance" });
    const distance = screen.getByRole("menuitemradio", { name: "search.sortDistance" });
    expect(relevance).toHaveAttribute("aria-checked", "true");
    relevance.focus();
    fireEvent.keyDown(relevance, { key: "ArrowDown" });
    expect(distance).toHaveFocus();
    fireEvent.keyDown(distance, { key: "Enter" });
    expect(shownOrder()).toEqual(["near", "far"]);
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("keeps the sort menu closed when results return after loading", () => {
    renderPanel(vi.fn());
    openSortMenu();
    expect(screen.getByRole("menuitemradio", { name: "search.sortRelevance" })).toBeInTheDocument();

    const ready = mockUseExploreReachResults() as Record<string, unknown>;
    mockUseExploreReachResults.mockReturnValue({ ...ready, isLoading: true });
    act(() => useOpeningHoursStore.getState().setOpeningHoursFilter("open_now"));
    expect(screen.queryByRole("menuitemradio")).toBeNull();

    mockUseExploreReachResults.mockReturnValue(ready);
    act(() => useOpeningHoursStore.getState().reset());
    expect(screen.getByRole("button", { name: /search.sortShownResults/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByRole("menuitemradio")).toBeNull();
  });

  it("lets the labelled map-update row toggle while results load", () => {
    mockUseExploreReachResults.mockReturnValue({
      ...(mockUseExploreReachResults() as Record<string, unknown>),
      isLoading: true,
    });
    renderPanel(vi.fn());
    expect(screen.queryByRole("button", { name: /search.sortShownResults/ })).toBeNull();
    const updateSwitch = screen.getByRole("switch", { name: "search.updateOnMapMove" });
    expect(updateSwitch).not.toBeChecked();
    fireEvent.click(screen.getByText("search.updateOnMapMove"));
    expect(updateSwitch).toBeChecked();
    expect(useCategorySearchStore.getState().autoRefresh).toBe(true);
  });

  it("restores provider rank from an NLP distance default when Relevance is chosen", () => {
    mockUseExploreReachResults.mockReturnValue({
      ...(mockUseExploreReachResults() as Record<string, unknown>),
      filtered: [near, far],
      providerFiltered: [far, near],
      defaultSort: "distance",
    });
    renderPanel(vi.fn());
    expect(shownOrder()).toEqual(["near", "far"]);
    chooseSort("search.sortRelevance");
    expect(shownOrder()).toEqual(["far", "near"]);
  });

  it("preserves choice for filters and map movement, then resets on a new captured search area", () => {
    renderPanel(vi.fn());
    chooseSort("search.sortDistance");
    act(() => {
      useOpeningHoursStore.getState().setOpeningHoursFilter("open_now");
      useCategoryFacetStore.getState().toggleFacet("outdoorSeating");
      useCategorySearchStore.getState().setMapMoved(true);
    });
    expect(shownOrder()).toEqual(["near", "far"]);
    act(() => useCategorySearchStore.getState().setSearchBbox({ ...bbox, east: 2 }));
    expect(shownOrder()).toEqual(["far", "near"]);
  });

  it("disables Distance when the search has no usable origin", () => {
    mockUseExploreReachResults.mockReturnValue({
      ...(mockUseExploreReachResults() as Record<string, unknown>),
      distanceReference: null,
    });
    renderPanel(vi.fn());
    openSortMenu();
    expect(screen.getByRole("menuitemradio", { name: "search.sortDistance" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("keeps Distance selected while a live location fix changes the shared reference", () => {
    act(() => useMapStore.getState().setUserLocation([0, 0]));
    const base = mockUseExploreReachResults() as Record<string, unknown>;
    mockUseExploreReachResults.mockImplementation(() => {
      const userLocation = useMapStore((s) => s.userLocation);
      return {
        ...base,
        distanceReference: userLocation && {
          kind: "user_location",
          coordinates: userLocation,
        },
      };
    });
    renderPanel(vi.fn());
    chooseSort("search.sortDistance");
    expect(shownOrder()).toEqual(["near", "far"]);
    expect(screen.getByText("search.distanceFromUserLocation")).toBeInTheDocument();
    act(() => useMapStore.getState().setUserLocation([0, 3]));
    expect(shownOrder()).toEqual(["far", "near"]);
    expect(
      screen.getByRole("button", { name: /search.sortShownResults: search.sortDistance/ }),
    ).toBeInTheDocument();
    openSortMenu();
    expect(screen.getByRole("menuitemradio", { name: "search.sortDistance" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });
});

describe("CategoryResultsContent brand empty state", () => {
  it("shows the brand-specific empty message when a brand search has no results in view", () => {
    act(() => {
      useCategorySearchStore
        .getState()
        .setBrandFilter(
          { qid: "Q41171", name: "Aldi", kind: ["brand"], description: "German supermarket chain" },
          { selectors: [{ tags: [{ key: "brand:wikidata", op: "=", value: "Q41171" }] }] },
        );
    });
    mockUseExploreReachResults.mockReturnValue({
      filtered: [],
      isLoading: false,
      isError: false,
      error: null,
      partial: false,
      truncated: false,
      total: undefined,
      relaxed: [],
      isTransitCategory: false,
    });

    renderPanel(vi.fn());

    expect(screen.getByText("search.noBrandLocationsInView")).toBeInTheDocument();
    expect(screen.queryByText("search.noResultsFound")).not.toBeInTheDocument();
  });
});
