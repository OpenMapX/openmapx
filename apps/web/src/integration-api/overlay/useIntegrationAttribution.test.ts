import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "./mapAttributionStore";
import {
  useIntegrationDomainAttribution,
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
      sourceId: "noaa-hms",
      name: "NOAA Hazard Mapping System Smoke Detection",
      url: "https://www.ospo.noaa.gov/products/land/hms.html",
      license: "U.S. Public Domain",
      attribution: "NOAA / NESDIS HMS Smoke Detection",
      providerCountry: "US",
      providerPrivacyUrl: "https://www.noaa.gov/privacy/",
    },
  ];
  // One integration in two domains: a road feed that names no domain, and a
  // fuel feed that names its own.
  const openconditions = {
    id: "openconditions",
    domains: ["road-conditions", "fuel-stations"],
    dataSources: [
      {
        sourceId: "nl-ndw-events",
        name: "NDW",
        url: "https://www.ndw.nu",
        license: "CC0-1.0",
        providerCountry: "NL",
        providerPrivacyUrl: "https://www.ndw.nu/privacy",
      },
      {
        sourceId: "osm-fuel",
        domain: "fuel-stations",
        name: "OpenStreetMap",
        url: "https://www.openstreetmap.org",
        license: "ODbL-1.0",
        providerCountry: "GB",
        providerPrivacyUrl: "https://osmfoundation.org/wiki/Privacy_Policy",
      },
    ],
  };
  const members: Record<string, unknown[]> = {
    "road-conditions": [openconditions],
    "fuel-stations": [openconditions],
  };
  return {
    useIntegrationRegistry: () => ({
      get: () => ({ dataSources }),
      getByDomain: (domain: string) => members[domain] ?? [],
      findDataSource: (sourceId: string) =>
        dataSources.find((source) => source.sourceId === sourceId),
    }),
  };
});

describe("useIntegrationDomainAttribution", () => {
  beforeEach(() => {
    useMapAttributionStore.setState({ byLayer: {} });
  });

  afterEach(() => cleanup());

  it("credits a source that names another domain only in that domain", () => {
    renderHook(() => useIntegrationDomainAttribution("road-conditions", true));
    renderHook(() => useIntegrationDomainAttribution("fuel-stations", true));

    const { byLayer } = useMapAttributionStore.getState();
    expect(byLayer["domain:road-conditions"]?.join(" ")).toContain("NDW");
    expect(byLayer["domain:road-conditions"]?.join(" ")).not.toContain("OpenStreetMap");
    expect(byLayer["domain:fuel-stations"]?.join(" ")).toContain("OpenStreetMap");
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
