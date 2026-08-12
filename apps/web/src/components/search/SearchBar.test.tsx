import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeMap, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const useAutocompleteMock = vi.fn();
const useGeocodingMock = vi.fn();
const useNlpSearchMock = vi.fn();
const useSearchSuggestionsMock = vi.fn();
const useBrandSuggestMock = vi.fn();
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
    usePresetSuggest: () => ({ data: undefined }),
    useChipTranslations: () => ({ data: {} }),
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
  useNlpSearchStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import type { Disclosure } from "@openmapx/integration-framework";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { IntegrationDisclosuresProvider } from "@/lib/integrationDisclosuresContext";
import { SearchBar } from "./SearchBar";

beforeEach(() => {
  useAutocompleteMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useGeocodingMock.mockReset().mockReturnValue({ data: [] });
  useNlpSearchMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useSearchSuggestionsMock.mockReset().mockReturnValue({ data: undefined, isFetching: false });
  useBrandSuggestMock.mockReset().mockReturnValue({ data: undefined });
  resolveStopAsPlaceMock.mockReset();
  useMediaQueryMock.mockReset().mockReturnValue(false);
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

    await screen.findByRole("button", { name: /Frankfurt am Main Airport.*FRA/i });
    expect(screen.getAllByText("Frankfurt am Main Airport")).toHaveLength(1);
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

    await screen.findByText("Frankfurt am Main Airport");
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

  it("places a generated acronym below a normal geocoder hit and selects its stable OSM id", async () => {
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
          id: "geo:unc",
          label: "UNC Charlotte",
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

    const normal = await screen.findByText("UNC Charlotte");
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
      data: [{ id: "geo:berlin", label: "Berlin", coordinates: [13.4, 52.5], type: "region" }],
      isFetching: false,
    });
    useBrandSuggestMock.mockReturnValue({
      data: { matches: [{ qid: "Q1", name: "Berliner Coffee", tags: {} }] },
    });

    renderBar();
    const input = screen.getByLabelText("search.ariaLabel");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "ber" } });

    await screen.findByText("Berlin");
    screen.getByText("Berliner Coffee");
    screen.getByText("Hairdressers & Barbers");
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
