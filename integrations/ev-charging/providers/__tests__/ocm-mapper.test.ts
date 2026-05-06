import { describe, expect, it } from "vitest";
import { mapOcmToDetail, mapOcmToResult } from "../ocm-mapper.js";
import type { OcmPoi } from "../ocm-types.js";

function makePoi(overrides: Partial<OcmPoi> = {}): OcmPoi {
  return {
    ID: 123,
    AddressInfo: {
      ID: 1,
      Title: "Test Charger",
      Latitude: 48.137,
      Longitude: 11.575,
    },
    ...overrides,
  };
}

describe("mapOcmToDetail", () => {
  const importedProviderPoi = makePoi({
    DataProvider: {
      ID: 28,
      Title: "data.gouv.fr",
      WebsiteURL:
        "https://www.data.gouv.fr/datasets/base-nationale-des-irve-infrastructures-de-recharge-pour-vehicules-electriques",
      IsOpenDataLicensed: true,
      License: "Licence Ouverte / Open Licence",
    },
  });

  it("adds per-record attribution for imported OpenChargeMap data providers", () => {
    const detail = mapOcmToDetail(importedProviderPoi);

    expect(detail.sources).toEqual(["ocm"]);
    expect(detail.attributions).toEqual([
      {
        text: "data.gouv.fr",
        url: "https://www.data.gouv.fr/datasets/base-nationale-des-irve-infrastructures-de-recharge-pour-vehicules-electriques",
        license: "Licence Ouverte / Open Licence",
        licenseUrl: "https://openchargemap.org/about",
      },
    ]);
  });

  it("carries imported provider attribution into search results for map attribution", () => {
    const result = mapOcmToResult(importedProviderPoi);

    expect(result.attributions?.[0]?.text).toBe("data.gouv.fr");
  });

  it("does not duplicate the static OpenChargeMap attribution for OCM-contributed data", () => {
    const detail = mapOcmToDetail(
      makePoi({
        DataProvider: {
          ID: 1,
          Title: "Open Charge Map Contributors",
          WebsiteURL: "https://openchargemap.org",
          IsOpenDataLicensed: true,
          License: "CC BY 4.0",
        },
      }),
    );

    expect(detail.attributions).toBeUndefined();
  });
});
