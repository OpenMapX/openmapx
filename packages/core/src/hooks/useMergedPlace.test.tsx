import type { Place } from "@openmapx/core";
import { contributorsForField } from "@openmapx/mobility-core/contributors";
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  captureSavedPlaceContributors,
  savedPlaceContributorsForPlace,
} from "../saved-place-contributors";

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

it("shows a matched data source's hours with the verdict its route evaluated", () => {
  const b = { sourceId: "hours", name: "Matched hours" };
  const openingHoursInfo = {
    validUntil: new Date(Date.now() + 60_000).toISOString(),
    status: { isOpen: true },
    isAlwaysOpen: true,
    weekBitmap: "",
  };
  state.nom = null;
  state.reverse = null;
  state.matched = {
    id: "detail",
    name: "Detail",
    coordinates: [6, 51],
    sources: [],
    sections: [],
    openingHours: "24/7",
    openingHoursInfo,
    contributors: [b],
    fieldContributors: { openingHours: [b], openingHoursInfo: [b], name: [] },
  };
  const selected = {
    id: "coordinate:6,51",
    primaryScheme: "coordinate",
    ids: {},
    name: "Point",
    coordinates: [6, 51],
    address: "",
  } as Place;
  const { result } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.openingHoursInfo).toBe(openingHoursInfo);
  expect(contributorsForField(result.current.place ?? {}, "openingHoursInfo")).toEqual([b]);
  state.matched = null;
});

it("preserves an unknown saved coordinate axis through the real panel merge and resave", () => {
  state.nom = null;
  state.reverse = null;
  state.matched = null;
  const latitude = { sourceId: "latitude", name: "Captured latitude supplier" };
  const saved = { lat: [latitude] };
  const selected: Place = {
    id: "saved:partial",
    primaryScheme: "saved",
    ids: { saved: "partial" },
    name: "Saved point",
    address: "",
    coordinates: [8, 50],
    ...savedPlaceContributorsForPlace(saved),
  };
  const { result, unmount } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.fieldContributors).not.toHaveProperty("coordinates");
  expect(result.current.place?.fieldContributors?.["coordinates.1"]).toEqual([latitude]);
  expect(captureSavedPlaceContributors(result.current.place ?? {})).toEqual(saved);
  unmount();
});

it("keeps canonical parent ownership and authoritative child overrides through panel merge", () => {
  state.nom = null;
  state.reverse = null;
  state.matched = null;
  const parent = { sourceId: "parent", name: "Captured point supplier" };
  const selected: Place = {
    id: "saved:parent",
    primaryScheme: "saved",
    ids: { saved: "parent" },
    name: "Saved point",
    address: "",
    coordinates: [8, 50],
    fieldContributors: { name: [], address: [], coordinates: [parent], "coordinates.0": [] },
  };
  const { result, unmount } = renderHook(() => useMergedPlace(selected));
  expect(captureSavedPlaceContributors(result.current.place ?? {})).toEqual({
    name: [],
    address: [],
    lat: [parent],
    lng: [],
  });
  unmount();
});

it("keeps entirely unknown saved coordinate ownership absent through panel merge", () => {
  state.nom = null;
  state.reverse = null;
  state.matched = null;
  const selected: Place = {
    id: "saved:unknown",
    primaryScheme: "saved",
    ids: { saved: "unknown" },
    name: "Saved point",
    address: "",
    coordinates: [8, 50],
  };
  const { result, unmount } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.fieldContributors).not.toHaveProperty("coordinates");
  const captured = captureSavedPlaceContributors(result.current.place ?? {});
  expect(captured).not.toHaveProperty("lat");
  expect(captured).not.toHaveProperty("lng");
  expect(captured).toEqual({});
  unmount();
});

it("retains nearest canonical identity ancestors and explicit empty overrides in transfer", () => {
  state.nom = null;
  state.reverse = null;
  state.matched = null;
  const identity = { sourceId: "identity", name: "Identity supplier" };
  const selected: Place = {
    id: "osm:node/9",
    primaryScheme: "osm",
    ids: { osm: "node/9", wikidata: "Q9" },
    name: "Point",
    address: "",
    coordinates: [8, 50],
    fieldContributors: { ids: [identity], "ids.wikidata": [], name: [], address: [] },
  };
  const { result, unmount } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.fieldContributors?.["ids.osm"]).toEqual([identity]);
  expect(result.current.place?.fieldContributors?.["ids.wikidata"]).toEqual([]);
  expect(captureSavedPlaceContributors(result.current.place ?? {})).toEqual({
    name: [],
    address: [],
  });
  unmount();
});

it.each([{ empty: false }, { empty: true }])(
  "retains record-level captured contributors when no field map exists: %j",
  ({ empty }) => {
    state.nom = null;
    state.reverse = null;
    state.matched = null;
    const receipt = { sourceId: "record", name: "Record supplier" };
    const contributors = empty ? [] : [receipt];
    const selected: Place = {
      id: "saved:record",
      primaryScheme: "saved",
      ids: { saved: "record" },
      name: "Point",
      address: "",
      coordinates: [8, 50],
      contributors,
    };
    const { result, unmount } = renderHook(() => useMergedPlace(selected));
    expect(captureSavedPlaceContributors(result.current.place ?? {})).toEqual({
      name: contributors,
      address: contributors,
      lat: contributors,
      lng: contributors,
    });
    unmount();
  },
);
it("keeps the transit stop a place was opened for when OSM details arrive", () => {
  state.nom = {
    id: "osm:node/2",
    primaryScheme: "osm",
    ids: { osm: "node/2" },
    name: "Bf Deutz/Messe / LANXESS arena",
    coordinates: [6.98, 50.94],
    address: "",
  } as Place;
  const selected = {
    id: "osm:node/2",
    primaryScheme: "osm",
    ids: { osm: "node/2", mo: "de:05315:11907:4:13" },
    name: "Bf Deutz/Messe / LANXESS arena, Deutz, Cologne, Germany",
    coordinates: [6.98, 50.94],
    address: "",
    rawCategory: "transit_stop",
    transitStop: { id: "mo:de:05315:11907:4:13", name: "Köln Bf Deutz/Messe LANXESS arena" },
  } as Place;
  const { result } = renderHook(() => useMergedPlace(selected));
  expect(result.current.place?.name).toBe("Bf Deutz/Messe / LANXESS arena");
  expect(result.current.place?.transitStop).toEqual(selected.transitStop);
});
