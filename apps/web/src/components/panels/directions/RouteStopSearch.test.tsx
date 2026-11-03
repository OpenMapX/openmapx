// @vitest-environment jsdom

import {
  type AlongRoutePoi,
  type CategoryPlace,
  type LngLat,
  MAX_DIRECTIONS_WAYPOINTS,
  type Route,
  type RouteStopDetour,
  useDirectionsStore,
} from "@openmapx/core";
import en from "@openmapx/i18n/locales/en.json";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import type { PlannedRouteSearch } from "@/lib/navigation/usePlannedRouteSearch";

const KM = 1 / 111.32;

const fixture = vi.hoisted(() => ({
  search: undefined as unknown as PlannedRouteSearch,
  queries: [] as unknown[],
  detour: undefined as RouteStopDetour | undefined,
  detourInputs: [] as { candidate: unknown; provider?: string; request: unknown }[],
  retry: vi.fn(),
  flyTo: vi.fn(),
  snapTo: vi.fn(),
}));

vi.mock("@/lib/navigation/usePlannedRouteSearch", () => ({
  usePlannedRouteSearch: (_geometry: unknown, query: unknown) => {
    fixture.queries.push(query);
    return query ? fixture.search : { ...fixture.search, results: [], totalChunks: 0 };
  },
  usePlannedStopDetour: (input: { candidate: unknown; provider?: string; request: unknown }) => {
    fixture.detourInputs.push(input);
    return { detour: input.candidate ? fixture.detour : undefined, isPending: false };
  },
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMapOptional: () => ({ flyTo: fixture.flyTo }),
}));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useBrandSuggest: () => ({ data: { matches: [] } }),
}));
vi.mock("@/components/navigation/RouteSearchResultsLayer", () => ({
  RouteSearchResultsLayer: ({
    results,
    onSelect,
  }: {
    results: AlongRoutePoi<CategoryPlace>[];
    onSelect: (poi: AlongRoutePoi<CategoryPlace>) => void;
  }) => (
    <button type="button" onClick={() => onSelect(results[results.length - 1])}>
      Tap last pin
    </button>
  ),
}));

import { RouteStopSearch } from "./RouteStopSearch";

const geometry: LngLat[] = Array.from({ length: 41 }, (_, i) => [i * KM, 0]);
const route = {
  geometry,
  distance: 40_000,
  duration: 1800,
  legs: [],
  steps: [],
} as unknown as Route;

const poi = (id: string, km: number): AlongRoutePoi<CategoryPlace> => ({
  place: { id, name: `Station ${id}`, coordinates: [km * KM, 0.001] },
  alongMeters: km * 1000,
  deviationMeters: 110,
  detourMeters: 220,
  detourSeconds: 16,
});

const baseSearch = (): PlannedRouteSearch => ({
  results: [poi("a", 12), poi("b", 30)],
  isSearching: false,
  settledChunks: 2,
  totalChunks: 2,
  failedChunks: 0,
  incomplete: false,
  truncated: false,
  capped: false,
  searchedMeters: 40_000,
  retry: fixture.retry,
});

function setWaypoints(coords: LngLat[]) {
  const store = useDirectionsStore.getState();
  store.close();
  store.setWaypoint(0, coords[0], "Home");
  store.setWaypoint(1, coords[coords.length - 1], "Work");
  for (const [i, c] of coords.slice(1, -1).entries()) store.insertWaypoint(i + 1, c, `Stop ${i}`);
}

function view({
  units = "metric" as "metric" | "imperial",
  sheet = false,
  detent = "mid",
}: {
  units?: "metric" | "imperial";
  sheet?: boolean;
  detent?: "peek" | "mid" | "full";
} = {}) {
  const content: ReactNode = (
    <RouteStopSearch
      route={route}
      provider="valhalla"
      request={{ mode: "motorcycle", lang: "en" }}
      units={units}
    />
  );
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {sheet ? (
        <MobileSheetContext.Provider
          value={{
            detent,
            isExpanded: detent === "full",
            inSheet: true,
            snapTo: fixture.snapTo,
          }}
        >
          {content}
        </MobileSheetContext.Provider>
      ) : (
        content
      )}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  fixture.search = baseSearch();
  fixture.queries = [];
  fixture.detour = undefined;
  fixture.detourInputs = [];
  fixture.retry.mockReset();
  fixture.flyTo.mockReset();
  fixture.snapTo.mockReset();
  setWaypoints([
    [0, 0],
    [40 * KM, 0],
  ]);
});

const chip = (name: string) => screen.getByRole("button", { name });

describe("RouteStopSearch", () => {
  it("offers the seven stop kinds and a chain search, none active", () => {
    render(view());
    for (const name of [
      "Fuel",
      "Charging",
      "Restaurants",
      "Cafés",
      "Supermarkets",
      "Parking",
      "Hotels",
      "Chain",
    ]) {
      expect(chip(name)).toHaveAttribute("aria-pressed", "false");
    }
    expect(fixture.queries.at(-1)).toBeNull();
    expect(screen.queryByText("Station a")).toBeNull();
  });

  it("renders each chip icon in the chip's icon slot, so it gets the chip's icon spacing", () => {
    render(view());
    for (const name of ["Fuel", "Charging", "Hotels", "Chain"]) {
      const icon = chip(name).querySelector(".MuiChip-icon");
      expect(icon).not.toBeNull();
      expect(icon?.querySelector("svg")).not.toBeNull();
    }
  });

  it("searches the chosen kind and lists results by distance from the start", () => {
    render(view());
    fireEvent.click(chip("Fuel"));
    expect(fixture.queries.at(-1)).toEqual({ category: "preset:amenity/fuel" });
    expect(chip("Fuel")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 places along the route")).toBeInTheDocument();
    expect(screen.getByText(/12\.0 km from start/)).toBeInTheDocument();
    fireEvent.click(chip("Fuel"));
    expect(fixture.queries.at(-1)).toBeNull();
  });

  it("searches charging stations", () => {
    render(view());
    fireEvent.click(chip("Charging"));
    expect(fixture.queries.at(-1)).toEqual({ category: "ev_charging" });
  });

  it("uses miles for imperial units", () => {
    render(view({ units: "imperial" }));
    fireEvent.click(chip("Fuel"));
    expect(screen.getByText(/7\.5 mi from start/)).toBeInTheDocument();
  });

  it("adds the selected stop to a two-point route and leaves the search", () => {
    render(view());
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByText("Station a"));
    expect(fixture.flyTo).toHaveBeenCalledWith([12 * KM, 0.001], 14);
    expect(fixture.detourInputs.at(-1)).toMatchObject({
      provider: "valhalla",
      request: { mode: "motorcycle", lang: "en" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add stop" }));
    const waypoints = useDirectionsStore.getState().waypoints;
    expect(waypoints.map((wp) => [wp.type, wp.label])).toEqual([
      ["origin", "Home"],
      ["waypoint", "Station a"],
      ["destination", "Work"],
    ]);
    expect(waypoints[1].coords).toEqual([12 * KM, 0.001]);
    expect(fixture.queries.at(-1)).toBeNull();
  });

  it("keeps the user's stop order: a result past their stop goes after it", () => {
    setWaypoints([
      [0, 0],
      [20 * KM, 0],
      [40 * KM, 0],
    ]);
    render(view());
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByText("Station b"));
    fireEvent.click(screen.getByRole("button", { name: "Add stop" }));
    expect(useDirectionsStore.getState().waypoints.map((wp) => wp.label)).toEqual([
      "Home",
      "Stop 0",
      "Station b",
      "Work",
    ]);
  });

  it("prefers a known routing entrance as the stop", () => {
    const entrance: LngLat = [12 * KM, 0.0005];
    fixture.search.results[0].place.routingEntrance = entrance;
    render(view());
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByText("Station a"));
    expect(screen.getByText("Routing to known entrance")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add stop" }));
    expect(useDirectionsStore.getState().waypoints[1].coords).toEqual(entrance);
  });

  it("shows the road detour of the selected stop and disables an unreachable one", () => {
    fixture.detour = {
      id: "a",
      kind: "network",
      seconds: 300,
      meters: 2400,
      provider: "valhalla",
      access: { kind: "coordinate", coordinates: [12 * KM, 0.001] },
      waypoints: [],
    };
    const { rerender } = render(view());
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByText("Station a"));
    const card = screen.getByRole("region", { name: "Station a" });
    expect(within(card).getByText("+5 min by road")).toBeInTheDocument();
    expect(within(card).getByText("+2.4 km")).toBeInTheDocument();
    fixture.detour = { ...fixture.detour, kind: "unreachable" } as RouteStopDetour;
    rerender(view());
    expect(screen.getByText("No route to this stop")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add stop" })).toBeDisabled();
  });

  it("explains why no more stops can be added", () => {
    const coords = Array.from(
      { length: MAX_DIRECTIONS_WAYPOINTS },
      (_, i) => [i * 4 * KM, 0] as LngLat,
    );
    setWaypoints(coords);
    render(view());
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByText("Station a"));
    expect(screen.getByRole("button", { name: "Add stop" })).toBeDisabled();
    expect(
      screen.getByText("This route already has the maximum number of stops."),
    ).toBeInTheDocument();
  });

  it("reports progress, limits and failed parts of the route", () => {
    fixture.search = {
      ...baseSearch(),
      isSearching: true,
      settledChunks: 1,
      totalChunks: 4,
    };
    const { rerender } = render(view());
    fireEvent.click(chip("Hotels"));
    expect(screen.getByText("Searching along the route…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    fixture.search = {
      ...baseSearch(),
      capped: true,
      searchedMeters: 1_000_000,
      truncated: true,
      failedChunks: 1,
    };
    rerender(view());
    expect(
      screen.getByText("Only the first 1,000 km of the route were searched."),
    ).toBeInTheDocument();
    expect(screen.getByText("Busy areas show only a selection of places.")).toBeInTheDocument();
    expect(screen.getByText("Part of the route could not be searched.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fixture.retry).toHaveBeenCalledTimes(1);
  });

  it("does not call a route with no answer an empty one", () => {
    fixture.search = { ...baseSearch(), results: [], failedChunks: 2, settledChunks: 2 };
    render(view());
    fireEvent.click(chip("Parking"));
    expect(screen.getByText("The route could not be searched.")).toBeInTheDocument();
    expect(screen.queryByText("Nothing found along the route")).toBeNull();
    expect(screen.queryByText("Part of the route could not be searched.")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("names its progress bar and keeps result rows to one line of facts", () => {
    fixture.search = { ...baseSearch(), isSearching: true, settledChunks: 1, totalChunks: 2 };
    render(view());
    fireEvent.click(chip("Fuel"));
    expect(
      screen.getByRole("progressbar", { name: "Searching along the route…" }),
    ).toBeInTheDocument();
    expect(screen.getByText("12.0 km from start · ~+1 min")).toBeInTheDocument();
  });

  it("pages long result lists", () => {
    fixture.search = {
      ...baseSearch(),
      results: Array.from({ length: 25 }, (_, i) => poi(`p${i}`, 1 + i)),
    };
    render(view());
    fireEvent.click(chip("Restaurants"));
    expect(screen.queryByText("Station p20")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getByText("Station p24")).toBeInTheDocument();
  });

  it("opens the sheet fully when a pin selects a result on a phone, then shows the card", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const { rerender } = render(view({ sheet: true }));
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByRole("button", { name: "Tap last pin" }));
    expect(fixture.snapTo).toHaveBeenCalledWith("full");
    expect(screen.getByRole("region", { name: "Station b" })).toBeInTheDocument();
    expect(fixture.flyTo).not.toHaveBeenCalled();
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(scrolled).not.toHaveBeenCalled();
    rerender(view({ sheet: true, detent: "full" }));
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(scrolled).toHaveBeenCalledTimes(1);
  });

  it("clears a stale selection when the route changes", () => {
    render(view());
    fireEvent.click(chip("Fuel"));
    fireEvent.click(screen.getByText("Station a"));
    expect(screen.getByRole("region", { name: "Station a" })).toBeInTheDocument();
    act(() => useDirectionsStore.getState().setActiveRouteIndex(1));
    expect(screen.queryByRole("region", { name: "Station a" })).toBeNull();
    expect(chip("Fuel")).toHaveAttribute("aria-pressed", "true");
  });
});
