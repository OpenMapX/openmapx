import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "./mapAttributionStore";
import {
  useIntegrationSourceAttributions,
  useSourceAttributions,
} from "./useIntegrationAttribution";

vi.mock("@openmapx/integration-framework/react", () => {
  const dataSources = [
    {
      sourceId: "firms",
      name: "NASA FIRMS",
      url: "https://firms.modaps.eosdis.nasa.gov/",
      license: "U.S. Public Domain",
      providerCountry: "US",
      providerPrivacyUrl: "https://www.nasa.gov/privacy/",
    },
    {
      sourceId: "nifc-wfigs",
      name: "NIFC WFIGS Current Interagency Fire Perimeters",
      url: "https://example.test/nifc",
      license: "U.S. Government data",
      providerCountry: "US",
      providerPrivacyUrl: "https://example.test/privacy",
    },
    {
      sourceId: "noaa-hms",
      name: "NOAA Hazard Mapping System Smoke Detection",
      url: "https://www.ospo.noaa.gov/products/land/hms.html",
      license: "U.S. Public Domain",
      attribution: "NOAA / NESDIS HMS Smoke Detection",
      providerCountry: "US",
      providerPrivacyUrl: "https://www.noaa.gov/privacy/",
    },
  ];
  return {
    useIntegrationRegistry: () => ({
      get: () => ({ dataSources }),
      findDataSource: (sourceId: string) =>
        dataSources.find((source) => source.sourceId === sourceId),
    }),
  };
});

describe("useIntegrationSourceAttributions", () => {
  beforeEach(() => {
    useMapAttributionStore.setState({ byLayer: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("does not register NOAA when the enabled source IDs exclude noaa-hms", () => {
    renderHook(() =>
      useIntegrationSourceAttributions("overlay-wildfires", ["firms", "nifc-wfigs"]),
    );

    const credits =
      useMapAttributionStore.getState().byLayer["integration:overlay-wildfires"] ?? [];
    expect(credits).toHaveLength(2);
    expect(credits.join(" ")).toContain("NASA FIRMS");
    expect(credits.join(" ")).not.toContain("NOAA");
  });

  it("registers NOAA exactly once when noaa-hms is included more than once", () => {
    renderHook(() =>
      useIntegrationSourceAttributions("overlay-wildfires", ["firms", "noaa-hms", "noaa-hms"]),
    );

    const credits =
      useMapAttributionStore.getState().byLayer["integration:overlay-wildfires"] ?? [];
    expect(credits.filter((credit) => credit.includes("NOAA"))).toEqual([
      "NOAA / NESDIS HMS Smoke Detection",
    ]);
  });
});

describe("useSourceAttributions", () => {
  beforeEach(() => {
    useMapAttributionStore.setState({ byLayer: {} });
  });

  afterEach(() => cleanup());

  it("credits only unique runtime source IDs and clears them immediately", () => {
    const view = renderHook(({ sourceIds }) => useSourceAttributions("air-quality", sourceIds), {
      initialProps: { sourceIds: ["firms", "noaa-hms", "firms"] },
    });
    expect(useMapAttributionStore.getState().byLayer["sources:air-quality"]).toHaveLength(2);

    view.rerender({ sourceIds: [] });
    expect(useMapAttributionStore.getState().byLayer["sources:air-quality"]).toBeUndefined();
  });
});
