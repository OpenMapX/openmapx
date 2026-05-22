import type {
  IntegrationContext,
  ProviderAttribution,
  TransitProvider,
} from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { getTransitProviderAttribution } from "../orchestrator.js";

const ALL_FALSE_CAPABILITIES = {
  stops: {
    lookup: false,
    nearby: false,
    bbox: false,
    search: false,
    infrastructure: false,
    platforms: false,
    timetable: false,
  },
  departures: false,
  arrivals: false,
  routes: { lookup: false, forStop: false, stops: false, geometry: false },
  planning: false,
  vehiclePositions: false,
  vehicleJourney: false,
  alerts: { byStop: false, byRoute: false, byBbox: false },
  facilities: false,
} as const;

function makeProvider(overrides: Partial<TransitProvider> & { prefix: string }): TransitProvider {
  return {
    id: `test-${overrides.prefix.replace(/:$/, "")}`,
    prefix: overrides.prefix,
    coverage: { bbox: [-180, -90, 180, 90] },
    priority: 5,
    capabilities: ALL_FALSE_CAPABILITIES,
    attribution: [],
    ...overrides,
  };
}

interface IntegrationFixture {
  id: string;
  manifest: {
    dataSources?: Array<{ name: string; url: string; license?: string; licenseUrl?: string }>;
  };
  providers: Map<string, unknown[]>;
}

function makeCtx(
  transit: IntegrationFixture[],
  gtfsCatalog: IntegrationFixture[] = [],
): IntegrationContext {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    log,
    getIntegrationsByDomain: (domain: string) => {
      if (domain === "transit") return transit;
      if (domain === "gtfs-catalog") return gtfsCatalog;
      return [];
    },
  } as unknown as IntegrationContext;
}

describe("getTransitProviderAttribution", () => {
  it("maps a transit integration's prefix to its manifest dataSource", async () => {
    const ctx = makeCtx([
      {
        id: "transit-tfl",
        manifest: {
          dataSources: [
            {
              name: "Transport for London",
              url: "https://tfl.gov.uk",
              license: "OGL-UK-3.0",
              licenseUrl: "https://nationalarchives.gov.uk/doc/open-government-licence/version/3/",
            },
          ],
        },
        providers: new Map([["transit", [makeProvider({ prefix: "tfl:" })]]]),
      },
    ]);

    const result = await getTransitProviderAttribution(ctx);
    expect(result.tfl).toEqual({
      label: "Transport for London",
      url: "https://tfl.gov.uk",
      license: "OGL-UK-3.0",
      licenseUrl: "https://nationalarchives.gov.uk/doc/open-government-licence/version/3/",
    });
  });

  it("includes gtfs-catalog integrations keyed by integration id", async () => {
    const ctx = makeCtx(
      [],
      [
        {
          id: "transit-mobility-database",
          manifest: {
            dataSources: [
              {
                name: "Mobility Database",
                url: "https://mobilitydatabase.org/",
                license: "CC0-1.0",
              },
            ],
          },
          providers: new Map(),
        },
      ],
    );

    const result = await getTransitProviderAttribution(ctx);
    expect(result["transit-mobility-database"]).toEqual({
      label: "Mobility Database",
      url: "https://mobilitydatabase.org/",
      license: "CC0-1.0",
      licenseUrl: undefined,
    });
  });

  it("fans in per-feed attribution and lets it override the integration-level row", async () => {
    const gtfsLocal = makeProvider({
      prefix: "g-",
      getFeedAttribution: async () => ({
        "gtfs-de_vbb": {
          label: "VBB",
          url: "https://vbb.de",
          license: "CC-BY-4.0",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        },
        "gtfs-ch_sbb": { label: "SBB", url: "https://sbb.ch" },
      }),
    });
    const ctx = makeCtx([
      {
        id: "transit-gtfs-local",
        manifest: {
          dataSources: [{ name: "Local GTFS", url: "https://example.org" }],
        },
        providers: new Map([["transit", [gtfsLocal]]]),
      },
    ]);

    const result = await getTransitProviderAttribution(ctx);
    // Integration-level row keyed by prefix (no trailing colon to strip here)
    expect(result["g-"]).toMatchObject({ label: "Local GTFS" });
    // Per-feed rows keyed by what TransitStop.provider carries
    expect(result["gtfs-de_vbb"]).toEqual({
      label: "VBB",
      url: "https://vbb.de",
      license: "CC-BY-4.0",
      licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    });
    expect(result["gtfs-ch_sbb"]).toMatchObject({ label: "SBB" });
  });

  it("swallows getFeedAttribution failures and logs a warning", async () => {
    const failing = makeProvider({
      prefix: "broken:",
      getFeedAttribution: async () => {
        throw new Error("boom");
      },
    });
    const working = makeProvider({
      prefix: "ok:",
      getFeedAttribution: async () => ({ ok: { label: "OK Operator", url: "" } }),
    });
    const ctx = makeCtx([
      {
        id: "integration-a",
        manifest: { dataSources: [{ name: "A", url: "https://a" }] },
        providers: new Map([["transit", [failing, working]]]),
      },
    ]);

    const result = await getTransitProviderAttribution(ctx);
    expect(result.ok).toEqual({ label: "OK Operator", url: "" });
    // Integration-level fallback still present for the broken provider
    expect(result.broken).toMatchObject({ label: "A" });
  });

  it("per-feed rows can override their own integration-level row when keys match", async () => {
    // The dynamic-registry pattern: prefix "oebb:" gives an integration-level
    // row keyed "oebb"; getFeedAttribution returns a per-instance row also
    // keyed "oebb" carrying the real operator. The per-feed row wins.
    const provider = makeProvider({
      prefix: "oebb:",
      getFeedAttribution: async () => ({
        oebb: { label: "ÖBB", url: "https://oebb.at", license: "Proprietary" },
      }),
    });
    const ctx = makeCtx([
      {
        id: "transit-dynamic-registry",
        manifest: { dataSources: [{ name: "JSDelivr CDN", url: "https://jsdelivr.com" }] },
        providers: new Map([["transit", [provider]]]),
      },
    ]);

    const result = await getTransitProviderAttribution(ctx);
    expect(result.oebb).toEqual({
      label: "ÖBB",
      url: "https://oebb.at",
      license: "Proprietary",
    });
  });

  it("returns an empty map when no integrations are registered", async () => {
    const result = await getTransitProviderAttribution(makeCtx([]));
    expect(result).toEqual({});
  });

  // Type guard: ProviderAttribution matches the inline shape used in the
  // existing route response and the packages/core consumer.
  it("returned rows are assignable to ProviderAttribution", async () => {
    const ctx = makeCtx([
      {
        id: "x",
        manifest: { dataSources: [{ name: "X", url: "https://x" }] },
        providers: new Map([["transit", [makeProvider({ prefix: "x:" })]]]),
      },
    ]);
    const result = await getTransitProviderAttribution(ctx);
    const row: ProviderAttribution = result.x;
    expect(row.label).toBe("X");
  });
});
