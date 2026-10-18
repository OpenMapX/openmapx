import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import type { QueryClient } from "@tanstack/react-query";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import {
  act,
  createFakeMap,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  userEvent,
  waitFor,
} from "@/test";
import {
  type NlpParseResponse,
  useNlpSearch as useRealNlpSearch,
} from "../../../../../packages/core/src/hooks/useNlpSearch";
import businessLocationFixture from "../../../../../packages/core/src/utils/__tests__/fixtures/business-location-intent.json";
import distinctBusinesses from "../../../../../packages/core/src/utils/__tests__/fixtures/distinct-businesses.json";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const useAutocompleteMock = vi.fn();
const useGeocodingMock = vi.fn();
const useNlpSearchMock = vi.fn();
const useSearchSuggestionsMock = vi.fn();
const useBrandSuggestMock = vi.fn();
const useBrandLogoAttributionMock = vi.fn();
const usePresetSuggestMock = vi.fn();
const useChipTranslationsMock = vi.fn();
const useDataSourcesMock = vi.fn();
const useLabeledPlacesMock = vi.fn();
const useSessionMock = vi.fn();
const resolveStopAsPlaceMock = vi.fn();
const useMediaQueryMock = vi.fn();
let consentActions: { onAccept: () => void; onDecline: () => void } | undefined;
vi.mock("@/components/ui/NlpConsentDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/NlpConsentDialog")>();
  return {
    NlpConsentDialog: (props: {
      open: boolean;
      providers: string[];
      onAccept: () => void;
      onDecline: () => void;
    }) => {
      consentActions = props;
      return <actual.NlpConsentDialog {...props} />;
    },
  };
});
let voiceResult: ((transcript: string, isFinal: boolean) => void) | undefined;
vi.mock("./VoiceSearchButton", () => ({
  VoiceSearchButton: ({ onResult }: { onResult: typeof voiceResult }) => {
    voiceResult = onResult;
    return null;
  },
}));
vi.mock("@mui/material/useMediaQuery", () => ({
  default: (...args: unknown[]) => useMediaQueryMock(...args),
}));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useAutocomplete: (...a: unknown[]) => useAutocompleteMock(...a),
    useGeocoding: (...a: unknown[]) => useGeocodingMock(...a),
    useNlpSearch: (...a: unknown[]) => useNlpSearchMock(...a),
    useSearchSuggestions: (...a: unknown[]) => useSearchSuggestionsMock(...a),
    useBrandSuggest: (...a: unknown[]) => useBrandSuggestMock(...a),
    useBrandLogoAttribution: () => useBrandLogoAttributionMock(),
    resolveStopAsPlace: (...a: unknown[]) => resolveStopAsPlaceMock(...a),
    usePresetSuggest: (...a: unknown[]) => usePresetSuggestMock(...a),
    useChipTranslations: (...a: unknown[]) => useChipTranslationsMock(...a),
    useDataSources: () => useDataSourcesMock(),
    useLabeledPlaces: () => useLabeledPlacesMock(),
    // The mobile empty state only needs a signed-out session. Keep the real
    // Better Auth client (and its delayed browser lifecycle) out of this test.
    useSession: () => useSessionMock(),
  };
});

const fakeMap = createFakeMap();
const flyToMock = vi.fn();
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fakeMap.map },
    mapReady: true,
    styleVersion: 0,
    flyTo: flyToMock,
    fitBounds: vi.fn(),
    zoomIn: vi.fn(),
    zoomOut: vi.fn(),
    resetBearing: vi.fn(),
    notifyMapReady: vi.fn(),
    notifyStyleReload: vi.fn(),
  }),
}));

vi.mock("@/components/auth/AccountAvatarButton", async () => {
  const { createPortal } = await import("react-dom");
  return {
    AccountAvatarButton: () =>
      createPortal(
        <form onSubmit={(e) => e.preventDefault()}>
          <button type="submit">complete auth</button>
        </form>,
        document.body,
      ),
  };
});

const launchExploreFromPlace = vi.fn();
const launchExploreTextSearch = vi.fn();
const launchTextSearch = vi.fn();
vi.mock("@/lib/launchExplore", () => ({
  launchExploreFromPlace: (...a: unknown[]) => launchExploreFromPlace(...a),
  launchExploreTextSearch: (...a: unknown[]) => launchExploreTextSearch(...a),
  launchTextSearch: (...a: unknown[]) => launchTextSearch(...a),
}));

import type {
  AutocompleteResult,
  BoundingBox,
  Place,
  SearchSuggestion,
  SearchSuggestionsResponse,
} from "@openmapx/core";
import {
  apiClient,
  createPlace,
  PANEL,
  useCategorySearchStore,
  useDirectionsStore,
  useMapStore,
  useNlpSearchStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
  useStreetLevelStore,
} from "@openmapx/core";
import type { Disclosure } from "@openmapx/core/api-contracts";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { IntegrationDisclosuresProvider } from "@/lib/integrationDisclosuresContext";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import { SearchBar } from "./SearchBar";

// The bar's measured map registration observes its element, and jsdom ships no
// ResizeObserver — without this the hook falls back to its observer-less path
// and the obstruction tests below would exercise something the browser never
// runs.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

beforeEach(() => {
  consentActions = undefined;
  useLabeledPlacesMock.mockReset().mockReturnValue({ data: undefined });
  useSessionMock.mockReset().mockReturnValue({ data: null });
  useAutocompleteMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useGeocodingMock.mockReset().mockReturnValue({ data: [] });
  useNlpSearchMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useSearchSuggestionsMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useBrandSuggestMock.mockReset().mockReturnValue({ data: undefined });
  useBrandLogoAttributionMock.mockReset().mockReturnValue({ data: undefined });
  usePresetSuggestMock.mockReset().mockReturnValue({ data: undefined });
  useChipTranslationsMock.mockReset().mockReturnValue({ data: {} });
  useDataSourcesMock
    .mockReset()
    .mockReturnValue({ data: { sources: [{ id: "parking", categoryChipLabel: "Parking" }] } });
  resolveStopAsPlaceMock.mockReset();
  useMediaQueryMock.mockReset().mockReturnValue(false);
  flyToMock.mockReset();
  fakeMap.state.center = { lng: 0, lat: 0 };
  fakeMap.state.zoom = 10;
  launchExploreFromPlace.mockReset();
  launchExploreTextSearch.mockReset();
  launchTextSearch.mockReset();
  useSearchStore.getState().reset();
  useDirectionsStore.getState().close(); // SearchBar returns null while directions open
  useCategorySearchStore.getState().clearCategory();
  useCategorySearchStore.setState({ anchor: null, exploreBoxOpen: false, activeCategory: null });
  usePlaceStore.setState({ selectedPlace: null });
  useStreetLevelStore.getState().closeViewer();
  useMapStore.setState({ userLocation: null });
  useSidebarStore.setState({ activeSidebarId: null });
  useSettingsStore.setState({ aiSearchEnabled: true, searchHistoryEnabled: true });
  useRecentSearchStore.getState().clear();
  localStorage.clear();
});

function aggregateSuggestion(overrides: Partial<SearchSuggestion> = {}): SearchSuggestion {
  return {
    id: "osm:node/123",
    label: "Canonical place",
    coordinates: [8, 50],
    type: "poi",
    searchMatch: { kind: "explicit_alias", value: "CP", normalized: "cp" },
    importance: 0.8,
    provider: "search-osm-aliases",
    ...overrides,
  };
}

function aggregateResponse(
  suggestions: SearchSuggestion[],
  attributions: SearchSuggestionsResponse["attributions"] = [],
): SearchSuggestionsResponse {
  return { suggestions, attributions, partial: false };
}

const renderBar = (disclosures: Disclosure[] = [], queryClient?: QueryClient) =>
  render(
    <IntegrationDisclosuresProvider value={disclosures}>
      <SearchBar />
    </IntegrationDisclosuresProvider>,
    { wrapper: createQueryWrapper(queryClient) },
  );

describe("SearchBar", () => {
  it("does not render again when a category result is hovered", async () => {
    useCategorySearchStore.setState({ hoveredCategoryPlaceId: null });
    const onRender = vi.fn();
    render(
      <IntegrationDisclosuresProvider value={[]}>
        <Profiler id="search" onRender={onRender}>
          <SearchBar />
        </Profiler>
      </IntegrationDisclosuresProvider>,
      { wrapper: createQueryWrapper() },
    );
    await act(async () => {});
    onRender.mockClear();

    act(() => useCategorySearchStore.getState().setHoveredCategoryPlaceId("osm:node/1"));

    expect(onRender).not.toHaveBeenCalled();
  });

  it("mounts and renders the search input", () => {
    renderBar();
    screen.getByLabelText("search.ariaLabel");
  });

  it("asks for no suggestions while the box is not in use, then for the text once focused", async () => {
    // The opened place's name stays in the box while the map flies to it.
    useSearchStore.setState({ query: "Louvre Museum", isFocused: false });
    renderBar();
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));

    for (const hook of [useAutocompleteMock, useSearchSuggestionsMock, useGeocodingMock]) {
      expect(hook.mock.calls.every((call) => call[0] === "")).toBe(true);
    }

    fireEvent.focus(screen.getByLabelText("search.ariaLabel"));
    await waitFor(() => {
      expect(useAutocompleteMock.mock.calls.at(-1)?.[0]).toBe("Louvre Museum");
      expect(useSearchSuggestionsMock.mock.calls.at(-1)?.[0]).toBe("Louvre Museum");
    });
  });

  it("shows a shared integration and POI category only once", async () => {
    const registry = new IntegrationRegistry([
      {
        id: "parking",
        name: "Parking",
        enabled: true,
        isBuiltIn: true,
        domains: ["data-source"],
        frontend: { searchCategory: { id: "parking", label: "Parking" } },
      },
    ]);
    render(
      <IntegrationRegistryContext.Provider value={registry}>
        <SearchBar />
      </IntegrationRegistryContext.Provider>,
      { wrapper: createQueryWrapper() },
    );
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "parking" } });

    await waitFor(() => {
      expect(screen.getAllByRole("option", { name: "Parking search.searchCategory" })).toHaveLength(
        1,
      );
    });
    fireEvent.click(screen.getByRole("option", { name: "Parking search.searchCategory" }));
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DATASOURCE);
  });

  it("offers no data-source category the API does not list", async () => {
    // A source the API leaves out (no provider behind it) would answer every search empty.
    useDataSourcesMock.mockReturnValue({ data: { sources: [] } });
    const registry = new IntegrationRegistry([
      {
        id: "fuel",
        name: "Fuel",
        enabled: true,
        isBuiltIn: true,
        domains: ["data-source"],
        frontend: { searchCategory: { id: "fuel", label: "Gas Stations" } },
      },
    ]);
    render(
      <IntegrationRegistryContext.Provider value={registry}>
        <SearchBar />
      </IntegrationRegistryContext.Provider>,
      { wrapper: createQueryWrapper() },
    );
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gas stations" } });

    await act(() => new Promise((resolve) => setTimeout(resolve, 300)));
    expect(screen.queryByRole("option", { name: "Gas Stations search.searchCategory" })).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["loading", { data: undefined, isLoading: true }],
    ["failed", { data: undefined, isError: true }],
  ])("keeps the data-source categories while the list is %s", async (_, list) => {
    // Without the list there is nothing to filter by, so nothing is taken out.
    useDataSourcesMock.mockReturnValue(list);
    const registry = new IntegrationRegistry([
      {
        id: "parking",
        name: "Parking",
        enabled: true,
        isBuiltIn: true,
        domains: ["data-source"],
        frontend: { searchCategory: { id: "parking-lots", label: "Car parks" } },
      },
    ]);
    render(
      <IntegrationRegistryContext.Provider value={registry}>
        <SearchBar />
      </IntegrationRegistryContext.Provider>,
      { wrapper: createQueryWrapper() },
    );
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "car parks" } });

    expect(
      await screen.findByRole("option", { name: "Car parks search.searchCategory" }),
    ).toBeDefined();
  });

  it("labels suggestion distance from the shown user location", async () => {
    useMapStore.setState({ userLocation: [6.084, 50.775] });
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          label: "Central Cafe",
          coordinates: [6.084, 50.775],
          searchMatch: { kind: "name", value: "Central Cafe", normalized: "central cafe" },
        }),
      ]),
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Central Cafe" } });

    await waitFor(() => expect(screen.getByText(/0 m search\.fromYou/)).toBeInTheDocument());
    expect(screen.queryByText(/search\.fromMapCenter/)).toBeNull();
  });

  it("shows empty-search shortcuts on desktop when the input is focused", () => {
    renderBar();
    fireEvent.focus(screen.getByLabelText("search.ariaLabel"));

    expect(screen.getByText("search.emptyStateSignedOut")).toBeInTheDocument();
  });

  it("runs a recent query again on desktop without navigating to a stored result", async () => {
    useRecentSearchStore.getState().add("Berlin cafes");
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel") as HTMLInputElement;
    fireEvent.focus(input);

    fireEvent.click(screen.getByRole("button", { name: "Berlin cafes" }));

    expect(input.value).toBe("Berlin cafes");
    expect(flyToMock).not.toHaveBeenCalled();
    // Nothing in the list names it, so the query goes to the natural-language parse.
    await waitFor(() => expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(true));
  });

  it("offers a matching recent query while typing and runs it when picked", async () => {
    useRecentSearchStore.getState().add("Berlin cafes");
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berl" } });

    fireEvent.click(await screen.findByRole("option", { name: /Berlin cafes/ }));

    expect(input.value).toBe("Berlin cafes");
    await waitFor(() => expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(true));
  });

  it("lets the user clear recent queries without leaving mobile search", async () => {
    useMediaQueryMock.mockReturnValue(true);
    useRecentSearchStore.getState().add("Berlin cafes");
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);

    expect(screen.getByRole("button", { name: "Berlin cafes" })).toBeInTheDocument();
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole("button", { name: "search.clearHistory" }));

    expect(useRecentSearchStore.getState().entries).toEqual([]);
    expect(screen.queryByRole("button", { name: "Berlin cafes" })).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 180));
    });
    expect(useSearchStore.getState().isFocused).toBe(true);
  });

  it("does not display or record searches while history is disabled", () => {
    useRecentSearchStore.getState().add("Berlin cafes");
    useSettingsStore.getState().setSearchHistoryEnabled(false);
    renderBar();
    fireEvent.focus(screen.getByLabelText("search.ariaLabel"));

    expect(screen.queryByRole("button", { name: "Berlin cafes" })).toBeNull();
    fireEvent.change(screen.getByLabelText("search.ariaLabel"), {
      target: { value: "Amsterdam" },
    });
    fireEvent.submit(screen.getByLabelText("search.ariaLabel").closest("form") as HTMLFormElement);
    expect(useRecentSearchStore.getState().entries).toEqual([]);
  });

  it("does not treat an auth-dialog submit as a search submit", () => {
    renderBar();

    // AuthDialog is portaled out of the search bar in the DOM, but React portal
    // events bubble through their component ancestors. The search form must
    // ignore a submit whose target is the dialog's inner form.
    fireEvent.click(screen.getByRole("button", { name: "complete auth" }));

    expect(useSearchStore.getState().isFocused).toBe(false);
  });

  it("dispatches a debounced autocomplete query on typing (fresh text: 150ms)", async () => {
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.change(input, { target: { value: "berlin" } });

    // Debounce hasn't fired yet — only the empty-input mount call has landed.
    expect(useAutocompleteMock).not.toHaveBeenCalledWith("berlin", "en");

    // Real timers (not `vi.useFakeTimers`/`advanceTimersByTime`): this repo's
    // local `vitest.d.ts` type shim (apps/web/src/vitest.d.ts) does not declare
    // the timer-control APIs, so the 150ms debounce is awaited for real here.
    await waitFor(() => {
      const lastCall = useAutocompleteMock.mock.calls.at(-1);
      expect(lastCall?.slice(0, 2)).toEqual(["berlin", "en"]);
    });
  });

  it("biases place suggestions and the Enter geocode towards the map view", async () => {
    fakeMap.state.center = { lng: 13.405, lat: 52.52 };
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.change(input, { target: { value: "coffee" } });

    await waitFor(() => {
      expect(useAutocompleteMock.mock.calls.at(-1)?.[2]).toEqual({
        proximity: [13.405, 52.52],
        zoom: 10,
      });
      const geocodeCall = useGeocodingMock.mock.calls.find((call) => call[0] === "coffee");
      expect(geocodeCall?.[2]).toEqual([13.405, 52.52]);
    });
  });

  it("renders dropdown results and commits a selection via ArrowDown + Enter", async () => {
    const suggestion: AutocompleteResult = {
      id: "osm:n1",
      label: "Berlin Hbf",
      sublabel: "Berlin, Germany",
      type: "poi",
      coordinates: [13.369, 52.525],
    };
    useAutocompleteMock.mockReturnValue({ data: [suggestion], isFetching: false });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berlin hbf" } });

    await screen.findByRole("option", { name: /Berlin Hbf/ });

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(flyToMock).toHaveBeenCalledWith([13.369, 52.525], 15);
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Berlin Hbf");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useSearchStore.getState().query).toBe("Berlin Hbf");
    expect(useSearchStore.getState().isFocused).toBe(false);
    expect(useRecentSearchStore.getState().entries).toEqual(["Berlin Hbf"]);
  });

  it.each([
    ["click", "branch-a", "Street A 1", [13.4, 52.52]],
    ["click", "branch-b", "Street B 2", [13.405, 52.52]],
    ["keyboard", "branch-a", "Street A 1", [13.4, 52.52]],
    ["keyboard", "branch-b", "Street B 2", [13.405, 52.52]],
  ] satisfies Array<[string, string, string, [number, number]]>)(
    "selects distinct %s business %s from the real list",
    async (method, id, address, coordinates) => {
      fakeMap.state.center = { lng: 13.4, lat: 52.52 };
      fakeMap.state.zoom = 15;
      useAutocompleteMock.mockReturnValue({ data: distinctBusinesses, isFetching: false });
      useSearchStore.setState({ query: "REWE", isFocused: true });
      renderBar();
      const input = screen.getByLabelText("search.ariaLabel");
      const a = await screen.findByRole("option", { name: /Street A 1/ });
      const b = await screen.findByRole("option", { name: /Street B 2/ });
      expect(screen.getAllByRole("option").slice(0, 2)).toEqual([a, b]);
      if (method === "click") fireEvent.click(id === "branch-a" ? a : b);
      else {
        fireEvent.keyDown(input, { key: "ArrowDown" });
        if (id === "branch-b") fireEvent.keyDown(input, { key: "ArrowDown" });
        fireEvent.keyDown(input, { key: "Enter" });
      }
      expect(usePlaceStore.getState().selectedPlace).toMatchObject({
        ids: { maptiler: id },
        address: expect.stringContaining(address),
        coordinates,
      });
      expect(flyToMock).toHaveBeenCalledWith(coordinates, 15);
      expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    },
  );

  it("merges a corroborated cross-source branch duplicate while retaining the other branch", async () => {
    fakeMap.state.center = { lng: 13.4, lat: 52.52 };
    fakeMap.state.zoom = 15;
    useAutocompleteMock.mockReturnValue({ data: distinctBusinesses, isFetching: false });
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          ...distinctBusinesses[0],
          id: "osm:node/1",
          coordinates: [13.4, 52.52],
        } as Partial<SearchSuggestion>),
      ]),
      isFetching: false,
    });
    useSearchStore.setState({ query: "REWE", isFocused: true });
    renderBar();
    await screen.findByRole("option", { name: /Street B 2/ });
    expect(screen.getAllByRole("option", { name: /Street A 1/ })).toHaveLength(1);
    expect(screen.getAllByRole("option", { name: /Street B 2/ })).toHaveLength(1);
  });

  it("shows Berlin first for weak remote address-prefix evidence and plain Enter searches the area", async () => {
    fakeMap.state.center = { lng: 13.416, lat: 52.5194 };
    fakeMap.state.zoom = 15;
    const places = businessLocationFixture as AutocompleteResult[];
    useAutocompleteMock.mockReturnValue({ data: places, isFetching: false });
    // Forward retrieval is independently remote-first; it must not rescue a weak POI match.
    useGeocodingMock.mockReturnValue({
      data: places.map((p) => ({ ...p, label: p.sublabel, confidence: 0.78 })),
    });
    useSettingsStore.setState({ aiSearchEnabled: false });
    useSearchStore.setState({ query: "MediaMarkt Alexa", isFocused: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    await screen.findByRole("option", { name: /Grunerstraße 20/ });
    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("Grunerstraße 20");
    expect(options[1]).toHaveTextContent("Pr Willem Alexander Prom");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    expect(flyToMock).not.toHaveBeenCalled();
    expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, "MediaMarkt Alexa");
  });

  it.each([
    ["MediaMarkt Alexa", "maptiler:poi.15422100", "Grunerstraße 20"],
    ["MediaMarkt Rijswijk", "maptiler:poi.15539884", "Pr Willem Alexander Prom"],
  ])(
    "selects the displayed first row for %s with ArrowDown + Enter",
    async (query, id, address) => {
      fakeMap.state.center = { lng: 13.416, lat: 52.5194 };
      fakeMap.state.zoom = 15;
      useAutocompleteMock.mockReturnValue({ data: businessLocationFixture, isFetching: false });
      renderBar();
      const input = screen.getByLabelText("search.ariaLabel");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: query } });
      await screen.findByRole("option", { name: /Grunerstraße 20/ });
      expect(screen.getAllByRole("option")[0]).toHaveTextContent(address);
      fireEvent.keyDown(input, { key: "ArrowDown" });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(usePlaceStore.getState().selectedPlace?.address).toContain(address);
      expect(usePlaceStore.getState().selectedPlace?.ids.maptiler).toBe(
        id.replace("maptiler:", ""),
      );
    },
  );

  it("plain Enter still opens the explicitly named remote business city", async () => {
    fakeMap.state.center = { lng: 13.416, lat: 52.5194 };
    fakeMap.state.zoom = 15;
    useAutocompleteMock.mockReturnValue({ data: businessLocationFixture, isFetching: false });
    useSearchStore.setState({ query: "MediaMarkt Rijswijk", isFocused: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    await screen.findByRole("option", { name: /Pr Willem Alexander Prom/ });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(usePlaceStore.getState().selectedPlace?.address).toContain("Rijswijk"),
    );
  });

  it("records an explicitly submitted query without storing every keystroke", async () => {
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.change(input, { target: { value: "Quiet cafés" } });
    expect(useRecentSearchStore.getState().entries).toEqual([]);

    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(useRecentSearchStore.getState().entries).toEqual(["Quiet cafés"]));
  });

  it("waits for the typed text's suggestions before acting on Enter", async () => {
    const stale: AutocompleteResult = {
      id: "osm:old",
      label: "Berlin",
      type: "region",
      coordinates: [13.4, 52.5],
    };
    const current: AutocompleteResult = {
      id: "osm:new",
      label: "Bernau bei Berlin",
      type: "region",
      coordinates: [13.59, 52.68],
    };
    // Query results keep their identity between renders, as TanStack's do.
    const staleResult = { data: [stale], isFetching: false };
    const currentResult = { data: [current], isFetching: false };
    useAutocompleteMock.mockImplementation((...args: unknown[]) =>
      args[0] === "bernau" ? currentResult : staleResult,
    );

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bernau" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    await waitFor(() =>
      expect(usePlaceStore.getState().selectedPlace?.name).toBe("Bernau bei Berlin"),
    );
  });

  it.each(["settlement", "timeout"])(
    "preserves an explicit same-label choice after deferred Enter %s",
    async (completion) => {
      vi.useFakeTimers();
      try {
        fakeMap.state.center = { lng: 13.405, lat: 52.52 };
        const suggestions: AutocompleteResult[] = [
          {
            id: "osm:city",
            label: "Berlin",
            type: "region",
            coordinates: [13.405, 52.52],
          },
          {
            id: "osm:street",
            label: "Berlin",
            sublabel: "Chosen address",
            type: "address",
            coordinates: [13.45, 52.53],
          },
        ];
        useSearchStore.setState({ query: "Berlin", isFocused: true });
        useAutocompleteMock.mockReturnValue({ data: suggestions, isFetching: true });
        renderBar();
        const input = screen.getByLabelText("search.ariaLabel");
        fireEvent.submit(input.closest("form") as HTMLFormElement);
        fireEvent.click(screen.getByRole("option", { name: /Chosen address/ }));
        expect(usePlaceStore.getState().selectedPlace?.id).toBe("osm:street");

        if (completion === "settlement") {
          useAutocompleteMock.mockReturnValue({ data: suggestions, isFetching: false });
          await act(async () => useSearchStore.getState().setResults([]));
        }
        await act(async () => vi.advanceTimersByTime(3_000));

        expect(usePlaceStore.getState().selectedPlace?.id).toBe("osm:street");
        expect(launchTextSearch).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each(["Escape", "blur", "mobile back", "directions"])(
    "cancels deferred Enter when search is dismissed via %s",
    async (dismissal) => {
      vi.useFakeTimers();
      try {
        useSettingsStore.setState({ aiSearchEnabled: false });
        useSearchStore.setState({ query: "Unknown place", isFocused: true });
        useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
        useMediaQueryMock.mockReturnValue(dismissal === "mobile back");
        renderBar();
        const input = screen.getByLabelText("search.ariaLabel");
        fireEvent.submit(input.closest("form") as HTMLFormElement);
        if (dismissal === "Escape") fireEvent.keyDown(input, { key: "Escape" });
        else if (dismissal === "blur") fireEvent.blur(input);
        else if (dismissal === "mobile back") {
          fireEvent.click(screen.getByRole("button", { name: "common.back" }));
        } else {
          fireEvent.click(screen.getByRole("button", { name: "search.getDirectionsAriaLabel" }));
        }
        useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
        await act(async () => useSearchStore.getState().setResults([]));
        expect(launchTextSearch).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(3_000));
        expect(launchTextSearch).not.toHaveBeenCalled();
        expect(usePlaceStore.getState().selectedPlace).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("still executes deferred Enter after its settle timeout", async () => {
    vi.useFakeTimers();
    try {
      useSettingsStore.setState({ aiSearchEnabled: false });
      useSearchStore.setState({ query: "Unknown place", isFocused: true });
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
      renderBar();
      fireEvent.submit(
        screen.getByLabelText("search.ariaLabel").closest("form") as HTMLFormElement,
      );
      await act(async () => vi.advanceTimersByTime(2_499));
      expect(launchTextSearch).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1));
      expect(launchTextSearch).toHaveBeenCalledTimes(1);
      expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, "Unknown place");
    } finally {
      vi.useRealTimers();
    }
  });

  it("plain Enter opens the top-ranked city rather than a foreign chain of the same name", async () => {
    fakeMap.state.center = { lng: 13.405, lat: 52.52 };
    useBrandSuggestMock.mockReturnValue({
      data: {
        matches: [
          { qid: "Q6", name: "París", kind: ["brand"], matchedOn: "name", presence: "elsewhere" },
        ],
      },
    });
    useAutocompleteMock.mockReturnValue({
      data: [
        {
          id: "osm:paris",
          label: "Paris",
          type: "region",
          rawCategory: "place/city",
          coordinates: [2.35, 48.86],
        },
      ],
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "paris" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(usePlaceStore.getState().selectedPlace?.name).toBe("Paris"));
    expect(useCategorySearchStore.getState().activeBrand).toBeNull();
  });

  it("searches the visible area when Enter matches no row and AI search is off", async () => {
    useSettingsStore.setState({ aiSearchEnabled: false });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "quiet cafes" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, "quiet cafes"));
    expect(useSearchStore.getState().isFocused).toBe(false);
  });

  it("offers the area search as the last row", async () => {
    useAutocompleteMock.mockReturnValue({
      data: [{ id: "geo:1", label: "Pizza Max", type: "poi", coordinates: [0, 0] }],
      isFetching: false,
    });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "pizza" } });

    const areaSearch = await screen.findByRole("option", { name: "search.searchQueryInArea" });
    const options = screen.getAllByRole("option");
    expect(options.at(-1)).toBe(areaSearch);
    fireEvent.click(areaSearch);
    expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, "pizza");
  });

  it("reopens the list when typing or pressing an arrow key after Escape", async () => {
    useAutocompleteMock.mockReturnValue({
      data: [{ id: "geo:1", label: "Pizza Max", type: "poi", coordinates: [0, 0] }],
      isFetching: false,
    });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "pizza" } });
    await screen.findByRole("listbox");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.change(input, { target: { value: "pizza m" } });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
  });

  it("points the combobox at the highlighted option", async () => {
    useAutocompleteMock.mockReturnValue({
      data: [{ id: "geo:1", label: "Pizza Max", type: "poi", coordinates: [0, 0] }],
      isFetching: false,
    });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "pizza" } });
    const listbox = await screen.findByRole("listbox");

    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0].id);
  });

  it("keeps the highlight on the same row when later results reorder the list", async () => {
    const pizzeria: AutocompleteResult = {
      id: "geo:pizzeria",
      label: "Pizzeria Uno",
      type: "poi",
      coordinates: [0, 0],
    };
    useAutocompleteMock.mockReturnValue({ data: [pizzeria], isFetching: false });
    const { rerender } = renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "pizza" } });
    await screen.findByRole("option", { name: /Pizzeria Uno/ });
    fireEvent.keyDown(input, { key: "ArrowDown" });

    // An exact-name place arrives later and ranks first.
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: "osm:pizza",
          label: "Pizza",
          coordinates: [0, 0],
          searchMatch: { kind: "name", value: "Pizza", normalized: "pizza" },
        }),
      ]),
      isFetching: false,
    });
    rerender(
      <IntegrationDisclosuresProvider value={[]}>
        <SearchBar />
      </IntegrationDisclosuresProvider>,
    );

    const selected = await screen.findByRole("option", { selected: true });
    expect(selected.textContent).toContain("Pizzeria Uno");
    expect(screen.getAllByRole("option")[0].textContent).toContain("Pizza");
  });

  it("keeps keyboard selection aligned across category, brand, and place suggestions", async () => {
    const brand = {
      qid: "Q123",
      name: "Cafe Chain",
      description: "Coffee shops",
      kind: ["brand" as const],
      matchedOn: "name" as const,
    };
    useBrandSuggestMock.mockReturnValue({ data: { matches: [brand] } });
    useAutocompleteMock.mockReturnValue({
      data: [
        {
          id: "osm:node/42",
          label: "Cafe Central",
          sublabel: "Cafe Central, Market Street, Aachen, Germany",
          coordinates: [6.08, 50.78],
          type: "poi",
        },
      ],
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "caf" } });

    const categoryRow = await screen.findByRole("option", { name: /Cafes/ });
    const brandRow = screen.getByRole("option", { name: /Cafe Chain/ });
    const placeRow = screen.getByRole("option", { name: /Cafe Central/ });
    const rows = screen.getAllByRole("option");
    expect(rows.indexOf(categoryRow)).toBe(0);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(categoryRow.className).toContain("Mui-selected");
    for (let step = 0; step < rows.indexOf(brandRow); step += 1) {
      fireEvent.keyDown(input, { key: "ArrowDown" });
    }
    expect(brandRow.className).toContain("Mui-selected");
    expect(placeRow.className).not.toContain("Mui-selected");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useCategorySearchStore.getState().activeBrand?.qid).toBe("Q123");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });

  it("shows an exact geographic place before same-named brand actions", async () => {
    useBrandSuggestMock.mockReturnValue({
      data: {
        matches: [
          { qid: "Q1", name: "Aachen", kind: ["brand"], matchedOn: "name" },
          { qid: "Q2", name: "Aachener Verkehrsverbund", kind: ["brand"], matchedOn: "name" },
        ],
      },
    });
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: "geo:aachen",
          label: "Aachen",
          type: "region",
          coordinates: [6.084, 50.775],
          searchMatch: { kind: "name", value: "Aachen", normalized: "aachen" },
        }),
      ]),
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Aachen" } });

    const placeRow = (await screen.findByText(/search\.resultTypeArea/)).closest('[role="option"]');
    const brandRow = screen.getByRole("option", { name: /Aachener Verkehrsverbund/ });
    expect(screen.getAllByRole("option").indexOf(placeRow as HTMLElement)).toBeLessThan(
      screen.getAllByRole("option").indexOf(brandRow),
    );
  });

  it("ranks a nearby place above a far area of the same name and caps chain rows", async () => {
    fakeMap.state.center = { lng: 13.405, lat: 52.52 };
    useBrandSuggestMock.mockReturnValue({
      data: {
        matches: ["Coffee Lab", "Coffee Culture", "Coffee Company"].map((name, i) => ({
          qid: `Q${i}`,
          name,
          kind: ["brand"],
          matchedOn: "name",
          presence: "elsewhere",
        })),
      },
    });
    useAutocompleteMock.mockReturnValue({
      data: [
        {
          id: "osm:county",
          label: "Coffee",
          type: "region",
          rawCategory: "place/county",
          coordinates: [-86.07, 35.49],
        },
        { id: "osm:cafe", label: "Coffee Circle", type: "poi", coordinates: [13.4, 52.52] },
      ],
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "coffee" } });

    const cafe = await screen.findByRole("option", { name: /Coffee Circle/ });
    const county = screen.getByRole("option", { name: /search\.resultTypeArea/ });
    const options = screen.getAllByRole("option");
    expect(options.indexOf(cafe)).toBeLessThan(options.indexOf(county));
    expect(screen.getAllByRole("option", { name: /search\.searchBrand/ })).toHaveLength(2);
  });

  it("plain Enter uses an exact category search term ahead of a geocoded region", async () => {
    useChipTranslationsMock.mockReturnValue({
      data: { cafes: { name: "Cafes", terms: ["coffee"] } },
    });
    useGeocodingMock.mockReturnValue({
      data: [
        {
          id: "geo:coffee-county",
          label: "Coffee County, Georgia, United States",
          coordinates: [-82.8, 31.55],
          type: "region",
          confidence: 1,
        },
      ],
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "coffee" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(useCategorySearchStore.getState().activeCategory).toBe("cafes"));
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    expect(flyToMock).not.toHaveBeenCalled();
  });

  it("plain Enter accepts the canonical category label when the dropdown is localized", async () => {
    useChipTranslationsMock.mockReturnValue({
      data: { cafes: { name: "Kaffees", terms: ["kaffee"] } },
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Cafes" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(useCategorySearchStore.getState().activeCategory).toBe("cafes"));
  });

  it("does not open Coffee County for a current coffee query without category data", () => {
    useSearchStore.getState().setQuery("coffee");
    useGeocodingMock.mockReturnValue({
      data: [
        {
          id: "geo:coffee-county",
          label: "Coffee County, Georgia",
          coordinates: [-82.8, 31.55],
          type: "region",
          confidence: 1,
        },
      ],
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    expect(useSearchStore.getState().isFocused).toBe(true);
    expect(flyToMock).not.toHaveBeenCalled();
  });

  it("still opens a deliberately named distant region", () => {
    useSearchStore.getState().setQuery("Coffee County");
    useGeocodingMock.mockReturnValue({
      data: [
        {
          id: "geo:coffee-county",
          label: "Coffee County, Georgia",
          coordinates: [-82.8, 31.55],
          type: "region",
          confidence: 1,
        },
      ],
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Coffee County, Georgia");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
  });

  it("plain Enter still resolves a typed coordinate", () => {
    useSearchStore.getState().setQuery("50.7753N 6.0839E");
    renderBar();

    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace?.coordinates).toEqual([6.0839, 50.7753]);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useRecentSearchStore.getState().entries).toEqual(["50.7753N 6.0839E"]);
  });

  it("does not submit blank text or text during IME composition", () => {
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(false);

    fireEvent.change(input, { target: { value: "Berlin" } });
    fireEvent.compositionStart(input);
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(false);
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });

  it("plain Enter selects an exact brand name", async () => {
    useBrandSuggestMock.mockReturnValue({
      data: {
        matches: [{ qid: "Q37158", name: "Starbucks", kind: ["brand"], matchedOn: "name" }],
      },
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Starbucks" } });
    await waitFor(() => expect(useBrandSuggestMock.mock.calls.at(-1)?.[0]).toBe("Starbucks"));
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(useCategorySearchStore.getState().activeBrand?.qid).toBe("Q37158");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
  });

  it("shows a brand's canonical label for a recognized alias and selects that brand", async () => {
    useBrandSuggestMock.mockReturnValue({
      data: {
        matches: [
          {
            qid: "Q524757",
            name: "KFC",
            kind: ["brand"],
            matchedOn: "alias",
            matchedValue: "kentucky fried chicken",
            presence: "here",
          },
        ],
      },
    });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Kentucky Fried Chicken" } });
    fireEvent.click(await screen.findByRole("option", { name: /KFC/ }));
    expect(useCategorySearchStore.getState().activeBrand?.qid).toBe("Q524757");
    expect(useCategorySearchStore.getState().adHocFilter).toMatchObject({
      selectors: [{ tags: [{ key: "brand:wikidata", value: "Q524757" }] }],
    });
  });

  it("shows and selects the canonical preset for a recognized search term", async () => {
    usePresetSuggestMock.mockReturnValue({
      data: {
        matches: [
          {
            id: "amenity/ice_cream",
            name: "Ice Cream Shop",
            tags: { amenity: "ice_cream" },
            matchedOn: "term",
            matchedValue: "gelato",
          },
        ],
      },
    });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "gelato" } });
    fireEvent.click(await screen.findByRole("option", { name: /Ice Cream Shop/ }));
    expect(useCategorySearchStore.getState().activeCategory).toBe("preset:amenity/ice_cream");
  });

  it("plain Enter selects an exact preset name", async () => {
    usePresetSuggestMock.mockReturnValue({
      data: {
        matches: [
          {
            id: "amenity/ice_cream",
            name: "Ice cream",
            tags: { amenity: "ice_cream" },
            matchedOn: "name",
          },
        ],
      },
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Ice cream" } });
    await waitFor(() => expect(usePresetSuggestMock.mock.calls.at(-1)?.[0]).toBe("Ice cream"));
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(useCategorySearchStore.getState().activeCategory).toBe("preset:amenity/ice_cream");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
  });

  it("plain Enter selects a current explicit alias from aggregate search", async () => {
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: "osm:node/123",
          label: "Massachusetts Institute of Technology",
          coordinates: [-71.092, 42.36],
          searchMatch: { kind: "explicit_alias", value: "MIT", normalized: "mit" },
        }),
      ]),
      isFetching: false,
      isPlaceholderData: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "MIT" } });
    await waitFor(() => expect(useSearchSuggestionsMock.mock.calls.at(-1)?.[0]).toBe("MIT"));
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace?.id).toBe("osm:node/123");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useRecentSearchStore.getState().entries).toEqual(["MIT"]);
  });

  it("normalizes punctuation in a current explicit alias", async () => {
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          label: "Saint Xavier University",
          searchMatch: { kind: "explicit_alias", value: "St. X", normalized: "st x" },
        }),
      ]),
      isPlaceholderData: false,
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "St. X" } });
    await waitFor(() => expect(useSearchSuggestionsMock.mock.calls.at(-1)?.[0]).toBe("St. X"));
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Saint Xavier University");
  });

  it("plain Enter takes the top-ranked row when several exact intents compete", async () => {
    useChipTranslationsMock.mockReturnValue({
      data: { cafes: { name: "Cafes", terms: ["coffee"] } },
    });
    useBrandSuggestMock.mockReturnValue({
      data: { matches: [{ qid: "Q1", name: "Coffee", kind: ["brand"], matchedOn: "name" }] },
    });
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          label: "Coffee House",
          searchMatch: { kind: "explicit_alias", value: "Coffee", normalized: "coffee" },
        }),
      ]),
      isPlaceholderData: false,
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "coffee" } });
    await waitFor(() => expect(useBrandSuggestMock.mock.calls.at(-1)?.[0]).toBe("coffee"));
    const top = screen.getAllByRole("option")[0];
    expect(top.textContent).toContain("Cafes");
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() => expect(useCategorySearchStore.getState().activeCategory).toBe("cafes"));
    expect(useCategorySearchStore.getState().activeBrand).toBeNull();
    expect(usePlaceStore.getState().selectedPlace).toBeNull();
  });

  it("does not submit a stale geocode result immediately after editing", () => {
    useGeocodingMock.mockReturnValue({
      data: [
        {
          id: "geo:new-york",
          label: "New York, United States",
          coordinates: [-74.006, 40.7128],
          type: "region",
          confidence: 1,
        },
      ],
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "New York" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    expect(usePlaceStore.getState().selectedPlace).toBeNull();
    expect(flyToMock).not.toHaveBeenCalled();
  });

  it("shows one authoritative airport ahead of its geocoder duplicate", async () => {
    const airport = aggregateSuggestion({
      id: "oa:EDDF",
      label: "Frankfurt am Main Airport",
      coordinates: [8.5701, 50.0301],
      ids: { iata: "FRA", icao: "EDDF" },
      searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
      importance: 0.95,
      provider: "knowledge-ourairports",
      contributors: [{ sourceId: "ourairports", name: "OurAirports" }],
    });
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([airport], [{ sourceId: "ourairports", name: "OurAirports" }]),
      isFetching: false,
    });
    useAutocompleteMock.mockReturnValue({
      data: [
        {
          id: "geo:fra",
          label: "Frankfurt am Main Airport",
          coordinates: [8.57, 50.03],
          type: "poi",
          provider: "geocoding-test",
        },
      ],
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "FRA" } });

    await screen.findByRole("option", { name: /Frankfurt am Main Airport.*FRA/i });
    expect(screen.getAllByRole("option", { name: /Frankfurt am Main Airport/ })).toHaveLength(1);
    screen.getByText("OurAirports");
  });

  it("shows displayed-row attribution in the mobile results panel", async () => {
    useMediaQueryMock.mockReturnValue(true);
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse(
        [
          aggregateSuggestion({
            id: "oa:EDDF",
            label: "Frankfurt am Main Airport",
            searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
            provider: "knowledge-ourairports",
            contributors: [{ sourceId: "ourairports", name: "OurAirports" }],
          }),
        ],
        [{ sourceId: "ourairports", name: "OurAirports" }],
      ),
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "FRA" } });

    await screen.findByRole("option", { name: /Frankfurt am Main Airport/ });
    screen.getByText("OurAirports");
  });

  it("credits only displayed rows when an aggregate envelope includes another source", async () => {
    const shown = { sourceId: "shown-feed", name: "Visible supplier" };
    const hidden = { sourceId: "hidden-feed", name: "Hidden supplier" };
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse(
        [aggregateSuggestion({ label: "Visible station", contributors: [shown] })],
        [shown, hidden],
      ),
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "station" } });

    await screen.findByRole("option", { name: /Visible station/ });
    expect(screen.getByText("Visible supplier")).toBeInTheDocument();
    expect(screen.queryByText("Hidden supplier")).not.toBeInTheDocument();
  });

  it("keeps an explicit alias ahead of a generated acronym collision", async () => {
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: "osm:node/1",
          label: "Massachusetts Institute of Technology",
          searchMatch: { kind: "explicit_alias", value: "MIT", normalized: "mit" },
        }),
        aggregateSuggestion({
          id: "osm:node/2",
          label: "Museum Island Tours",
          searchMatch: { kind: "generated_acronym", value: "MIT", normalized: "mit" },
        }),
      ]),
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "MIT" } });

    const explicit = await screen.findByText("Massachusetts Institute of Technology");
    const generated = screen.getByText("Museum Island Tours");
    expect(explicit.compareDocumentPosition(generated) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
  });

  it("places a generated acronym below a geocoder hit named by the text and selects its stable OSM id", async () => {
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: "osm:node/123",
          label: "University of North Carolina at Charlotte",
          coordinates: [-80.734, 35.307],
          searchMatch: { kind: "generated_acronym", value: "UNCC", normalized: "uncc" },
        }),
      ]),
      isFetching: false,
    });
    useAutocompleteMock.mockReturnValue({
      data: [
        {
          id: "geo:uncc-arena",
          label: "UNCC Arena",
          coordinates: [-80.73, 35.3],
          type: "region",
          provider: "geocoding-test",
        },
      ],
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "UNCC" } });

    const normal = await screen.findByRole("option", { name: /UNCC Arena/ });
    const generated = screen.getByText("University of North Carolina at Charlotte");
    expect(normal.compareDocumentPosition(generated) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
    fireEvent.click(generated);

    await waitFor(() => expect(usePlaceStore.getState().selectedPlace?.id).toBe("osm:node/123"));
    expect(usePlaceStore.getState().selectedPlace?.name).toBe(
      "University of North Carolina at Charlotte",
    );
  });

  it("retains aggregate transit-stop data and resolves the selected stop as a place", async () => {
    const transitStop: TransitStop = {
      id: "db:8000207",
      name: "Hamburg Hbf",
      lat: 53.5526,
      lng: 10.0067,
      modes: ["rail"],
      provider: "transit-db-vendo",
    };
    const place = {
      id: "db:8000207",
      primaryScheme: "db",
      ids: { db: "8000207" },
      name: "Hamburg Hbf",
      address: "Hamburg Hbf",
      coordinates: [10.0067, 53.5526],
    } as Place;
    resolveStopAsPlaceMock.mockResolvedValue(place);
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: "db:8000207",
          label: "Hamburg Hbf",
          coordinates: [10.0067, 53.5526],
          type: "transit_stop",
          transitStop,
          searchMatch: { kind: "authoritative_code", value: "8000207", normalized: "8000207" },
          provider: "transit",
        }),
      ]),
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "8000207" } });
    fireEvent.click(await screen.findByText("Hamburg Hbf"));

    expect(resolveStopAsPlaceMock).toHaveBeenCalledWith(transitStop);
    await waitFor(() => expect(usePlaceStore.getState().selectedPlace?.id).toBe("db:8000207"));
  });

  it.each(["query", "voice", "Escape", "directions", "blur"])(
    "respects %s while a selected stop is being enriched",
    async (action) => {
      const stop: TransitStop = {
        id: "db:8000207",
        name: "Hamburg Hbf",
        lat: 53.55,
        lng: 10,
        modes: ["rail"],
        provider: "transit-db-vendo",
      };
      let finish!: (place: Place) => void;
      resolveStopAsPlaceMock.mockReturnValue(
        new Promise<Place>((resolve) => {
          finish = resolve;
        }),
      );
      useSearchSuggestionsMock.mockReturnValue({
        data: aggregateResponse([
          aggregateSuggestion({
            id: stop.id,
            label: stop.name,
            coordinates: [10, 53.55],
            type: "transit_stop",
            transitStop: stop,
            searchMatch: { kind: "authoritative_code", value: "8000207", normalized: "8000207" },
          }),
        ]),
        isFetching: false,
      });
      renderBar();
      const input = screen.getByLabelText("search.ariaLabel");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "8000207" } });
      fireEvent.click(await screen.findByText("Hamburg Hbf"));
      const provisional = usePlaceStore.getState().selectedPlace;
      expect(provisional?.ids.db).toBe("8000207");
      if (action === "query") fireEvent.change(input, { target: { value: "Museum" } });
      if (action === "voice") act(() => voiceResult?.("Museum", false));
      if (action === "Escape") fireEvent.keyDown(input, { key: "Escape" });
      if (action === "directions") act(() => useDirectionsStore.getState().open());
      if (action === "blur") fireEvent.blur(input);
      const enriched = {
        ...provisional,
        id: "osm:node/7",
        primaryScheme: "osm",
        ids: { osm: "node/7", db: "8000207" },
      } as Place;
      await act(async () => {
        finish(enriched);
      });
      expect(usePlaceStore.getState().selectedPlace).toBe(
        action === "blur" ? enriched : provisional,
      );
    },
  );

  it("preserves a newer ordinary selection after pending transit enrichment", async () => {
    const stop: TransitStop = {
      id: "db:8000207",
      name: "Hamburg Hbf",
      lat: 53.55,
      lng: 10,
      modes: ["rail"],
      provider: "transit-db-vendo",
    };
    let finish!: (place: Place) => void;
    resolveStopAsPlaceMock.mockReturnValue(
      new Promise<Place>((resolve) => {
        finish = resolve;
      }),
    );
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse([
        aggregateSuggestion({
          id: stop.id,
          label: stop.name,
          coordinates: [10, 53.55],
          type: "transit_stop",
          transitStop: stop,
          searchMatch: { kind: "authoritative_code", value: "8000207", normalized: "8000207" },
        }),
      ]),
      isFetching: false,
    });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "8000207" } });
    fireEvent.click(await screen.findByText("Hamburg Hbf"));
    useAutocompleteMock.mockReturnValue({
      data: [{ id: "osm:node/42", label: "Museum B", coordinates: [9, 51], type: "poi" }],
      isFetching: false,
    });
    useSearchSuggestionsMock.mockReturnValue({ data: undefined, isFetching: false });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Museum B" } });
    fireEvent.click(await screen.findByRole("option", { name: /Museum B/ }));
    const selected = usePlaceStore.getState().selectedPlace;
    expect(selected?.id).toBe("osm:node/42");
    await act(async () => {
      finish({
        id: "osm:node/7",
        primaryScheme: "osm",
        ids: { osm: "node/7", db: "8000207" },
        name: "Hamburg Hbf",
        coordinates: [10, 53.55],
        address: "Hamburg Hbf",
      } as Place);
    });
    expect(usePlaceStore.getState().selectedPlace).toBe(selected);
  });

  it.each([true, false])(
    "does not publish stale transit discovery or its fallback (match=%s)",
    async (match) => {
      let finish!: (stops: TransitStop[]) => void;
      const lookup = vi.spyOn(apiClient, "get").mockReturnValue(
        new Promise<TransitStop[]>((resolve) => {
          finish = resolve;
        }) as never,
      );
      resolveStopAsPlaceMock.mockResolvedValue({
        id: "test:A",
        primaryScheme: "test",
        ids: { test: "A" },
        name: "Station A",
        coordinates: [8, 50],
        address: "Station A",
      } as Place);
      try {
        useAutocompleteMock.mockReturnValue({
          data: [
            {
              id: "osm:node/1",
              label: "Station A",
              coordinates: [8, 50],
              type: "poi",
              rawCategory: "railway/station",
            },
          ],
          isFetching: false,
        });
        renderBar();
        const input = screen.getByLabelText("search.ariaLabel");
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: "Station A" } });
        fireEvent.click(await screen.findByRole("option", { name: /Station A/ }));
        expect(lookup).toHaveBeenCalled();
        act(() => {
          usePlaceStore.getState().setSelectedPlace(null);
          useSidebarStore.getState().closeAll();
        });
        await act(async () => {
          finish(
            match
              ? [
                  {
                    id: "test:A",
                    name: "Station A",
                    lat: 50,
                    lng: 8,
                    modes: ["rail"],
                    provider: "test",
                  },
                ]
              : [],
          );
        });
        expect(usePlaceStore.getState().selectedPlace).toBeNull();
        expect(useSidebarStore.getState().activeSidebarId).toBeNull();
      } finally {
        lookup.mockRestore();
      }
    },
  );

  it("keeps geocoder, brand, and category suggestions when aggregate search fails", async () => {
    useSearchSuggestionsMock.mockReturnValue({ data: undefined, isFetching: false, isError: true });
    useAutocompleteMock.mockReturnValue({
      data: [{ id: "geo:bari", label: "Bari", coordinates: [16.87, 41.12], type: "region" }],
      isFetching: false,
    });
    useBrandSuggestMock.mockReturnValue({
      data: { matches: [{ qid: "Q1", name: "Bar Louie", tags: {} }] },
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "bar" } });

    await screen.findByRole("option", { name: /Bari/ });
    screen.getByRole("option", { name: /Bar Louie/ });
    screen.getByRole("option", { name: /Bars & Pubs/ });
  });

  it("submitting a natural-language query enables NLP parsing; activating the card writes the NLP stores", async () => {
    // No confident geocode match → submit falls through to the NLP branch.
    useGeocodingMock.mockReturnValue({ data: [] });
    const intent = {
      filter: { selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }] },
      spatial_constraint: null,
      time_constraint: null,
      sort_by: "relevance" as const,
      unmapped_attributes: [],
      confidence: 0.9,
      explanation: "Cafés with WiFi",
    };
    useNlpSearchMock.mockReturnValue({
      data: { intent, resolvedBbox: null, provider: "local" },
      isFetching: false,
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "cozy cafes with wifi" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    // 4th positional arg is the enabled flag (nlpSubmitted && aiSearchEnabled).
    await waitFor(() => expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(true));

    await screen.findByText("Cafés with WiFi");

    fireEvent.click(screen.getByText("Cafés with WiFi"));

    expect(useNlpSearchStore.getState().isNlpActive).toBe(true);
    expect(useNlpSearchStore.getState().provider).toBe("local");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
  });

  it("asks for cloud consent before parsing even when the local fallback has no plausible intent", async () => {
    const cloudDisclosure: Disclosure = {
      type: "ai-search",
      integrationId: "search-nlp",
      aiActive: true,
      localActive: true,
      cloudActive: true,
      cloudAvailable: true,
      cloudConsentRequired: true,
      cloudProviderLabels: ["Gemini · gemini-3.5-flash-lite"],
      cloudProcessors: [
        {
          id: "google",
          name: "Google (Gemini)",
          countryCode: "US",
          privacyUrl: "https://policies.google.com/privacy",
        },
      ],
    };
    const cloudIntent = {
      filter: { selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }] },
      spatial_constraint: null,
      time_constraint: null,
      sort_by: "relevance" as const,
      unmapped_attributes: [],
      confidence: 0.95,
      explanation: "Accessible cafés with outdoor seating",
    };
    useNlpSearchMock.mockImplementation((...args: unknown[]) =>
      args[5] === "consented"
        ? {
            data: {
              intent: cloudIntent,
              resolvedBbox: null,
              provider: "gemini",
              providerLabel: "Gemini · gemini-3.5-flash-lite",
            },
            isFetching: false,
          }
        : { data: undefined, isFetching: false },
    );

    renderBar([cloudDisclosure]);
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "accessible cafes with outdoor seating" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await screen.findByText("search.nlpConsentTitle");
    expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "search.enable" }));

    await waitFor(() => {
      expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(true);
      expect(useNlpSearchMock.mock.calls.at(-1)?.[5]).toBe("consented");
    });
    await screen.findByText("Accessible cafés with outdoor seating");
  });

  it("shows no dropdown and keeps suggestions empty when the query is short", () => {
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);

    expect(screen.queryByText("search.searchCategory")).toBeNull();
    expect(useSearchStore.getState().suggestions).toEqual([]);
  });

  it("silently swallows an autocomplete error (no dropdown, no crash)", async () => {
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false, isError: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berlin" } });

    await new Promise((r) => setTimeout(r, 20));

    expect(screen.queryByText("search.searchCategory")).toBeNull();
    expect(useSearchStore.getState().suggestions).toEqual([]);
  });

  it("shows skeleton rows while autocomplete is loading", async () => {
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
    const { container } = renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "berlin" } });

    // Production code renders exactly 3 skeleton rows while loading, each with
    // 1 circular + 2 text Skeletons = 9 `.MuiSkeleton-root` nodes (SearchBar.tsx:1276-1289).
    await waitFor(() => {
      expect(container.querySelectorAll(".MuiSkeleton-root").length).toBe(9);
    });
  });

  it("nearby mode: lists categories, launches from a click, and cancel restores the place panel", () => {
    const anchor = {
      id: "p1",
      name: "Alexanderplatz",
      coordinates: [13.41, 52.52],
    } as unknown as Place;
    useCategorySearchStore.setState({ anchor, exploreBoxOpen: false });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);

    screen.getByText("Restaurants");

    fireEvent.click(screen.getByText("Restaurants"));
    // "restaurants" is the real CATEGORY_DEFINITIONS id for the "Restaurants"
    // chip (integrations/poi-search/types.ts) — asserted exactly rather than
    // via `expect.any(String)`, which this repo's local vitest.d.ts type shim
    // (apps/web/src/vitest.d.ts) does not declare.
    expect(launchExploreFromPlace).toHaveBeenCalledWith(
      fakeMap.map,
      expect.objectContaining({ name: "Alexanderplatz" }),
      "restaurants",
      "Restaurants",
    );

    fireEvent.click(screen.getByLabelText("search.cancelNearby"));
    expect(useCategorySearchStore.getState().anchor).toBeNull();
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Alexanderplatz");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
  });
});

describe("SearchBar NLP submission context", () => {
  const query = "cozy cafes with wifi";
  const bboxA: BoundingBox = { west: 13.3, south: 52.4, east: 13.5, north: 52.6 };
  const bboxB: BoundingBox = { west: 12.4, south: 51.5, east: 14.4, north: 53.5 };
  const intent = {
    filter: { selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }] },
    spatial_constraint: null,
    time_constraint: null,
    sort_by: "relevance" as const,
    unmapped_attributes: [],
    confidence: 0.9,
    explanation: "Cafés with WiFi",
  };

  function viewport() {
    let bounds = { ...bboxA };
    fakeMap.state.center = { lng: 13.4, lat: 52.5 };
    vi.spyOn(fakeMap.map, "getBounds").mockImplementation(
      () =>
        ({
          getWest: () => bounds.west,
          getSouth: () => bounds.south,
          getEast: () => bounds.east,
          getNorth: () => bounds.north,
        }) as ReturnType<typeof fakeMap.map.getBounds>,
    );
    return (nextBounds: BoundingBox, center: [number, number] = [13.4, 52.5]) => {
      bounds = { ...nextBounds };
      fakeMap.state.center.lng = center[0];
      fakeMap.state.center.lat = center[1];
    };
  }

  function lastContext() {
    const call = useNlpSearchMock.mock.calls.at(-1);
    return { query: call?.[0], center: call?.[1], bbox: call?.[2], enabled: call?.[3] };
  }

  function submit(input: HTMLElement) {
    fireEvent.submit(input.closest("form") as HTMLFormElement);
  }

  function unrelatedRender() {
    act(() => useMapStore.setState({ userLocation: [7, 50] }));
  }

  afterEach(() => vi.restoreAllMocks());

  it("reads the map at explicit submit and retains it while parsing and after success", async () => {
    const move = viewport();
    useSearchStore.setState({ query, isFocused: true });
    useNlpSearchMock.mockReturnValue({ data: undefined, isFetching: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    // No render between map movement and Enter: capture must read the map itself.
    move(bboxB, [12.8, 52.2]);
    submit(input);
    await waitFor(() =>
      expect(lastContext()).toEqual({ query, center: [12.8, 52.2], bbox: bboxB, enabled: true }),
    );

    move(bboxA, [14, 53]);
    unrelatedRender();
    expect(lastContext()).toEqual({ query, center: [12.8, 52.2], bbox: bboxB, enabled: true });

    useNlpSearchMock.mockReturnValue({
      data: { intent, resolvedBbox: bboxB, provider: "local" },
      isFetching: false,
    });
    act(() => useMapStore.setState({ userLocation: null }));
    await screen.findByText("Cafés with WiFi");
    expect(lastContext()).toEqual({ query, center: [12.8, 52.2], bbox: bboxB, enabled: true });
    fireEvent.click(screen.getByText("Cafés with WiFi"));
    expect(useCategorySearchStore.getState().searchBbox).toEqual(bboxB);
  });

  it("keeps the submitted zoom until the same text is explicitly submitted at new bounds", async () => {
    const move = viewport();
    useSearchStore.setState({ query, isFocused: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    submit(input);
    await waitFor(() =>
      expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxA, enabled: true }),
    );
    move(bboxB);
    unrelatedRender();
    expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxA, enabled: true });
    submit(input);
    await waitFor(() =>
      expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxB, enabled: true }),
    );
  });

  it("keeps the explicit text and viewport while suggestions for a new query settle", async () => {
    const move = viewport();
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: query } });
    submit(input);
    expect(lastContext().enabled).toBe(false);
    move(bboxB, [14, 53]);
    unrelatedRender();
    await waitFor(() => expect(useAutocompleteMock.mock.calls.at(-1)?.[0]).toBe(query));
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
    act(() => useMapStore.setState({ userLocation: null }));
    await waitFor(() =>
      expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxA, enabled: true }),
    );
    // Suggestion proximity remains live while NLP uses the submitted context.
    expect(useAutocompleteMock.mock.calls.at(-1)?.[2]).toEqual({ proximity: [14, 53], zoom: 10 });
  });

  it("suspends the previous parse when a new submission waits for suggestions", async () => {
    const move = viewport();
    useSearchStore.setState({ query, isFocused: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    submit(input);
    await waitFor(() => expect(lastContext().enabled).toBe(true));
    move(bboxB);
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
    unrelatedRender();
    useNlpSearchMock.mockClear();
    submit(input);
    expect(lastContext().enabled).toBe(false);
    expect(useNlpSearchMock.mock.calls.every((call) => call[3] === false)).toBe(true);
    move(bboxA, [14, 53]);
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
    act(() => useMapStore.setState({ userLocation: null }));
    await waitFor(() =>
      expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxB, enabled: true }),
    );
  });

  it("keeps the original viewport when suggestion settlement times out", async () => {
    vi.useFakeTimers();
    try {
      const move = viewport();
      useSearchStore.setState({ query, isFocused: true });
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
      renderBar();
      submit(screen.getByLabelText("search.ariaLabel"));
      move(bboxB, [14, 53]);
      unrelatedRender();
      await act(async () => vi.advanceTimersByTime(2_500));
      expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxA, enabled: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with cloud consent in the submitted viewport after the map moves", async () => {
    const move = viewport();
    useSearchStore.setState({ query, isFocused: true });
    renderBar([
      {
        type: "ai-search",
        integrationId: "search-nlp",
        aiActive: true,
        localActive: true,
        cloudActive: true,
        cloudAvailable: true,
        cloudConsentRequired: true,
        cloudProviderLabels: ["Cloud test"],
        cloudProcessors: [],
      },
    ]);
    submit(screen.getByLabelText("search.ariaLabel"));
    await screen.findByText("search.nlpConsentTitle");
    move(bboxB, [14, 53]);
    unrelatedRender();
    expect(lastContext().enabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "search.enable" }));
    await waitFor(() =>
      expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxA, enabled: true }),
    );
    expect(useNlpSearchMock.mock.calls.at(-1)?.[5]).toBe("consented");
  });

  it("requires another explicit submission after query editing", async () => {
    viewport();
    useSearchStore.setState({ query, isFocused: true });
    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    submit(input);
    await waitFor(() => expect(lastContext().enabled).toBe(true));
    fireEvent.change(input, { target: { value: "quiet cafes with wifi" } });
    await waitFor(() =>
      expect(useAutocompleteMock.mock.calls.at(-1)?.[0]).toBe("quiet cafes with wifi"),
    );
    expect(lastContext().enabled).toBe(false);
    submit(input);
    await waitFor(() =>
      expect(lastContext()).toEqual({
        query: "quiet cafes with wifi",
        center: [13.4, 52.5],
        bbox: bboxA,
        enabled: true,
      }),
    );
  });

  it("falls back to plain text search when submitted bounds are missing", async () => {
    viewport();
    useSearchStore.setState({ query, isFocused: true });
    renderBar();
    vi.spyOn(fakeMap.map, "getBounds").mockReturnValue(null as never);
    submit(screen.getByLabelText("search.ariaLabel"));
    await waitFor(() => expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, query));
    expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: null, enabled: false });
  });

  it.each(["error", "empty"])(
    "preserves the plain text fallback after an NLP %s",
    async (outcome) => {
      viewport();
      useSearchStore.setState({ query, isFocused: true });
      useNlpSearchMock.mockImplementation((...args: unknown[]) =>
        args[3]
          ? {
              data:
                outcome === "empty"
                  ? {
                      intent: { ...intent, filter: { selectors: [] } },
                      resolvedBbox: bboxA,
                      provider: "local",
                    }
                  : undefined,
              isFetching: false,
              isError: outcome === "error",
            }
          : { data: undefined, isFetching: false },
      );
      renderBar();
      submit(screen.getByLabelText("search.ariaLabel"));
      await waitFor(() => expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, query));
      expect(lastContext().enabled).toBe(false);
    },
  );

  it.each(["recent", "voice"])(
    "captures a %s submission before its suggestions settle",
    async (path) => {
      const move = viewport();
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
      if (path === "recent") useRecentSearchStore.getState().add(query);
      renderBar();
      const input = screen.getByLabelText("search.ariaLabel");
      fireEvent.focus(input);
      if (path === "recent") fireEvent.click(screen.getByRole("button", { name: query }));
      else act(() => voiceResult?.(query, true));
      expect(useSearchStore.getState().query).toBe(query);
      move(bboxB, [14, 53]);
      unrelatedRender();
      await waitFor(() => expect(useAutocompleteMock.mock.calls.at(-1)?.[0]).toBe(query));
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
      act(() => useMapStore.setState({ userLocation: null }));
      await waitFor(() =>
        expect(lastContext()).toEqual({ query, center: [13.4, 52.5], bbox: bboxA, enabled: true }),
      );
    },
  );
});

describe("SearchBar map obstruction", () => {
  // jsdom lays nothing out, so an unstubbed `getBoundingClientRect` reports an
  // all-zero box — and a zero extent is exactly how the registry spells "not on
  // screen". Every assertion here would then pass for the wrong reason.
  const BAR_BOTTOM = 56;

  beforeEach(() => {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 12,
      bottom: BAR_BOTTOM,
      left: 12,
      right: 388,
      width: 376,
      height: 44,
      x: 12,
      y: 12,
      toJSON: () => ({}),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    publishMapObstruction("search-bar", "top", null);
  });

  it("registers the bar's bottom edge on mobile and releases it on unmount", () => {
    useMediaQueryMock.mockReturnValue(true);
    const { unmount } = renderBar();
    expect(getMapObstructionInsets().top).toBe(BAR_BOTTOM);
    unmount();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("registers nothing on desktop, where the bar sits inside the rail's column", () => {
    renderBar();
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("drops the registration once the mobile search takes over the viewport", () => {
    useMediaQueryMock.mockReturnValue(true);
    renderBar();
    expect(getMapObstructionInsets().top).toBe(BAR_BOTTOM);

    fireEvent.focus(screen.getByLabelText("search.ariaLabel"));
    expect(getMapObstructionInsets().top).toBe(0);
  });

  it("leaves the map bar's registration alone from another surface", () => {
    useMediaQueryMock.mockReturnValue(true);
    renderBar();
    expect(getMapObstructionInsets().top).toBe(BAR_BOTTOM);

    // The street-level viewer covers the map outright, so its bar registers
    // nothing — and, sharing the registry with the page's bar, must not take
    // that one's entry with it when it goes.
    const viewerBar = render(<SearchBar surface="street-level" />, {
      wrapper: createQueryWrapper(),
    });
    expect(getMapObstructionInsets().top).toBe(BAR_BOTTOM);
    viewerBar.unmount();
    expect(getMapObstructionInsets().top).toBe(BAR_BOTTOM);
  });
});

describe("SearchBar NLP submission ownership", () => {
  const query = "coffee near me";
  const response: NlpParseResponse = {
    intent: {
      filter: { selectors: [{ tags: [{ key: "amenity", value: "cafe" }] }] },
      spatial_constraint: null,
      time_constraint: null,
      sort_by: "relevance",
      unmapped_attributes: [],
      confidence: 0.9,
      explanation: "Owned cafés",
    },
    resolvedBbox: { west: 0, south: 0, east: 1, north: 1 },
    provider: "local",
    providerLabel: "Local",
    cloud: false,
    cloudAvailable: false,
    cloudConsentRequired: false,
    cloudProviderLabels: [],
    cached: false,
  };
  const empty = { ...response, intent: { ...response.intent, filter: { selectors: [] } } };
  const clients: QueryClient[] = [];

  function deferred() {
    let resolve!: (value: NlpParseResponse) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<NlpParseResponse>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }

  async function start(disclosures: Disclosure[] = [], surface: "map" | "street-level" = "map") {
    const request = deferred();
    const post = vi.spyOn(apiClient, "post").mockReturnValue(request.promise);
    useNlpSearchMock.mockImplementation((...args: unknown[]) =>
      useRealNlpSearch(...(args as Parameters<typeof useRealNlpSearch>)),
    );
    useSearchStore.setState({ query, isFocused: true });
    const client = createTestQueryClient();
    clients.push(client);
    const view = render(
      <IntegrationDisclosuresProvider value={disclosures}>
        <SearchBar surface={surface} />
      </IntegrationDisclosuresProvider>,
      { wrapper: createQueryWrapper(client) },
    );
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    return { request, post, input, client, ...view };
  }

  async function finish(
    run: Awaited<ReturnType<typeof start>>,
    outcome: "empty" | "error" | "success" | "cloud consent" | "cloud open" = "empty",
  ) {
    await act(async () => {
      if (outcome === "error") run.request.reject(new Error("parse failed"));
      else
        run.request.resolve(
          outcome === "success"
            ? response
            : outcome === "cloud consent" || outcome === "cloud open"
              ? {
                  ...empty,
                  cloudAvailable: true,
                  cloudConsentRequired: outcome === "cloud consent",
                }
              : empty,
        );
    });
    await waitFor(() => expect(run.client.isFetching()).toBe(0));
    await act(async () => {});
  }

  function visibleState() {
    return {
      query: useSearchStore.getState().query,
      focused: useSearchStore.getState().isFocused,
      place: usePlaceStore.getState().selectedPlace,
      sidebar: useSidebarStore.getState().activeSidebarId,
      category: useCategorySearchStore.getState().activeCategory,
      brand: useCategorySearchStore.getState().activeBrand,
      anchor: useCategorySearchStore.getState().anchor,
      directions: useDirectionsStore.getState().isOpen,
    };
  }

  afterEach(() => {
    for (const client of clients.splice(0)) client.clear();
    vi.restoreAllMocks();
  });

  const mapPlace = createPlace({
    primaryScheme: "osm",
    ids: { osm: "node/123" },
    name: "Map café",
    address: "Fixture address",
    coordinates: [1, 1],
  });

  const viewerImage = { providerId: "panoramax", imageId: "fixture" };

  it.each(["empty", "error", "success", "cloud consent", "cloud open"] as const)(
    "keeps an external map selection after an obsolete %s response",
    async (outcome) => {
      const actual =
        await vi.importActual<typeof import("@/lib/launchExplore")>("@/lib/launchExplore");
      launchTextSearch.mockImplementation((...args: unknown[]) =>
        actual.launchTextSearch(...(args as Parameters<typeof actual.launchTextSearch>)),
      );
      const run = await start();
      act(() => {
        usePlaceStore.getState().setSelectedPlace(mapPlace);
        useSidebarStore.getState().openSidebar(PANEL.PLACE);
      });
      const state = visibleState();
      await finish(run, outcome);
      expect(visibleState()).toEqual(state);
      expect(run.post).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("Owned cafés")).toBeNull();
      expect(screen.queryByText("search.nlpConsentTitle")).toBeNull();
    },
  );

  it("cancels a same-place reselection but preserves selection enrichment", async () => {
    usePlaceStore.getState().setSelectedPlace(mapPlace);
    const run = await start();
    act(() => {
      const revision = usePlaceStore.getState().selectionRevision;
      usePlaceStore
        .getState()
        .enrichSelectedPlace(revision, { ...mapPlace, name: "Enriched café" });
    });
    await finish(run, "success");
    await screen.findByText("Owned cafés");
    act(() => usePlaceStore.getState().setSelectedPlace(usePlaceStore.getState().selectedPlace));
    expect(screen.queryByText("Owned cafés")).toBeNull();
  });

  it.each(["map", "street-level"] as const)(
    "cancels the %s submission when its surface closes, even if reopened before render",
    async (surface) => {
      if (surface === "street-level") useStreetLevelStore.setState({ activeImage: viewerImage });
      const run = await start([], surface);
      act(() => {
        if (surface === "map") {
          useStreetLevelStore.setState({ activeImage: viewerImage });
          useStreetLevelStore.getState().closeViewer();
        } else {
          useStreetLevelStore.getState().closeViewer();
          useStreetLevelStore.setState({ activeImage: viewerImage });
        }
      });
      await finish(run, "empty");
      expect(launchTextSearch).not.toHaveBeenCalled();
      expect(screen.queryByText("Owned cafés")).toBeNull();
    },
  );

  it("hands search ownership to a second mounted viewer bar sharing the query cache", async () => {
    const run = await start();
    const next = deferred();
    run.post.mockReturnValue(next.promise);
    act(() => useStreetLevelStore.setState({ activeImage: viewerImage }));
    const viewer = render(
      <IntegrationDisclosuresProvider value={[]}>
        <SearchBar surface="street-level" />
      </IntegrationDisclosuresProvider>,
      { wrapper: createQueryWrapper(run.client) },
    );
    const form = viewer.container.querySelector("form");
    if (!form) throw new Error("Missing viewer search form");
    fireEvent.submit(form);
    await waitFor(() => expect(run.post).toHaveBeenCalledTimes(2));
    await act(async () => run.request.resolve(empty));
    expect(launchTextSearch).not.toHaveBeenCalled();
    await act(async () => next.resolve(response));
    await screen.findByText("Owned cafés");
    expect(run.container.textContent).not.toContain("Owned cafés");
    expect(viewer.container.textContent).toContain("Owned cafés");
    fireEvent.click(screen.getByText("Owned cafés"));
    expect(useNlpSearchStore.getState().intent?.explanation).toBe("Owned cafés");
  });

  it("keeps a viewer submission while changing images", async () => {
    useStreetLevelStore.setState({ activeImage: viewerImage });
    const run = await start([], "street-level");
    act(() => useStreetLevelStore.setState({ activeImage: { ...viewerImage, imageId: "next" } }));
    await finish(run, "success");
    fireEvent.click(await screen.findByText("Owned cafés"));
    expect(useNlpSearchStore.getState().intent?.explanation).toBe("Owned cafés");
  });

  it.each(["selection", "viewer"])(
    "cancels pending suggestion settlement on external %s",
    async (action) => {
      const post = vi.spyOn(apiClient, "post").mockResolvedValue(response);
      useNlpSearchMock.mockImplementation((...args: unknown[]) =>
        useRealNlpSearch(...(args as Parameters<typeof useRealNlpSearch>)),
      );
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
      useSearchStore.setState({ query, isFocused: true });
      renderBar();
      fireEvent.submit(
        screen.getByLabelText("search.ariaLabel").closest("form") as HTMLFormElement,
      );
      act(() => {
        if (action === "selection") usePlaceStore.getState().setSelectedPlace(mapPlace);
        else {
          useStreetLevelStore.setState({ activeImage: viewerImage });
          useStreetLevelStore.getState().closeViewer();
        }
      });
      const state = visibleState();
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
      act(() => useMapStore.setState({ userLocation: [1, 1] }));
      await act(async () => {});
      expect(post).not.toHaveBeenCalled();
      expect(visibleState()).toEqual(state);
    },
  );

  it.each(["empty", "error"] as const)(
    "keeps Directions after an obsolete %s completion through the actual control",
    async (outcome) => {
      const run = await start();
      fireEvent.click(screen.getByLabelText("search.getDirectionsAriaLabel"));
      const state = visibleState();
      expect(state.sidebar).toBe(PANEL.DIRECTIONS);
      await finish(run, outcome);
      expect(launchTextSearch).not.toHaveBeenCalled();
      expect(visibleState()).toEqual(state);
      expect(screen.queryByText("Owned cafés")).toBeNull();
      expect(screen.queryByText("search.nlpConsentTitle")).toBeNull();
    },
  );

  it.each([
    "store Directions",
    "Escape",
    "Back",
    "clear",
    "panel close",
    "query edit",
    "store query edit",
    "voice replacement",
    "Settings off and on",
    "nearby cancel",
  ])("preserves the newer action after %s", async (action) => {
    if (action === "Back" || action === "clear") useMediaQueryMock.mockReturnValue(true);
    const run = await start();
    if (action === "store Directions")
      act(() => {
        useDirectionsStore.getState().open();
        useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
      });
    if (action === "Escape") fireEvent.keyDown(run.input, { key: "Escape" });
    if (action === "Back") fireEvent.click(screen.getByLabelText("common.back"));
    if (action === "clear") fireEvent.click(screen.getByLabelText("common.clear"));
    if (action === "panel close") {
      act(() => useSidebarStore.getState().openSidebar(PANEL.PLACE));
      fireEvent.click(screen.getByLabelText("search.closePanelAriaLabel"));
    }
    if (action === "query edit") fireEvent.change(run.input, { target: { value: "tea near me" } });
    if (action === "store query edit") act(() => useSearchStore.getState().setQuery("tea near me"));
    if (action === "voice replacement") act(() => voiceResult?.("tea near me", false));
    if (action === "Settings off and on") {
      act(() => useSettingsStore.setState({ aiSearchEnabled: false }));
      act(() => useSettingsStore.setState({ aiSearchEnabled: true }));
    }
    if (action === "nearby cancel") {
      act(() => {
        useCategorySearchStore.setState({
          anchor: { id: "anchor", name: "Anchor", coordinates: [1, 1] } as Place,
        });
        useSearchStore.getState().setIsFocused(false);
      });
      fireEvent.click(screen.getByLabelText("search.cancelNearby"));
    }
    const state = visibleState();
    const calls = launchTextSearch.mock.calls.length;
    await finish(run);
    expect(launchTextSearch).toHaveBeenCalledTimes(calls);
    expect(visibleState()).toEqual(state);
    fireEvent.focus(screen.queryByLabelText("search.ariaLabel") ?? run.input);
    expect(screen.queryByText("Owned cafés")).toBeNull();
  });

  it.each([
    "place",
    "same-label place",
    "category",
    "brand",
    "text",
    "labeled place",
    "nearby selection",
  ])("keeps an explicit %s selection after the older parse finishes", async (action) => {
    const run = await start();
    const row: AutocompleteResult = {
      id: "osm:node/123",
      label: action === "same-label place" ? query : "Coffee Place",
      type: "poi",
      coordinates: [1, 1],
    };
    if (action === "category") Object.assign(row, { id: "category-cafes", type: "category" });
    if (action === "brand")
      Object.assign(row, {
        type: "brand",
        brand: { qid: "Q1", name: "Coffee Place", kind: ["brand"], matchedOn: "name" },
      });
    if (action === "labeled place") row.type = "labeled_place";
    useAutocompleteMock.mockReturnValue({ data: [row], isFetching: false });
    act(() => useMapStore.setState({ userLocation: [1, 1] }));
    if (action === "nearby selection") {
      act(() =>
        useCategorySearchStore.setState({
          anchor: { id: "anchor", name: "Anchor", coordinates: [1, 1] } as Place,
        }),
      );
      fireEvent.click(screen.getByRole("option", { name: /search.searchFreeText/ }));
    } else if (action === "text")
      fireEvent.click(screen.getByRole("option", { name: /search.searchQueryInArea/ }));
    else fireEvent.click(await screen.findByRole("option", { name: new RegExp(row.label) }));
    const state = visibleState();
    const calls = launchTextSearch.mock.calls.length;
    await finish(run);
    expect(visibleState()).toEqual(state);
    expect(launchTextSearch).toHaveBeenCalledTimes(calls);
  });

  it.each(["Settings off/on", "query away/back", "Directions open/close"])(
    "irrevocably cancels pending suggestion settlement after %s",
    async (action) => {
      const post = vi.spyOn(apiClient, "post").mockResolvedValue(response);
      useNlpSearchMock.mockImplementation((...args: unknown[]) =>
        useRealNlpSearch(...(args as Parameters<typeof useRealNlpSearch>)),
      );
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
      useSearchStore.setState({ query, isFocused: true });
      renderBar();
      const input = screen.getByLabelText("search.ariaLabel");
      fireEvent.submit(input.closest("form") as HTMLFormElement);
      if (action === "Settings off/on") {
        act(() => useSettingsStore.setState({ aiSearchEnabled: false }));
        act(() => useSettingsStore.setState({ aiSearchEnabled: true }));
      } else if (action === "query away/back")
        act(() => {
          useSearchStore.getState().setQuery("tea near me");
          useSearchStore.getState().setQuery(query);
        });
      else
        act(() => {
          useDirectionsStore.getState().open();
          useDirectionsStore.getState().close();
        });
      const state = visibleState();
      useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
      act(() => useMapStore.setState({ userLocation: [1, 1] }));
      await act(async () => {});
      expect(post).not.toHaveBeenCalled();
      expect(launchTextSearch).not.toHaveBeenCalled();
      expect(visibleState()).toEqual(state);
      expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(false);
    },
  );

  it.each(["query", "Directions", "Settings"])(
    "does not publish from a pending timer before a %s store change flushes",
    async (action) => {
      vi.useFakeTimers();
      try {
        const post = vi.spyOn(apiClient, "post").mockResolvedValue(response);
        useNlpSearchMock.mockImplementation((...args: unknown[]) =>
          useRealNlpSearch(...(args as Parameters<typeof useRealNlpSearch>)),
        );
        useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
        useSearchStore.setState({ query, isFocused: true });
        renderBar();
        const input = screen.getByLabelText("search.ariaLabel");
        fireEvent.submit(input.closest("form") as HTMLFormElement);
        act(() => vi.advanceTimersByTime(2_499));
        let state: ReturnType<typeof visibleState> | undefined;
        act(() => {
          useSearchStore.getState().setIsFocused(false);
          if (action === "query") useSearchStore.getState().setQuery("tea near me");
          if (action === "Directions") {
            useDirectionsStore.getState().open();
            useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
          }
          if (action === "Settings") useSettingsStore.setState({ aiSearchEnabled: false });
          state = visibleState();
          vi.advanceTimersByTime(1);
        });
        await act(async () => {});
        expect(visibleState()).toEqual(state);
        expect(post).not.toHaveBeenCalled();
        expect(launchTextSearch).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("settles an explicit plain submission while AI was already disabled", async () => {
    const post = vi.spyOn(apiClient, "post").mockResolvedValue(response);
    useNlpSearchMock.mockImplementation((...args: unknown[]) =>
      useRealNlpSearch(...(args as Parameters<typeof useRealNlpSearch>)),
    );
    useSettingsStore.setState({ aiSearchEnabled: false });
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: true });
    useSearchStore.setState({ query, isFocused: true });
    renderBar();
    fireEvent.submit(screen.getByLabelText("search.ariaLabel").closest("form") as HTMLFormElement);
    useAutocompleteMock.mockReturnValue({ data: undefined, isFetching: false });
    act(() => useMapStore.setState({ userLocation: [1, 1] }));
    await waitFor(() => expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, query));
    expect(launchTextSearch).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps a labeled-place empty-search shortcut after an earlier submission", async () => {
    const run = await start();
    useSessionMock.mockReturnValue({ data: { user: { id: "test-user" } } });
    useLabeledPlacesMock.mockReturnValue({
      data: [
        {
          id: "home",
          label: "home",
          name: "My Home",
          address: "Home address",
          lat: 1,
          lng: 1,
          placeId: "osm:node/5",
          icon: null,
        },
      ],
    });
    act(() => useSearchStore.getState().setQuery(""));
    fireEvent.click(screen.getByRole("button", { name: /saved.home/ }));
    const state = visibleState();
    expect(state.place?.name).toBe("My Home");
    expect(state.sidebar).toBe(PANEL.PLACE);
    await finish(run, "success");
    expect(visibleState()).toEqual(state);
    expect(launchTextSearch).not.toHaveBeenCalled();
  });

  it.each(["empty", "error"] as const)(
    "falls back exactly once for an active %s response",
    async (outcome) => {
      const run = await start();
      await finish(run, outcome);
      await waitFor(() => expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, query));
      expect(launchTextSearch).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a successful response through blur and refocus and consumes it on activation", async () => {
    const run = await start();
    fireEvent.blur(run.input);
    await waitFor(() => expect(useSearchStore.getState().isFocused).toBe(false));
    await finish(run, "success");
    fireEvent.focus(run.input);
    fireEvent.click(await screen.findByText("Owned cafés"));
    expect(useNlpSearchStore.getState().isNlpActive).toBe(true);
    expect(useCategorySearchStore.getState().searchBbox).toEqual(response.resolvedBbox);
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
    fireEvent.focus(run.input);
    expect(screen.queryByText("Owned cafés")).toBeNull();
  });

  it("hides an abandoned cached success until the same text is explicitly submitted again", async () => {
    const run = await start();
    await finish(run, "success");
    await screen.findByText("Owned cafés");
    fireEvent.keyDown(run.input, { key: "Escape" });
    fireEvent.focus(run.input);
    expect(screen.queryByText("Owned cafés")).toBeNull();
    fireEvent.submit(run.input.closest("form") as HTMLFormElement);
    await screen.findByText("Owned cafés");
    expect(run.post).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "cloud consent", "cloud open"] as const)(
    "keeps an abandoned %s result invisible and inert after Escape",
    async (outcome) => {
      const run = await start();
      fireEvent.keyDown(run.input, { key: "Escape" });
      const state = visibleState();
      await finish(run, outcome);
      expect(visibleState()).toEqual(state);
      expect(launchTextSearch).not.toHaveBeenCalled();
      expect(run.post).toHaveBeenCalledTimes(1);
      fireEvent.focus(run.input);
      expect(screen.queryByText("Owned cafés")).toBeNull();
      expect(screen.queryByText("search.nlpConsentTitle")).toBeNull();
    },
  );

  it.each(["accept", "decline"])(
    "preserves active consent %s through ordinary blur",
    async (choice) => {
      const run = await start();
      const cloud = deferred();
      run.post.mockReturnValue(cloud.promise);
      await act(async () =>
        run.request.resolve({ ...empty, cloudAvailable: true, cloudConsentRequired: true }),
      );
      await screen.findByText("search.nlpConsentTitle");
      expect(launchTextSearch).not.toHaveBeenCalled();
      fireEvent.blur(run.input);
      fireEvent.click(
        screen.getByRole("button", {
          name: choice === "accept" ? "search.enable" : "search.noThanks",
        }),
      );
      if (choice === "accept") {
        await waitFor(() => expect(run.post).toHaveBeenCalledTimes(2));
        expect(run.post.mock.calls[1]?.[1]).toEqual(
          expect.objectContaining({ cloudAccess: "consented", query }),
        );
        await act(async () => cloud.resolve(response));
        fireEvent.focus(run.input);
        await screen.findByText("Owned cafés");
        expect(launchTextSearch).not.toHaveBeenCalled();
      } else {
        await waitFor(() => expect(launchTextSearch).toHaveBeenCalledWith(fakeMap.map, query));
        expect(launchTextSearch).toHaveBeenCalledTimes(1);
        expect(run.post).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("retries an active open-cloud response with the existing submitted context", async () => {
    const run = await start();
    const cloud = deferred();
    run.post.mockReturnValue(cloud.promise);
    await act(async () => run.request.resolve({ ...empty, cloudAvailable: true }));
    await waitFor(() => expect(run.post).toHaveBeenCalledTimes(2));
    expect(run.post.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ query, cloudAccess: "defer-to-server" }),
    );
    expect(launchTextSearch).not.toHaveBeenCalled();
    await act(async () => cloud.resolve(response));
    await screen.findByText("Owned cafés");
  });

  it.each(["accept", "decline"])(
    "makes an obsolete consent %s callback inert before a store update flushes",
    async (choice) => {
      const run = await start();
      await act(async () =>
        run.request.resolve({ ...empty, cloudAvailable: true, cloudConsentRequired: true }),
      );
      await screen.findByText("search.nlpConsentTitle");
      const callback = choice === "accept" ? consentActions?.onAccept : consentActions?.onDecline;
      expect(callback).toBeDefined();
      const storage = { ...localStorage };
      act(() => {
        useDirectionsStore.getState().open();
        useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
        callback?.();
      });
      expect({ ...localStorage }).toEqual(storage);
      expect(run.post).toHaveBeenCalledTimes(1);
      expect(launchTextSearch).not.toHaveBeenCalled();
      expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.DIRECTIONS);
      expect(screen.queryByText("search.nlpConsentTitle")).toBeNull();
    },
  );

  it("ignores an old success while a different submission waits for its debounce", async () => {
    const run = await start();
    const next = deferred();
    run.post.mockReturnValue(next.promise);
    fireEvent.change(run.input, { target: { value: "tea near me" } });
    fireEvent.submit(run.input.closest("form") as HTMLFormElement);
    await act(async () =>
      run.request.resolve({ ...response, cloudAvailable: true, cloudConsentRequired: true }),
    );
    expect(screen.queryByText("Owned cafés")).toBeNull();
    expect(screen.queryByText("search.nlpConsentTitle")).toBeNull();
    expect(launchTextSearch).not.toHaveBeenCalled();
    await waitFor(() => expect(run.post).toHaveBeenCalledTimes(2));
    expect(run.post.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ query: "tea near me" }));
    await act(async () =>
      next.resolve({ ...response, intent: { ...response.intent, explanation: "Owned tea" } }),
    );
    await screen.findByText("Owned tea");
    expect(screen.queryByText("Owned cafés")).toBeNull();
    fireEvent.click(screen.getByText("Owned tea"));
    expect(useNlpSearchStore.getState().intent?.explanation).toBe("Owned tea");
  });
});

it("keeps captured source fields when an autocomplete row becomes a selected place", async () => {
  const name = { sourceId: "name", name: "Name supplier" };
  const geometry = { sourceId: "geometry", name: "Geometry supplier" };
  useAutocompleteMock.mockReturnValue({
    data: [
      {
        id: "osm:node/1",
        label: "Cafe Aurora",
        sublabel: "Street",
        type: "poi",
        coordinates: [8, 50],
        contributors: [name, geometry],
        fieldContributors: {
          label: [name],
          sublabel: [name],
          coordinates: [geometry],
          id: [name],
          type: [],
        },
      },
    ],
    isFetching: false,
  });
  renderBar();
  const input = screen.getByLabelText("search.ariaLabel");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Cafe Aurora" } });
  fireEvent.click(await screen.findByRole("option", { name: /Cafe Aurora/ }));
  const selected = usePlaceStore.getState().selectedPlace;
  expect(selected?.fieldContributors?.name).toEqual([name]);
  expect(selected?.fieldContributors?.coordinates).toEqual([geometry]);
  name.name = "Changed catalogue";
  expect(selected?.fieldContributors?.name?.[0].name).toBe("Name supplier");
});

it("retains direct object and address evidence when a MapTiler row is selected", async () => {
  const evidence = {
    source: "overpass",
    method: "osm-tags",
    recordId: "osm:way/1",
    components: { road: "Grunerstraße", house_number: "20" },
  };
  const reference = { source: "geocoding-maptiler", recordId: "maptiler:poi.1", osmRef: "way/1" };
  useAutocompleteMock.mockReturnValue({
    data: [
      {
        id: "maptiler:poi.1",
        label: "Cafe Aurora",
        sublabel: "Cafe Aurora, Alexanderstraße 25",
        address: "Grunerstraße 20",
        addressEvidence: evidence,
        directOsmReference: reference,
        ids: { osm: "way/1", wikidata: "Q1" },
        type: "poi",
        coordinates: [8, 50],
      },
    ],
    isFetching: false,
  });
  renderBar();
  const input = screen.getByLabelText("search.ariaLabel");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Cafe Aurora" } });
  fireEvent.click(await screen.findByRole("option", { name: /Cafe Aurora/ }));
  const selected = usePlaceStore.getState().selectedPlace;
  expect(selected?.id).toBe("maptiler:poi.1");
  expect(selected?.ids).toEqual({ maptiler: "poi.1", osm: "way/1", wikidata: "Q1" });
  expect(selected?.address).toBe("Grunerstraße 20");
  expect(selected?.addressEvidence).toEqual(evidence);
  expect(selected?.directOsmReference).toEqual(reference);
});

describe("SearchBar credit focus ownership", () => {
  it.each([
    ["desktop", false, "pointer"],
    ["desktop", false, "keyboard"],
    ["mobile", true, "pointer"],
    ["mobile", true, "keyboard"],
  ] as const)(
    "retains %s brand credit controls and dialogs (mobile=%s, %s)",
    async (_surface, mobile, interaction) => {
      useMediaQueryMock.mockReturnValue(mobile);
      useBrandSuggestMock.mockReturnValue({
        data: {
          matches: [
            {
              qid: "Q1",
              name: "Brand",
              kind: ["brand"],
              logoFile: "Brand.svg",
              matchedOn: "name",
              presence: "here",
            },
          ],
        },
      });
      useBrandLogoAttributionMock.mockReturnValue({
        data: {
          logoFile: "Brand.svg",
          url: "https://image.test/brand.svg",
          pageUrl: "https://commons.wikimedia.org/wiki/File:Brand.svg",
          source: "wikimedia-commons",
          author: "Captured brand artist",
          licensing: licensingFromDeclaration(
            "CC BY 4.0",
            "https://creativecommons.org/licenses/by/4.0/",
          ),
        },
      });
      const outside = document.createElement("button");
      outside.textContent = "Outside search";
      document.body.appendChild(outside);
      try {
        renderBar();
        const user = userEvent.setup();
        const input = screen.getByLabelText("search.ariaLabel");
        await user.click(input);
        fireEvent.change(input, { target: { value: "Brand" } });
        const trigger = await screen.findByRole("button", { name: "photoGallery.credits" });

        if (interaction === "keyboard") {
          for (let step = 0; step < 20 && document.activeElement !== trigger; step++)
            await user.tab();
          expect(trigger).toHaveFocus();
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
          });
          expect(useSearchStore.getState().isFocused).toBe(true);
          await user.keyboard("{Enter}");
        } else await user.click(trigger);
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
        });
        expect(screen.getByRole("dialog", { name: "photoGallery.credits" })).toBeVisible();
        expect(useSearchStore.getState().isFocused).toBe(true);
        expect(usePlaceStore.getState().selectedPlace).toBeNull();
        await user.tab();
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
        });
        expect(
          screen
            .getByRole("dialog", { name: "photoGallery.credits" })
            .contains(document.activeElement),
        ).toBe(true);
        if (interaction === "keyboard") await user.keyboard("{Escape}");
        else await user.click(screen.getByRole("button", { name: "common.close" }));
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 300));
        });
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(trigger).toHaveFocus();
        expect(screen.getByRole("listbox")).toBeVisible();
        act(() => outside.focus());
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
        });
        expect(useSearchStore.getState().isFocused).toBe(false);
        expect(screen.queryByRole("listbox")).toBeNull();
      } finally {
        outside.remove();
      }
    },
  );
});
