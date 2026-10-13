import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "./mapAttributionStore";
import { useContributorResolver } from "./useContributorResolver";
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
      licensing: licensingFromDeclaration("U.S. Public Domain", undefined, "NASA FIRMS"),
      providerCountry: "US",
      providerPrivacyUrl: "https://www.nasa.gov/privacy/",
    },
    {
      sourceId: "noaa-hms",
      name: "NOAA Hazard Mapping System Smoke Detection",
      url: "https://www.ospo.noaa.gov/products/land/hms.html",
      licensing: licensingFromDeclaration(
        "U.S. Public Domain",
        undefined,
        "NOAA Hazard Mapping System Smoke Detection",
      ),
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
        licensing: {
          version: 1,
          bindings: [
            { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC0-1.0" } },
          ],
        } as const,
        providerCountry: "NL",
        providerPrivacyUrl: "https://www.ndw.nu/privacy",
      },
      {
        sourceId: "osm-fuel",
        domain: "fuel-stations",
        name: "OpenStreetMap",
        url: "https://www.openstreetmap.org",
        licensing: {
          version: 1,
          bindings: [
            { scope: "data", subject: "Data", license: { kind: "spdx", expression: "ODbL-1.0" } },
          ],
        } as const,
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
    expect(
      Object.entries(byLayer)
        .find(([key]) => key.startsWith("domain:road-conditions::"))?.[1]
        ?.join(" "),
    ).toContain("NDW");
    expect(
      Object.entries(byLayer)
        .find(([key]) => key.startsWith("domain:road-conditions::"))?.[1]
        ?.join(" "),
    ).not.toContain("OpenStreetMap");
    expect(
      Object.entries(byLayer)
        .find(([key]) => key.startsWith("domain:fuel-stations::"))?.[1]
        ?.join(" "),
    ).toContain("OpenStreetMap");
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
    expect(
      Object.entries(useMapAttributionStore.getState().byLayer).find(([key]) =>
        key.startsWith("sources:air-quality::"),
      )?.[1],
    ).toHaveLength(2);

    view.rerender({ sourceIds: [] });
    expect(
      Object.entries(useMapAttributionStore.getState().byLayer).find(([key]) =>
        key.startsWith("sources:air-quality::"),
      )?.[1],
    ).toBeUndefined();
  });
});

describe("useContributorResolver", () => {
  afterEach(() => cleanup());

  it("captures explicit sources without domain expansion and honors empty snapshots", () => {
    const { result } = renderHook(() => useContributorResolver());
    const captured = result.current({ sourceIds: ["firms", "missing"] });
    expect(captured.map((receipt) => receipt.sourceId)).toEqual(["firms"]);
    expect(result.current({ contributors: [], sourceIds: ["firms"] })).toEqual([]);
    expect(
      result.current({
        contributors: [{ sourceId: "old", name: "Captured" }],
        sourceIds: ["firms"],
      }),
    ).toEqual([{ sourceId: "old", name: "Captured" }]);
    expect(result.current({})).toEqual([]);
  });
});
