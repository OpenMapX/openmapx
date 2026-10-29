import { expect, it } from "vitest";
import type { ClientEnv } from "@/integration-api/runtime/env";
import { captureNativeBasemapRequest } from "./nativeBasemapAcquisition";

const style = {
  version: 8,
  sources: { openmaptiles: { type: "vector" }, dem: { type: "raster-dem" } },
  layers: [],
};
it("captures before await and binds hosted style supplier despite unused local tile configuration", () => {
  const env = {
    styleProvider: "maptiler",
    basemapProvider: "maptiler",
    tilesUrl: "https://unused.local",
  } as ClientEnv;
  const request = captureNativeBasemapRequest(env);
  env.styleProvider = "openmapx";
  const candidate = request.bind(style, false);
  expect(candidate.sourceContributors.openmaptiles.map((r) => r.sourceId)).toEqual([
    "openstreetmap",
    "maptiler",
  ]);
  expect(candidate.sourceContributors.dem).toBeUndefined();
  expect(candidate.styleContributors.map((r) => r.sourceId)).toEqual(["openmaptiles", "maptiler"]);
});
it("selected offline source omits unused online service but preserves acquired style design", () => {
  const request = captureNativeBasemapRequest({
    styleProvider: "openmapx",
    basemapProvider: "maptiler",
    tilesUrl: "",
  } as ClientEnv);
  expect(request.bind(style, true).sourceContributors.openmaptiles.map((r) => r.sourceId)).toEqual([
    "openstreetmap",
  ]);
  expect(request.bind(style, true).styleContributors.map((r) => r.sourceId)).toEqual([
    "openmaptiles",
  ]);
});
