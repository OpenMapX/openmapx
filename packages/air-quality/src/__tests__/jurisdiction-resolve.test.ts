import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import metadata from "../data/jurisdiction/metadata.json";
import { JURISDICTION_PROGRAMS } from "../jurisdiction/registry";
import { resolveJurisdiction } from "../jurisdiction/resolve";

const at = "2026-08-30T12:00:00Z";

const countryFixtures = [
  ["AL", 41.3275, 19.8187, "eea-european-aqi"],
  ["AT", 48.2082, 16.3738, "eea-european-aqi"],
  ["BA", 43.8563, 18.4131, "eea-european-aqi"],
  ["BE", 50.8503, 4.3517, "eea-european-aqi"],
  ["BG", 42.6977, 23.3219, "eea-european-aqi"],
  ["CA", 43.6532, -79.3832, "ca-aqhi"],
  ["CH", 46.948, 7.4474, "eea-european-aqi"],
  ["CN", 39.9042, 116.4074, "cn-hj633"],
  ["CY", 34.6786, 33.0413, "eea-european-aqi"],
  ["CZ", 50.0755, 14.4378, "eea-european-aqi"],
  ["DE", 52.52, 13.405, "eea-european-aqi"],
  ["DK", 56.1629, 10.2039, "eea-european-aqi"],
  ["EE", 59.437, 24.7536, "eea-european-aqi"],
  ["ES", 40.4168, -3.7038, "eea-european-aqi"],
  ["FI", 60.1699, 24.9384, "eea-european-aqi"],
  ["FR", 48.8566, 2.3522, "eea-european-aqi"],
  ["GB", 51.5074, -0.1278, "uk-daqi"],
  ["GR", 37.9838, 23.7275, "eea-european-aqi"],
  ["HR", 45.815, 15.9819, "eea-european-aqi"],
  ["HU", 47.4979, 19.0402, "eea-european-aqi"],
  ["IE", 53.3498, -6.2603, "eea-european-aqi"],
  ["IN", 28.6139, 77.209, "in-naqi"],
  ["IS", 64.1466, -21.9426, "eea-european-aqi"],
  ["IT", 41.9028, 12.4964, "eea-european-aqi"],
  ["LI", 47.141, 9.5209, "eea-european-aqi"],
  ["LT", 54.6872, 25.2797, "eea-european-aqi"],
  ["LU", 49.6116, 6.1319, "eea-european-aqi"],
  ["LV", 56.9496, 24.1052, "eea-european-aqi"],
  ["ME", 42.4304, 19.2594, "eea-european-aqi"],
  ["MK", 41.9973, 21.428, "eea-european-aqi"],
  ["MT", 35.8989, 14.5146, "eea-european-aqi"],
  ["NL", 52.3676, 4.9041, "eea-european-aqi"],
  ["NO", 59.9139, 10.7522, "eea-european-aqi"],
  ["PL", 52.2297, 21.0122, "eea-european-aqi"],
  ["PT", 38.7223, -9.1393, "eea-european-aqi"],
  ["RO", 44.4268, 26.1025, "eea-european-aqi"],
  ["RS", 44.7866, 20.4489, "eea-european-aqi"],
  ["SE", 59.3293, 18.0686, "eea-european-aqi"],
  ["SI", 46.0569, 14.5058, "eea-european-aqi"],
  ["SK", 48.1486, 17.1077, "eea-european-aqi"],
  ["TR", 39.9334, 32.8597, "eea-european-aqi"],
  ["US", 38.9072, -77.0369, "us-epa-aqi"],
] as const;

describe("jurisdiction resolution", () => {
  it.each(countryFixtures)(
    "resolves %s from the pinned boundary artifact",
    (countryCode, latitude, longitude, programId) => {
      expect(resolveJurisdiction({ latitude, longitude, at })).toMatchObject({
        countryCode,
        programId,
        resolution: "boundary-artifact",
        requestHintMatched: null,
      });
    },
  );

  it("keeps the supported-country fixture matrix in lockstep with the program registry", () => {
    const expected = [
      ...new Set(JURISDICTION_PROGRAMS.map(({ countryCode }) => countryCode)),
    ].sort();
    expect([...countryFixtures.map(([countryCode]) => countryCode), "XK"].sort()).toEqual(expected);
  });

  it.each([
    ["CA-AB", 53.5461, -113.4938, "ca-aqhi"],
    ["CA-BC", 48.4284, -123.3656, "ca-aqhi"],
    ["CA-MB", 49.8951, -97.1384, "ca-aqhi"],
    ["CA-NB", 45.9636, -66.6431, "ca-aqhi"],
    ["CA-NL", 47.5615, -52.7126, "ca-aqhi"],
    ["CA-NS", 45.3658, -63.2869, "ca-aqhi"],
    ["CA-NT", 62.454, -114.3718, "ca-aqhi"],
    ["CA-NU", 63.7467, -68.517, "ca-aqhi"],
    ["CA-ON", 43.6532, -79.3832, "ca-aqhi"],
    ["CA-PE", 46.4373, -63.638, "ca-aqhi"],
    ["CA-QC", 45.4765, -75.7013, "ca-qc-info-smog"],
    ["CA-SK", 50.4452, -104.6189, "ca-aqhi"],
    ["CA-YT", 60.7212, -135.0568, "ca-aqhi"],
  ] as const)(
    "resolves Canadian subdivision %s",
    (subdivisionCode, latitude, longitude, programId) => {
      expect(resolveJurisdiction({ latitude, longitude, at })).toMatchObject({
        countryCode: "CA",
        subdivisionCode,
        programId,
      });
    },
  );

  it.each([
    ["Hawaii", 21.3069, -157.8583, "US"],
    ["Puerto Rico", 18.4655, -66.1057, "US"],
    ["French Guiana", 4.9224, -52.3135, "FR"],
    ["Réunion", -20.8789, 55.4481, "FR"],
    ["Azores", 36.94, -25.05, "PT"],
    ["Canary Islands", 28.1235, -15.4363, "ES"],
    ["Svalbard", 78.2, 16, "NO"],
  ] as const)(
    "covers supported islands and overseas area %s",
    (_name, latitude, longitude, countryCode) => {
      expect(resolveJurisdiction({ latitude, longitude, at })).toMatchObject({
        countryCode,
        resolution: "boundary-artifact",
      });
    },
  );

  it("returns ambiguous for an exact international boundary", () => {
    expect(
      resolveJurisdiction({ latitude: 47.584618544000065, longitude: 7.5860284880001245, at }),
    ).toMatchObject({
      countryCode: null,
      programId: null,
      resolution: "ambiguous",
    });
  });

  it.each([
    ["Kashmir", 34.056196, 77.286367],
    ["Kosovo", 42.6629, 21.1655],
  ])("does not silently pick a point of view in %s", (_name, latitude, longitude) => {
    expect(resolveJurisdiction({ latitude, longitude, at })).toMatchObject({
      resolution: "ambiguous",
      programId: null,
    });
  });

  it("returns unresolved for the ocean", () => {
    expect(resolveJurisdiction({ latitude: 0, longitude: -140, at })).toMatchObject({
      resolution: "unresolved",
      countryCode: null,
    });
  });

  it("treats caller hints as assertions, including independently supplied subdivision hints", () => {
    expect(
      resolveJurisdiction({ latitude: 43.6532, longitude: -79.3832, at, countryHint: "US" }),
    ).toMatchObject({ requestHintMatched: false, programId: null });
    expect(
      resolveJurisdiction({
        latitude: 43.6532,
        longitude: -79.3832,
        at,
        countryHint: "ca",
        subdivisionHint: "ca-on",
      }),
    ).toMatchObject({ requestHintMatched: true, programId: "ca-aqhi" });
    expect(
      resolveJurisdiction({ latitude: 43.6532, longitude: -79.3832, at, subdivisionHint: "ca-on" }),
    ).toMatchObject({ requestHintMatched: true, programId: "ca-aqhi" });
  });

  it("pins the checked-in artifact to its recorded digest", () => {
    const bytes = readFileSync(new URL("../data/jurisdiction/supported.geojson", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(metadata.artifactSha256);
    expect(metadata.featureCounts).toEqual({ country: 49, subdivision: 13, ambiguous: 38 });
  });
});
