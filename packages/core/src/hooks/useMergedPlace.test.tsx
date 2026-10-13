import type { Place } from "@openmapx/core";
import { contributorsForField } from "@openmapx/mobility-core/contributors";
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  nom: null as Place | null,
  reverse: null as import("../types/geocoding").ReverseGeocodingResult | null,
  matched: null as import("../types/dataSource").DataSourceDetail | null,
}));
vi.mock("./usePlaceDetails", () => ({
  usePlaceDetails: () => ({ data: state.nom, isLoading: false }),
}));
vi.mock("./useReverseGeocoding", () => ({ useReverseGeocoding: () => ({ data: state.reverse }) }));
vi.mock("./useDataSourceMatch", () => ({ useDataSourceMatch: () => state.matched }));
vi.mock("./useOpeningHoursClock", () => ({ useOpeningHoursClock: () => Date.now() }));
const { useMergedPlace } = await import("./useMergedPlace");
it("keeps selected phone owner when resolved detail has no phone", () => {
  const a = { sourceId: "selected", name: "Selected phone supplier" },
    b = { sourceId: "resolved", name: "Resolved detail supplier" };
  state.nom = {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Name",
    coordinates: [6, 51],
    address: "Address",
    fieldContributors: { name: [b], coordinates: [b], phone: [] },
    contributors: [b],
  } as Place;
  const selected = {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1" },
    name: "Name",
    coordinates: [6, 51],
    address: "",
    phone: "+49 123",
    fieldContributors: { phone: [a] },
    contributors: [a],
  } as Place;
  const { result } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.phone).toBe("+49 123");
  expect(contributorsForField(result.current.place ?? {}, "phone")).toEqual([a]);
});

it("preserves each retained identity and nested winner independently", () => {
  const a = { sourceId: "selected", name: "Selected" },
    b = { sourceId: "resolved", name: "Resolved" };
  const selected = {
    id: "osm:node/1",
    primaryScheme: "osm",
    ids: { osm: "node/1", wikidata: "Q1" },
    name: "Selected name",
    coordinates: [6, 51],
    address: "",
    rawCategory: "cafe",
    dataSourceDetail: { id: "d", name: "D", sources: [], sections: [], coordinates: [6, 51] },
    fieldContributors: {
      name: [a],
      rawCategory: [a],
      "ids.wikidata": [a],
      "ids.osm": [],
      dataSourceDetail: [],
    },
  } as Place;
  state.nom = {
    ...selected,
    ids: { osm: "node/1", wikipedia: "en:Place" },
    name: "Resolved name",
    phone: "Discarded",
    brand: { name: "Brand", wikidata: "Q2" },
    fieldContributors: {
      name: [b],
      phone: [b],
      "ids.wikipedia": [b],
      "brand.name": [b],
      "brand.wikidata": [],
    },
  } as Place;
  const { result } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.name).toBe("Selected name");
  expect(contributorsForField(result.current.place ?? {}, "name")).toEqual([a]);
  expect(contributorsForField(result.current.place ?? {}, "ids.wikidata")).toEqual([a]);
  expect(contributorsForField(result.current.place ?? {}, "ids.wikipedia")).toEqual([b]);
  expect(contributorsForField(result.current.place ?? {}, "ids.osm")).toEqual([]);
  expect(contributorsForField(result.current.place ?? {}, "brand.name")).toEqual([b]);
  expect(contributorsForField(result.current.place ?? {}, "brand.wikidata")).toEqual([]);
  a.name = "Mutated";
  b.name = "Mutated";
  expect(contributorsForField(result.current.place ?? {}, "ids.wikidata")[0].name).toBe("Selected");
});

it("uses captured reverse address and matched schedule ownership with neutral computed hours", () => {
  const a = { sourceId: "reverse", name: "Reverse" },
    b = { sourceId: "hours", name: "Matched hours" };
  state.nom = null;
  state.reverse = { address: "Reverse address", city: "Town, Country", contributors: [a] };
  state.matched = {
    id: "detail",
    name: "Detail",
    coordinates: [6, 51],
    sources: [],
    sections: [],
    openingHours: "24/7",
    contributors: [b],
    fieldContributors: { openingHours: [b], name: [] },
  };
  const selected = {
    id: "coordinate:6,51",
    primaryScheme: "coordinate",
    ids: {},
    name: "Point",
    coordinates: [6, 51],
    address: "",
    fieldContributors: { address: [], openingHours: [] },
  } as Place;
  const { result } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.address).toBe("Reverse address");
  expect(contributorsForField(result.current.place ?? {}, "address")).toEqual([a]);
  expect(contributorsForField(result.current.place ?? {}, "openingHours")).toEqual([b]);
  expect(contributorsForField(result.current.place ?? {}, "dataSourceDetail.name")).toEqual([]);
  expect(result.current.place?.openingHoursInfo?.status?.isUnknown).toBe(true);
  state.reverse = null;
  state.matched = null;
});
