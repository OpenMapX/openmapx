import type { IntegrationContext } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { createRoutingOrchestrator } from "../orchestrator";
import type { DirectionsResult, RoutingProvider, TravelMode } from "../types.js";

function makeProvider(modes: TravelMode[], opts: { failing?: boolean } = {}): RoutingProvider {
  return {
    id: "test-provider",
    supportedModes: modes,
    getRoute: vi.fn(async () => {
      if (opts.failing) throw new Error("upstream down");
      return {
        waypoints: [],
        routes: [],
        activeRouteIndex: 0,
      } satisfies DirectionsResult;
    }),
  };
}

function makeCtx(integrations: { id: string; provider: RoutingProvider }[]): IntegrationContext {
  return {
    getIntegrationsByDomain: (_domain: string) =>
      integrations.map((i) => ({
        id: i.id,
        providers: new Map<string, unknown[]>([["routing", [i.provider]]]),
      })),
  } as unknown as IntegrationContext;
}

describe("routing orchestrator getRoutingProviders", () => {
  it("returns providers ordered by registration for the requested mode", () => {
    const osrm = makeProvider(["driving"]);
    const val = makeProvider(["walking", "cycling", "driving"]);
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: val },
    ]);
    const orch = createRoutingOrchestrator(ctx);
    const list = orch.getRoutingProviders("driving");
    expect(list.map((p) => p.integrationId)).toEqual(["routing-osrm", "routing-valhalla"]);
  });

  it("returns only providers that support the requested mode", () => {
    const osrm = makeProvider(["driving"]);
    const val = makeProvider(["walking", "cycling", "driving"]);
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: val },
    ]);
    const orch = createRoutingOrchestrator(ctx);
    const list = orch.getRoutingProviders("walking");
    expect(list.map((p) => p.integrationId)).toEqual(["routing-valhalla"]);
  });

  it("returns empty array when nothing supports the mode", () => {
    const ctx = makeCtx([{ id: "routing-osrm", provider: makeProvider(["driving"]) }]);
    const orch = createRoutingOrchestrator(ctx);
    expect(orch.getRoutingProviders("walking")).toEqual([]);
  });
});
