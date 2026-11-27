import { createHash } from "node:crypto";
import {
  effectiveProviderOrder,
  type LoadedIntegration,
  type TransitProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import { describe, expect, it } from "vitest";
import { createTransitOrchestrator } from "../orchestrator.js";

const TRIP = { from: { lat: 52.5, lng: 13.4 }, to: { lat: 52.52, lng: 13.42 } };

function transitProvider(
  id: string,
  role: TransitProvider["role"],
  priority: number,
  asked: string[],
  prefix = `${id}:`,
): TransitProvider {
  return {
    id,
    prefix,
    coverage: { all: true },
    priority,
    role,
    attribution: [],
    capabilities: {
      stops: {
        lookup: true,
        nearby: false,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: false,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: true,
      vehicleJourney: false,
      vehiclePositions: false,
      alerts: { byStop: false, byRoute: false, byBbox: false },
      facilities: false,
    },
    healthCheck: async () => ({ status: "up" }),
    async planTrip() {
      asked.push(id);
      throw new Error("try the next planner");
    },
    async getStop(stopId: string) {
      asked.push(id);
      return {
        data: { id: stopId, name: id, lat: 0, lng: 0 },
        attributions: [],
        freshness: freshnessNow(),
      };
    },
    async searchStopsByName() {
      asked.push(id);
      return {
        data: [{ id: `${prefix}stop`, name: id, lat: 52.5, lng: 13.4 }],
        attributions: [],
        freshness: freshnessNow(),
      };
    },
  } as unknown as TransitProvider;
}

function integration(id: string, provider: TransitProvider): LoadedIntegration {
  return {
    id,
    config: {},
    manifest: { id, domains: ["transit"], dataSources: [] },
    providers: new Map([["transit", [provider]]]),
  } as unknown as LoadedIntegration;
}

function hostLike(integrations: LoadedIntegration[], order: readonly string[] = []) {
  const ctx = createMockIntegrationContext({ id: "transit", providerOrder: { transit: order } });
  ctx.getIntegrationsByDomain = (domain) => (domain === "transit" ? integrations : []);
  return ctx;
}

async function plannedOrder(ctx: ReturnType<typeof hostLike>, asked: string[]) {
  asked.length = 0;
  await createTransitOrchestrator(ctx).planTrip(TRIP as never);
  return [...asked];
}

describe("transit planners in the operator's order", () => {
  it("keeps the baseline role ahead of the operator's order", async () => {
    const asked: string[] = [];
    const integrations = [
      integration("transit-acme", transitProvider("acme", "regional", 1, asked)),
      integration("transit-base", transitProvider("base", "baseline", 5, asked)),
    ];
    const ctx = hostLike(integrations, ["transit-acme", "transit-base"]);
    expect(await plannedOrder(ctx, asked)).toEqual(["base", "acme"]);
  });

  it("applies the operator's order inside a role", async () => {
    const asked: string[] = [];
    const integrations = [
      integration("transit-a", transitProvider("a", "regional", 1, asked)),
      integration("transit-b", transitProvider("b", "regional", 6, asked)),
      integration("transit-c", transitProvider("c", "regional", 2, asked)),
      integration("transit-e", transitProvider("e", "enrichment", 0, asked)),
    ];
    const ctx = hostLike(integrations, ["transit-e", "transit-b"]);
    expect(await plannedOrder(ctx, asked)).toEqual(["b", "a", "c", "e"]);
  });

  it("looks up a prefix and searches stop names in the same order", async () => {
    const asked: string[] = [];
    const integrations = [
      integration("transit-a", transitProvider("a", "regional", 1, asked, "xx:")),
      integration("transit-b", transitProvider("b", "regional", 6, asked, "xx:")),
    ];
    const ctx = hostLike(integrations, ["transit-b"]);
    const orchestrator = createTransitOrchestrator(ctx);
    expect((await orchestrator.getStop("xx:1")).data?.name).toBe("b");
    const found = await orchestrator.searchByNameRaw("Mitte", 10);
    expect(found.data.map((stop) => stop.name)).toEqual(["b", "a"]);
  });
});

describe("served transit order, fingerprint and admin list", () => {
  it("agree on the served sequence", async () => {
    const asked: string[] = [];
    const integrations = [
      integration("transit-a", transitProvider("a", "regional", 1, asked)),
      integration("transit-base", transitProvider("base", "baseline", 5, asked)),
      integration("transit-b", transitProvider("b", "regional", 6, asked)),
      integration("transit-e", transitProvider("e", "enrichment", 0, asked)),
    ];
    const order = ["transit-e", "ghost", "transit-b"];
    const ctx = hostLike(integrations, order);
    const served = await plannedOrder(ctx, asked);
    expect(served).toEqual(["base", "b", "a", "e"]);
    const integrationOf = new Map(integrations.map((entry) => [entry.id.slice(8), entry.id]));
    const servedIntegrations = served.map((id) => integrationOf.get(id));
    expect(
      effectiveProviderOrder(order, integrations, "transit").map((entry) => entry.integrationId),
    ).toEqual(servedIntegrations);
    expect(ctx.getProviderOrderFingerprint("transit")).toBe(
      createHash("sha256")
        .update(JSON.stringify(served.map((id) => [integrationOf.get(id), id])))
        .digest("hex")
        .slice(0, 16),
    );
  });

  it("plans in role, priority and id order with the default configuration", async () => {
    const asked: string[] = [];
    const integrations = [
      integration("transit-overpass", transitProvider("overpass", "enrichment", 10, asked)),
      integration("transit-otp", transitProvider("otp", "regional", 6, asked)),
      integration("transit-motis-cloud", transitProvider("cloud", "fallback", 7, asked)),
      integration("transit-entur", transitProvider("entur", "regional", 1, asked)),
      integration("transit-motis", transitProvider("transit-motis-local", "baseline", 1, asked)),
      integration("transit-irail", transitProvider("irail", "regional", 1, asked)),
    ];
    expect(await plannedOrder(hostLike(integrations), asked)).toEqual([
      "transit-motis-local",
      "entur",
      "irail",
      "otp",
      "cloud",
      "overpass",
    ]);
  });
});
