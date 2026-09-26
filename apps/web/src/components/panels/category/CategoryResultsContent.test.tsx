import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import type { CategoryPlace } from "@openmapx/core";
import {
  apiClient,
  useCategoryFacetStore,
  useCategorySearchStore,
  useMapStore,
  useOpeningHoursStore,
  usePlaceStore,
  useSettingsStore,
} from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import { MapProvider, useMap } from "@/integration-api/map/MapContext";
import { act, fireEvent, render, screen, waitFor } from "@/test";
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
    expect(screen.getByText("search.failedToLoad")).toBeInTheDocument();
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
    expect(screen.getByText("search.zoomInToSearch")).toBeInTheDocument();
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
    expect(screen.getByText("search.sortShownResults")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "search.sortDistance" }));
    expect(shownOrder()).toEqual(["near", "far"]);
    fireEvent.click(screen.getByRole("button", { name: "search.sortRelevance" }));
    expect(shownOrder()).toEqual(["far", "near"]);
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
    fireEvent.click(screen.getByRole("button", { name: "search.sortRelevance" }));
    expect(shownOrder()).toEqual(["far", "near"]);
  });

  it("preserves choice for filters and map movement, then resets on a new captured search area", () => {
    renderPanel(vi.fn());
    fireEvent.click(screen.getByRole("button", { name: "search.sortDistance" }));
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
    expect(screen.getByRole("button", { name: "search.sortDistance" })).toBeDisabled();
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
    fireEvent.click(screen.getByRole("button", { name: "search.sortDistance" }));
    expect(shownOrder()).toEqual(["near", "far"]);
    expect(screen.getByText("search.distanceFromUserLocation")).toBeInTheDocument();
    act(() => useMapStore.getState().setUserLocation([0, 3]));
    expect(shownOrder()).toEqual(["far", "near"]);
    expect(screen.getByRole("button", { name: "search.sortDistance" })).toHaveAttribute(
      "aria-pressed",
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
