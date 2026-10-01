import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getMapObstructionInsets, publishMapObstruction } from "@/lib/mapObstructions";
import { act, createFakeMap, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const useAutocompleteMock = vi.fn();
const useGeocodingMock = vi.fn();
const useNlpSearchMock = vi.fn();
const useSearchSuggestionsMock = vi.fn();
const useBrandSuggestMock = vi.fn();
const usePresetSuggestMock = vi.fn();
const useChipTranslationsMock = vi.fn();
const resolveStopAsPlaceMock = vi.fn();
const useMediaQueryMock = vi.fn();
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
    resolveStopAsPlace: (...a: unknown[]) => resolveStopAsPlaceMock(...a),
    usePresetSuggest: (...a: unknown[]) => usePresetSuggestMock(...a),
    useChipTranslations: (...a: unknown[]) => useChipTranslationsMock(...a),
    useLabeledPlaces: () => ({ data: undefined }),
    // The mobile empty state only needs a signed-out session. Keep the real
    // Better Auth client (and its delayed browser lifecycle) out of this test.
    useSession: () => ({ data: null }),
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
  Place,
  SearchSuggestion,
  SearchSuggestionsResponse,
} from "@openmapx/core";
import {
  PANEL,
  useCategorySearchStore,
  useDirectionsStore,
  useMapStore,
  useNlpSearchStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import type { Disclosure } from "@openmapx/integration-framework";
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
  useAutocompleteMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useGeocodingMock.mockReset().mockReturnValue({ data: [] });
  useNlpSearchMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useSearchSuggestionsMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useBrandSuggestMock.mockReset().mockReturnValue({ data: undefined });
  usePresetSuggestMock.mockReset().mockReturnValue({ data: undefined });
  useChipTranslationsMock.mockReset().mockReturnValue({ data: {} });
  resolveStopAsPlaceMock.mockReset();
  useMediaQueryMock.mockReset().mockReturnValue(false);
  flyToMock.mockReset();
  fakeMap.state.center = { lng: 0, lat: 0 };
  launchExploreFromPlace.mockReset();
  launchExploreTextSearch.mockReset();
  launchTextSearch.mockReset();
  useSearchStore.getState().reset();
  useDirectionsStore.getState().close(); // SearchBar returns null while directions open
  useCategorySearchStore.setState({ anchor: null, exploreBoxOpen: false, activeCategory: null });
  usePlaceStore.setState({ selectedPlace: null });
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

const renderBar = (disclosures: Disclosure[] = []) =>
  render(
    <IntegrationDisclosuresProvider value={disclosures}>
      <SearchBar />
    </IntegrationDisclosuresProvider>,
    { wrapper: createQueryWrapper() },
  );

describe("SearchBar", () => {
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

  it("shows response-scoped attribution in the mobile results panel", async () => {
    useMediaQueryMock.mockReturnValue(true);
    useSearchSuggestionsMock.mockReturnValue({
      data: aggregateResponse(
        [
          aggregateSuggestion({
            id: "oa:EDDF",
            label: "Frankfurt am Main Airport",
            searchMatch: { kind: "authoritative_code", value: "FRA", normalized: "fra" },
            provider: "knowledge-ourairports",
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
