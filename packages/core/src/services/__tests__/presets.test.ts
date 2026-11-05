import { expect, it } from "vitest";
import { expandPresets, PRESETS, UnknownPresetError } from "../presets";

it("preserves CLI preset order and leaves root deduplication to selection", () => {
  expect(Object.keys(PRESETS)).toEqual([
    "app",
    "proxy",
    "routing",
    "transit",
    "pelias",
    "nominatim",
    "photon",
    "overpass",
    "tiles",
    "martin",
    "dev",
  ]);
  expect(expandPresets(["routing, transit", "dev routing"])).toEqual([
    "osrm",
    "valhalla",
    "motis",
    "motis-feed-proxy",
    "otp",
    "postgis",
    "redis",
    "osrm",
    "valhalla",
  ]);
  for (const id of ["unknown", "__proto__", "constructor"])
    expect(() => expandPresets([id])).toThrow(UnknownPresetError);
});
