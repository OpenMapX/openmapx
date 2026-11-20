import type { AutocompleteResult, BrandSummary, LabeledPlace, SearchResult } from "@openmapx/core";
import type { TransitStop } from "@openmapx/mobility-core/transit";
import { describe, expect, it } from "vitest";
import {
  resolveGeocodeAction,
  resolveLabeledPlaceAction,
  resolveSearchAction,
  type SearchAction,
  type SearchActionContext,
} from "./searchAction";

const context: SearchActionContext = {
  query: "typed text",
  stopSearch: false,
  recordHistory: true,
  dataSourceCategoryIds: ["parking"],
};
const HAMBURG: [number, number] = [10.0067, 53.5526];
const stop: TransitStop = {
  id: "db:8000002",
  name: "Hamburg Hbf",
  lat: HAMBURG[1],
  lng: HAMBURG[0],
  modes: ["rail"],
  provider: "transit-db-vendo",
};
const brand = { qid: "Q37158", name: "Starbucks", kind: ["brand"] } as unknown as BrandSummary;

/** The action without the built place, plus the place's visible fields. */
function summary(action: SearchAction) {
  if (action.kind !== "select" || action.target.kind !== "place") return action;
  const { place, ...target } = action.target;
  return {
    ...action,
    target: {
      ...target,
      place: {
        name: place.name,
        address: place.address,
        coordinates: place.coordinates,
        category: place.category,
      },
    },
  };
}

describe("resolveSearchAction", () => {
  it.each<[string, AutocompleteResult, unknown]>([
    [
      "recent_search",
      { id: "recent-1", label: "cafes", type: "recent_search" },
      { kind: "run-recent", text: "cafes" },
    ],
    [
      "text_search",
      { id: "text-search", label: "Search typed text", type: "text_search" },
      { kind: "search-area", text: "typed text" },
    ],
    [
      "labeled_place",
      {
        id: "labeled-1",
        label: "Home",
        sublabel: "Flat — Hauptstraße 1",
        type: "labeled_place",
        coordinates: HAMBURG,
      },
      {
        kind: "select",
        query: "Home",
        target: {
          kind: "place",
          flyTo: HAMBURG,
          place: { name: "Flat", address: "Hauptstraße 1", coordinates: HAMBURG },
        },
      },
    ],
    [
      "transit_stop",
      {
        id: "stop-1",
        label: "Hamburg Hbf",
        type: "transit_stop",
        coordinates: HAMBURG,
        transitStop: stop,
      },
      { kind: "select", query: "Hamburg Hbf", target: { kind: "stop", stop, flyTo: HAMBURG } },
    ],
    [
      "brand",
      { id: "brand-Q37158", label: "Starbucks", type: "brand", brand },
      { kind: "select", query: "Starbucks", target: { kind: "brand", brand } },
    ],
    [
      "POI category",
      { id: "category-restaurants", label: "Restaurants", type: "category" },
      {
        kind: "select",
        query: "Restaurants",
        target: { kind: "category", categoryId: "restaurants" },
      },
    ],
    [
      "data-source category",
      { id: "category-parking", label: "Parking", type: "category" },
      { kind: "select", query: "Parking", target: { kind: "data-source", sourceId: "parking" } },
    ],
    [
      "plain coordinates",
      { id: "coordinate:1", label: "53.55, 10.00", type: "address", coordinates: HAMBURG },
      {
        kind: "select",
        query: "53.55, 10.00",
        target: {
          kind: "place",
          flyTo: HAMBURG,
          place: {
            name: "53.55, 10.00",
            address: "53.55, 10.00",
            coordinates: HAMBURG,
            category: "address",
          },
        },
      },
    ],
    [
      "region",
      { id: "osm:relation/62782", label: "Hamburg", type: "region", coordinates: HAMBURG },
      {
        kind: "select",
        query: "Hamburg",
        target: {
          kind: "place",
          place: { name: "Hamburg", address: "Hamburg", coordinates: HAMBURG, category: "region" },
        },
      },
    ],
    [
      "row without a position",
      { id: "nearby-freetext", label: "Search near here", type: "poi" },
      { kind: "select", query: "Search near here", target: { kind: "none" } },
    ],
  ])("resolves a %s row", (_, row, expected) => {
    const action = summary(resolveSearchAction(row, { ...context, recordHistory: false }));
    expect(action).toEqual(expected);
  });

  it("records the row and its destination in the history when asked", () => {
    const row: AutocompleteResult = {
      id: "osm:node/1",
      label: "Elbphilharmonie",
      type: "poi",
      coordinates: HAMBURG,
    };
    const action = resolveSearchAction(row, context);
    expect(action.kind === "select" && action.history).toEqual({
      search: "Elbphilharmonie",
      destination: { id: "osm:node/1", label: "Elbphilharmonie", coordinates: HAMBURG },
    });
  });

  it("looks up the stop of a place the geocoder classed as transit", () => {
    const row: AutocompleteResult = {
      id: "osm:node/2",
      label: "Hamburg Dammtor",
      type: "poi",
      coordinates: HAMBURG,
      rawCategory: "railway=station",
    };
    const action = resolveSearchAction(row, context);
    expect(
      action.kind === "select" && action.target.kind === "place" && action.target.transitLookup,
    ).toEqual({ coordinates: HAMBURG, name: "Hamburg Dammtor" });
  });

  it("picks a positioned row as a directions stop, and nothing for one without a position", () => {
    const stopSearch = { ...context, stopSearch: true };
    expect(
      resolveSearchAction(
        { id: "a", label: "Hamburg Hbf", type: "poi", coordinates: HAMBURG },
        stopSearch,
      ),
    ).toEqual({ kind: "pick-stop", coordinates: HAMBURG, label: "Hamburg Hbf" });
    expect(resolveSearchAction({ id: "b", label: "Cafes", type: "category" }, stopSearch)).toEqual({
      kind: "none",
    });
    expect(
      resolveSearchAction({ id: "c", label: "cafes", type: "recent_search" }, stopSearch),
    ).toEqual({ kind: "run-recent", text: "cafes" });
  });
});

describe("resolveGeocodeAction", () => {
  const result: SearchResult = {
    id: "osm:node/3",
    label: "Hamburg Hbf",
    address: "Hachmannplatz 16, Hamburg",
    type: "poi",
    coordinates: HAMBURG,
  } as SearchResult;

  it("opens the confident match without changing the typed text", () => {
    expect(summary(resolveGeocodeAction(result, "Hachmannplatz 16", false))).toEqual({
      kind: "select",
      query: null,
      target: {
        kind: "place",
        flyTo: HAMBURG,
        place: {
          name: "Hachmannplatz 16",
          address: "Hachmannplatz 16, Hamburg",
          coordinates: HAMBURG,
          category: "poi",
        },
      },
    });
  });

  it("looks up a transit match's stop", () => {
    const action = resolveGeocodeAction(result, undefined, true);
    expect(
      action.kind === "select" && action.target.kind === "place" && action.target.transitLookup,
    ).toEqual({ coordinates: HAMBURG, name: "Hamburg Hbf" });
  });
});

describe("resolveLabeledPlaceAction", () => {
  const home = {
    id: "lp-1",
    label: "home",
    name: "Flat",
    address: "Hauptstraße 1",
    lat: HAMBURG[1],
    lng: HAMBURG[0],
  } as LabeledPlace;

  it("opens the saved place, or picks it as a directions stop", () => {
    expect(summary(resolveLabeledPlaceAction(home, false))).toEqual({
      kind: "select",
      query: "home",
      target: {
        kind: "place",
        flyTo: HAMBURG,
        place: { name: "Flat", address: "Hauptstraße 1", coordinates: HAMBURG },
      },
    });
    expect(resolveLabeledPlaceAction(home, true)).toEqual({
      kind: "pick-stop",
      coordinates: HAMBURG,
      label: "Flat",
    });
  });
});
