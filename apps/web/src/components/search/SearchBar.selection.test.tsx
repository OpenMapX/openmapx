import {
  PANEL,
  useCategorySearchStore,
  useDataSourceStore,
  useDirectionsStore,
  usePlaceStore,
  useSearchStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import { IntegrationRegistry } from "@openmapx/integration-framework";
import { IntegrationRegistryContext } from "@openmapx/integration-framework/react";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntegrationDisclosuresProvider } from "@/lib/integrationDisclosuresContext";
import { useRecentSearchStore } from "@/stores/recentSearchStore";
import { createFakeMap, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";
import { SearchBar } from "./SearchBar";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const session = vi.hoisted(() => ({ signedIn: false }));
vi.mock("../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({
    data: session.signedIn ? { user: { id: "user-1" } } : null,
    isPending: false,
    error: null,
  }),
}));

vi.mock("@mui/material/useMediaQuery", () => ({ default: () => false }));
vi.mock("./VoiceSearchButton", () => ({ VoiceSearchButton: () => null }));
vi.mock("@/components/auth/AccountAvatarButton", () => ({ AccountAvatarButton: () => null }));

const fakeMap = createFakeMap();
const flyToMock = vi.fn();
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fakeMap.map },
    mapReady: true,
    styleVersion: 0,
    flyTo: flyToMock,
    fitBounds: vi.fn(),
  }),
}));

// The searches a selection starts are map commands; what they would show is not under test.
const launchExploreFromPlace = vi.fn();
const launchExploreTextSearch = vi.fn();
const launchTextSearch = vi.fn();
vi.mock("@/lib/launchExplore", () => ({
  launchExploreFromPlace: (...a: unknown[]) => launchExploreFromPlace(...a),
  launchExploreTextSearch: (...a: unknown[]) => launchExploreTextSearch(...a),
  launchTextSearch: (...a: unknown[]) => launchTextSearch(...a),
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const HAMBURG_HBF: TransitStop = {
  id: "db:8000002",
  name: "Hamburg Hbf",
  lat: 53.5526,
  lng: 10.0067,
  modes: ["rail"],
  provider: "transit-db-vendo",
};

/** The API's answers by path; a path left out answers empty, an unknown one fails the test. */
type Answers = Partial<Record<string, unknown>>;

const EMPTY_ANSWERS: Record<string, unknown> = {
  "/api/integrations/geocoding/autocomplete": [],
  "/api/integrations/geocoding/geocode": [],
  "/api/integrations/geocoding/geocode/country": { countryCode: null },
  "/api/integrations/search-suggestions/search": {
    suggestions: [],
    attributions: [],
    partial: false,
  },
  "/api/integrations/poi-search/preset-suggest": { matches: [] },
  "/api/integrations/poi-search/brand-suggest": { matches: [] },
  "/api/integrations/poi-search/chip-translations": {},
  "/api/integrations/data-source": { sources: [] },
  "/api/integrations/transit/stops": [],
  "/api/saved/labels": { labels: [] },
};

function answerWith(answers: Answers) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://localhost");
    if (pathname in answers) return Response.json(answers[pathname]);
    if (pathname in EMPTY_ANSWERS) return Response.json(EMPTY_ANSWERS[pathname]);
    throw new TypeError(`Unexpected request in the search selection test: ${pathname}`);
  });
}

beforeEach(() => {
  session.signedIn = false;
  flyToMock.mockReset();
  launchExploreFromPlace.mockReset();
  launchExploreTextSearch.mockReset();
  launchTextSearch.mockReset();
  fakeMap.state.center = { lng: 10, lat: 53.55 };
  fakeMap.state.zoom = 12;
  useSearchStore.getState().reset();
  useDirectionsStore.getState().close();
  useCategorySearchStore.getState().clearCategory();
  useDataSourceStore.getState().setActiveSource(null);
  useCategorySearchStore.setState({ anchor: null, exploreBoxOpen: false, activeCategory: null });
  usePlaceStore.setState({ selectedPlace: null });
  useSidebarStore.setState({ activeSidebarId: null });
  // Without the AI parse, Enter on a word with no confident match searches the visible area.
  useSettingsStore.setState({ aiSearchEnabled: false, searchHistoryEnabled: true });
  useRecentSearchStore.getState().clear();
  localStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

/** What a selection did, in the terms a user sees: the open place and panel, the map, the searches. */
function outcome() {
  const place = usePlaceStore.getState().selectedPlace;
  const category = useCategorySearchStore.getState();
  return {
    query: useSearchStore.getState().query,
    place: place
      ? {
          name: place.name,
          address: place.address,
          coordinates: place.coordinates,
          category: place.category,
          transitStop: place.transitStop?.name,
        }
      : null,
    panel: useSidebarStore.getState().activeSidebarId,
    flyTo: flyToMock.mock.calls,
    activeCategory: category.activeCategory,
    activeBrand: category.activeBrand?.qid ?? null,
    activeSource: useDataSourceStore.getState().activeSource,
    textSearch: launchTextSearch.mock.calls.map((call) => call[1]),
    exploreTextSearch: launchExploreTextSearch.mock.calls.map((call) => call[2]),
  };
}

const nothingDone = {
  place: null,
  panel: null,
  flyTo: [],
  activeCategory: null,
  activeBrand: null,
  activeSource: null,
  textSearch: [],
  exploreTextSearch: [],
};

const PARKING_REGISTRY = new IntegrationRegistry([
  {
    id: "parking",
    name: "Parking",
    enabled: true,
    isBuiltIn: true,
    domains: ["data-source"],
    frontend: { searchCategory: { id: "parking", label: "Parking" } },
  },
]);

interface SelectionCase {
  branch: string;
  registry?: IntegrationRegistry;
  answers?: Answers;
  setup?: () => void;
  typed: string;
  row: RegExp;
  expected: ReturnType<typeof outcome>;
}

const CASES: SelectionCase[] = [
  {
    branch: "recent_search",
    setup: () => useRecentSearchStore.getState().add("pizza margherita"),
    typed: "pizza",
    row: /^pizza margherita/,
    expected: {
      ...nothingDone,
      query: "pizza margherita",
      textSearch: ["pizza margherita"],
    },
  },
  {
    branch: "text_search",
    typed: "bakery",
    row: /search\.searchQueryInArea/,
    expected: { ...nothingDone, query: "bakery", textSearch: ["bakery"] },
  },
  {
    branch: "labeled_place",
    setup: () => {
      session.signedIn = true;
    },
    answers: {
      "/api/saved/labels": {
        labels: [
          {
            id: "label-1",
            label: "home",
            icon: null,
            name: "Wohnung",
            address: "Lange Reihe 1, Hamburg",
            lat: 53.556,
            lng: 10.011,
            placeId: null,
          },
        ],
      },
    },
    typed: "Lange",
    row: /saved\.home/,
    expected: {
      ...nothingDone,
      query: "saved.home",
      place: {
        name: "Wohnung",
        address: "Lange Reihe 1, Hamburg",
        coordinates: [10.011, 53.556],
        category: undefined,
        transitStop: undefined,
      },
      panel: PANEL.PLACE,
      flyTo: [[[10.011, 53.556], 15]],
    },
  },
  {
    branch: "transit_stop",
    answers: {
      "/api/integrations/geocoding/autocomplete": [
        {
          id: HAMBURG_HBF.id,
          label: HAMBURG_HBF.name,
          coordinates: [HAMBURG_HBF.lng, HAMBURG_HBF.lat],
          type: "transit_stop",
          transitStop: HAMBURG_HBF,
        },
      ],
    },
    typed: "Hamburg Hbf",
    row: /^Hamburg Hbf/,
    expected: {
      ...nothingDone,
      query: "Hamburg Hbf",
      place: {
        name: "Hamburg Hbf",
        address: "Hamburg Hbf",
        coordinates: [HAMBURG_HBF.lng, HAMBURG_HBF.lat],
        category: "station",
        transitStop: "Hamburg Hbf",
      },
      panel: PANEL.PLACE,
      flyTo: [[[HAMBURG_HBF.lng, HAMBURG_HBF.lat], 15]],
    },
  },
  {
    branch: "brand",
    answers: {
      "/api/integrations/poi-search/brand-suggest": {
        matches: [
          {
            qid: "Q37158",
            name: "Starbucks",
            kind: ["brand"],
            matchedOn: "name",
            matchedValue: "Starbucks",
            presence: "here",
          },
        ],
      },
    },
    typed: "Starbu",
    row: /^Starbucks/,
    expected: {
      ...nothingDone,
      query: "Starbucks",
      panel: PANEL.CATEGORY,
      // A chain is searched as a filter over places, not as one of the fixed categories.
      activeCategory: "nlp:filter",
      activeBrand: "Q37158",
    },
  },
  {
    branch: "category",
    typed: "restaurant",
    row: /^Restaurants/,
    expected: {
      ...nothingDone,
      query: "Restaurants",
      panel: PANEL.CATEGORY,
      activeCategory: "restaurants",
    },
  },
  {
    branch: "data-source category",
    registry: PARKING_REGISTRY,
    answers: { "/api/integrations/data-source": { sources: [{ id: "parking" }] } },
    typed: "parking",
    row: /^Parking search\.searchCategory$/,
    expected: {
      ...nothingDone,
      query: "Parking",
      panel: PANEL.DATASOURCE,
      activeSource: "parking",
    },
  },
  {
    branch: "coordinates",
    typed: "52.52, 13.405",
    row: /52\.52/,
    expected: {
      ...nothingDone,
      query: "52.52, 13.405",
      place: {
        name: "52.52, 13.405",
        address: "52.52, 13.405",
        coordinates: [13.405, 52.52],
        category: "address",
        transitStop: undefined,
      },
      panel: PANEL.PLACE,
      flyTo: [[[13.405, 52.52], 15]],
    },
  },
  {
    branch: "region",
    answers: {
      "/api/integrations/geocoding/autocomplete": [
        {
          id: "osm:relation/62782",
          label: "Hamburg",
          sublabel: "Germany",
          coordinates: [10.0, 53.55],
          type: "region",
          rawCategory: "place/city",
        },
      ],
    },
    typed: "Hambur",
    row: /^Hamburg/,
    expected: {
      ...nothingDone,
      query: "Hamburg",
      place: {
        name: "Hamburg",
        address: "Germany",
        coordinates: [10.0, 53.55],
        category: "region",
        transitStop: undefined,
      },
      panel: PANEL.PLACE,
    },
  },
  {
    branch: "a geocoded station",
    answers: {
      "/api/integrations/geocoding/autocomplete": [
        {
          id: "osm:node/1",
          label: "Hamburg Hbf",
          sublabel: "Hamburg, Germany",
          coordinates: [10.0069, 53.5528],
          type: "poi",
          rawCategory: "railway/station",
        },
      ],
      "/api/integrations/transit/stops": [HAMBURG_HBF],
    },
    typed: "Hamburg Hbf",
    row: /^Hamburg Hbf/,
    expected: {
      ...nothingDone,
      query: "Hamburg Hbf",
      place: {
        name: "Hamburg Hbf",
        address: "Hamburg Hbf",
        coordinates: [HAMBURG_HBF.lng, HAMBURG_HBF.lat],
        category: "station",
        transitStop: "Hamburg Hbf",
      },
      panel: PANEL.PLACE,
      flyTo: [[[10.0069, 53.5528], 15]],
    },
  },
  {
    branch: "nearby-freetext",
    setup: () =>
      useCategorySearchStore.setState({
        anchor: {
          id: "osm:node/9",
          primaryScheme: "osm",
          ids: { osm: "node/9" },
          name: "Rathaus",
          address: "Rathausmarkt 1",
          coordinates: [9.993, 53.55],
        },
      }),
    typed: "pizza",
    row: /search\.searchFreeText/,
    expected: { ...nothingDone, query: "pizza", exploreTextSearch: ["pizza"] },
  },
];

describe("choosing a search suggestion", () => {
  it.each(CASES)(
    "acts on a $branch row",
    async ({
      answers = {},
      registry = new IntegrationRegistry([]),
      setup,
      typed,
      row,
      expected,
    }) => {
      answerWith(answers);
      setup?.();
      render(
        <IntegrationRegistryContext.Provider value={registry}>
          <IntegrationDisclosuresProvider value={[]}>
            <SearchBar />
          </IntegrationDisclosuresProvider>
        </IntegrationRegistryContext.Provider>,
        { wrapper: createQueryWrapper() },
      );
      const input = screen.getByLabelText("search.ariaLabel");
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: typed } });

      fireEvent.click(await screen.findByRole("option", { name: row }));

      await waitFor(() => expect(outcome()).toEqual(expected));
    },
  );
});
