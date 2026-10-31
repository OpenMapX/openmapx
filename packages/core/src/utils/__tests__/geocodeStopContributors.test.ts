import type { TransitStop } from "@openmapx/mobility-core/transit";
import { afterEach, expect, it, vi } from "vitest";
import { apiClient } from "../../api/client";
import { makeSyntheticStopPlace, resolveStopAsPlace } from "../geocodeStopAsPlace";

const a = { sourceId: "a", name: "Stop feed A" };
const b = { sourceId: "b", name: "Geocoder B" };
const stop: TransitStop = {
  id: "ms:stop",
  provider: "ms",
  name: "Central",
  lat: 50,
  lng: 8,
  modes: ["rail"],
  contributors: [a],
};
afterEach(() => vi.restoreAllMocks());
it("preserves stop data receipts on synthetic coordinates/name and identity", () => {
  const place = makeSyntheticStopPlace(stop);
  expect(place.contributors).toEqual([a]);
  expect(place.fieldContributors?.coordinates).toEqual([a]);
  expect(place.fieldContributors?.name).toEqual([a]);
  expect(place.fieldContributors?.ids).toEqual([a]);
});
it("keeps matched geocoder fields separate from retained stop IDs", async () => {
  vi.spyOn(apiClient, "get").mockResolvedValue([
    { id: "osm:node/1", label: "Central", coordinates: [8, 50], type: "poi", contributors: [b] },
  ]);
  const place = await resolveStopAsPlace(stop);
  expect(place.ids).toMatchObject({ ms: "stop", osm: "node/1" });
  expect(place.contributors).toEqual([a, b]);
  expect(place.fieldContributors?.coordinates).toEqual([b]);
  expect(place.fieldContributors?.name).toEqual([b]);
  expect(place.fieldContributors?.ids).toEqual([a, b]);
});

it("remembers the stop a place was opened for, also when the geocoder names it differently", async () => {
  expect(makeSyntheticStopPlace(stop).transitStop).toEqual({ id: "ms:stop", name: "Central" });
  vi.spyOn(apiClient, "get").mockResolvedValue([
    { id: "osm:node/1", label: "Central Station", coordinates: [8, 50], type: "poi" },
  ]);
  const place = await resolveStopAsPlace(stop);
  expect(place.name).toBe("Central Station");
  expect(place.transitStop).toEqual({ id: "ms:stop", name: "Central" });
});
