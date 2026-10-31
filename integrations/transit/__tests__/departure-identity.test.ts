import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { withAttribution } from "@openmapx/mobility-core/result";
import type { VehicleJourney } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import {
  headsignsCompatible,
  isTripNumber,
  lineNamesCompatible,
  normalizeShortName,
} from "../dedup.js";
import { createTransitOrchestrator } from "../orchestrator.js";

describe("headsignsCompatible", () => {
  it.each([
    ["Köln Hbf", "Köln Hauptbahnhof"],
    ["Hbf, Köln", "Köln Hbf"],
    ["Düsseldorf", "Düsseldorf Flughafen"],
    ["Frankfurt (Main) Hbf", "Frankfurt Hbf"],
    ["Klinikum Großhadern", "Klinikum Grosshadern"],
    [undefined, "Köln Hbf"],
    ["", "Köln Hbf"],
  ])("treats %j and %j as one destination", (a, b) => {
    expect(headsignsCompatible(a, b)).toBe(true);
  });

  it.each([
    ["Köln Hbf", "Aachen Hbf"],
    ["Ealing Broadway", "Epping"],
    ["Fürstenried West", "Garching-Forschungszentrum"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(headsignsCompatible(a, b)).toBe(false);
  });
});

describe("lineNamesCompatible", () => {
  it.each([
    ["RE1", "RE 1"],
    ["ICE", "ICE 123"],
    ["Bus 73", "73"],
    ["S1", undefined],
    ["RE1 (26826)", "RE 1 (RR"],
    ["RE1", "RE1RRX"],
    ["RE 1 (RRX)", "RE1"],
    ["DB S11 (Zug-Nr. 33192)", "S11"],
    ["RB48 (Zug-Nr. 17358)", "RB 48"],
  ])("treats %j and %j as one line", (a, b) => {
    expect(lineNamesCompatible(a, b)).toBe(true);
  });

  it.each([
    ["S1", "S2"],
    ["RE1", "RB1"],
    ["U6", "U61"],
    ["SEV S1", "S1"],
    ["RE1", "RE11"],
  ])("keeps %j and %j apart", (a, b) => {
    expect(lineNamesCompatible(a, b)).toBe(false);
  });
});

describe("line keys of bracket-laden names", () => {
  it("are computed in linear time", () => {
    const started = performance.now();
    for (const name of [` ${"( ".repeat(50_000)})x`, `${"!(".repeat(50_000)}x`]) {
      normalizeShortName(name);
      isTripNumber(name);
    }
    expect(performance.now() - started).toBeLessThan(200);
  });
});

describe("vehicle journey lookup across a merged departure's trip ids", () => {
  type Lookup = NonNullable<TransitProvider["getVehicleJourney"]>;
  const journey = (id: string) =>
    withAttribution({ tripId: id, stops: [] } as unknown as VehicleJourney, [], freshnessNow());

  function provider(id: string, getVehicleJourney: Lookup): TransitProvider {
    return {
      id,
      prefix: `${id}:`,
      coverage: { all: true },
      priority: 5,
      role: "regional",
      attribution: [],
      capabilities: {
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
        vehicleJourney: true,
      },
      healthCheck: async () => ({ healthy: true }),
      getVehicleJourney,
    };
  }

  function orchestrator(providers: TransitProvider[]) {
    const ctx = {
      providerHealth: {
        isHealthy: async () => true,
        recordSuccess: async () => {},
        recordFailure: async () => {},
      },
      getDisallowedSourceIds: async () => new Set<string>(),
      getIntegrationsByDomain: (domain: string) =>
        domain === "transit"
          ? [{ manifest: { dataSources: [] }, providers: new Map([["transit", providers]]) }]
          : [],
    } as unknown as IntegrationContext;
    return createTransitOrchestrator(ctx);
  }

  it("asks each trip id's own provider when the primary provider fails", async () => {
    const primary = vi.fn<Lookup>(async () => {
      throw new Error("down");
    });
    const other = vi.fn<Lookup>(async (id) => journey(id));
    const transit = orchestrator([provider("a", primary), provider("b", other)]);

    const result = await transit.getVehicleJourney("a:trip", ["b:trip", "a:alt"]);

    expect(result.data?.tripId).toBe("b:trip");
    expect(primary).toHaveBeenCalledWith("a:trip", ["a:alt"]);
    expect(other).toHaveBeenCalledWith("b:trip", undefined);
  });

  it("stops at the primary provider when it knows the trip", async () => {
    const primary = vi.fn<Lookup>(async (id) => journey(id));
    const other = vi.fn<Lookup>(async (id) => journey(id));
    const transit = orchestrator([provider("a", primary), provider("b", other)]);

    expect((await transit.getVehicleJourney("a:trip", ["b:trip"])).data?.tripId).toBe("a:trip");
    expect(other).not.toHaveBeenCalled();
  });

  it("answers no journey when no provider knows any of the ids", async () => {
    const empty = vi.fn<Lookup>(async () => withAttribution(null, [], freshnessNow()));
    const transit = orchestrator([provider("a", empty)]);

    expect((await transit.getVehicleJourney("a:trip", ["c:trip"])).data).toBeNull();
  });
});
