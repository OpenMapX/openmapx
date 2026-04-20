import { afterEach, describe, expect, it } from "vitest";
import {
  OPENMAPX_REGION_ENV,
  resolveBuildRegion,
  resolveOsmRegion,
  resolveOverpassRegion,
  resolveTransitousCountries,
  TRANSITOUS_COUNTRIES_ENV,
} from "../src/lib/env-defaults";

afterEach(() => {
  delete process.env.OPENMAPX_REGION;
  delete process.env.MOTIS_REGION;
  delete process.env.OSRM_REGION;
  delete process.env.OVERPASS_REGION;
  delete process.env.TRANSITOUS_COUNTRIES;
});

describe("env defaults", () => {
  it("falls back to the shared OPENMAPX_REGION when no service-specific region is set", () => {
    process.env.OPENMAPX_REGION = "europe/germany";

    expect(resolveBuildRegion("osrm", undefined)).toEqual({
      value: "europe/germany",
      sourceEnv: OPENMAPX_REGION_ENV,
    });
    expect(resolveOsmRegion(undefined)).toEqual({
      value: "europe/germany",
      sourceEnv: OPENMAPX_REGION_ENV,
    });
  });

  it("prefers the service-specific env over the shared region default", () => {
    process.env.OPENMAPX_REGION = "planet";
    process.env.OSRM_REGION = "europe/france";

    expect(resolveBuildRegion("osrm", undefined)).toEqual({
      value: "europe/france",
      sourceEnv: "OSRM_REGION",
    });
  });

  it("prefers OVERPASS_REGION over OPENMAPX_REGION for overpass conversion", () => {
    process.env.OPENMAPX_REGION = "planet";
    process.env.OVERPASS_REGION = "europe/switzerland";

    expect(resolveOverpassRegion(undefined)).toEqual({
      value: "europe/switzerland",
      sourceEnv: "OVERPASS_REGION",
    });
  });

  it("resolves Transitous countries from env when the CLI option is absent", () => {
    process.env.TRANSITOUS_COUNTRIES = "de, at ,ch";

    expect(resolveTransitousCountries(undefined)).toEqual({
      values: ["de", "at", "ch"],
      sourceEnv: TRANSITOUS_COUNTRIES_ENV,
    });
  });

  it("prefers the explicit countries option over env defaults", () => {
    process.env.TRANSITOUS_COUNTRIES = "de,at";

    expect(resolveTransitousCountries("fr,be")).toEqual({
      values: ["fr", "be"],
    });
  });
});
