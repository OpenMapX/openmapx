import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const useAutocompleteMock = vi.fn();
const useGeocodingMock = vi.fn();
const useNlpSearchMock = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useAutocomplete: (...a: unknown[]) => useAutocompleteMock(...a),
    useGeocoding: (...a: unknown[]) => useGeocodingMock(...a),
    useNlpSearch: (...a: unknown[]) => useNlpSearchMock(...a),
    usePresetSuggest: () => ({ data: undefined }),
    useAirportSearch: () => ({ data: undefined }),
    useChipTranslations: () => ({ data: {} }),
    useStopSearch: () => ({ data: undefined }),
    useLabeledPlaces: () => ({ data: undefined }),
  };
});

const fakeMap = createFakeMap();
const flyToMock = vi.fn();
vi.mock("@/lib/MapContext", () => ({
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

vi.mock("@/components/auth/AccountAvatarButton", () => ({
  AccountAvatarButton: () => null,
}));

const launchExploreFromPlace = vi.fn();
const launchExploreTextSearch = vi.fn();
const launchTextSearch = vi.fn();
vi.mock("@/lib/launchExplore", () => ({
  launchExploreFromPlace: (...a: unknown[]) => launchExploreFromPlace(...a),
  launchExploreTextSearch: (...a: unknown[]) => launchExploreTextSearch(...a),
  launchTextSearch: (...a: unknown[]) => launchTextSearch(...a),
}));

import type { AutocompleteResult, Place } from "@openmapx/core";
import {
  PANEL,
  useCategorySearchStore,
  useDirectionsStore,
  useNlpSearchStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import { SearchBar } from "./SearchBar";

beforeEach(() => {
  useAutocompleteMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useGeocodingMock.mockReset().mockReturnValue({ data: [] });
  useNlpSearchMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  flyToMock.mockReset();
  launchExploreFromPlace.mockReset();
  launchExploreTextSearch.mockReset();
  launchTextSearch.mockReset();
  useSearchStore.getState().reset();
  useDirectionsStore.getState().close(); // SearchBar returns null while directions open
  useCategorySearchStore.setState({ anchor: null, exploreBoxOpen: false, activeCategory: null });
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null });
  useSettingsStore.setState({ aiSearchEnabled: true });
});

const renderBar = () => render(<SearchBar />, { wrapper: createQueryWrapper() });

describe("SearchBar", () => {
  it("mounts and renders the search input", () => {
    renderBar();
    screen.getByLabelText("search.ariaLabel");
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
      expect(lastCall).toEqual(["berlin", "en"]);
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

    await screen.findByText("Berlin Hbf");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(flyToMock).toHaveBeenCalledWith([13.369, 52.525], 15);
    expect(usePlaceStore.getState().selectedPlace?.name).toBe("Berlin Hbf");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.PLACE);
    expect(useSearchStore.getState().query).toBe("Berlin Hbf");
    expect(useSearchStore.getState().isFocused).toBe(false);
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
    expect(useNlpSearchMock.mock.calls.at(-1)?.[3]).toBe(true);

    await screen.findByText("Cafés with WiFi");

    fireEvent.click(screen.getByText("Cafés with WiFi"));

    expect(useNlpSearchStore.getState().isNlpActive).toBe(true);
    expect(useNlpSearchStore.getState().provider).toBe("local");
    expect(useSidebarStore.getState().activeSidebarId).toBe(PANEL.CATEGORY);
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
