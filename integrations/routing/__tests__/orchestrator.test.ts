import type { IntegrationContext } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { createRoutingOrchestrator } from "../orchestrator";
import type { DirectionsResult, MatchResult, RoutingProvider, TravelMode } from "../types.js";

function makeProvider(
  modes: TravelMode[],
  opts: {
    id?: string;
    failing?: boolean;
    supportsMatch?: boolean;
    supportsTimeAware?: boolean;
    supportsOptimize?: boolean;
  } = {},
): RoutingProvider {
  const provider: RoutingProvider = {
    id: opts.id ?? "test-provider",
    supportedModes: modes,
    supportsTimeAware: opts.supportsTimeAware,
    getRoute: vi.fn(async () => {
      if (opts.failing) throw new Error("upstream down");
      return {
        waypoints: [],
        routes: [],
        activeRouteIndex: 0,
      } satisfies DirectionsResult;
    }),
  };
  if (opts.supportsOptimize) {
    provider.optimizeRoute = vi.fn(
      async () =>
        ({
          waypoints: [],
          routes: [],
          activeRouteIndex: 0,
        }) satisfies DirectionsResult,
    );
  }
  if (opts.supportsMatch) {
    provider.getMatch = vi.fn(
      async () =>
        ({
          geometry: [],
          edges: [],
          points: [],
          mode: modes[0],
        }) satisfies MatchResult,
    );
  }
  return provider;
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

  it("prefers Valhalla over OSRM for driving even when OSRM registers first", () => {
    const osrm = makeProvider(["driving"], { id: "osrm" });
    const val = makeProvider(["walking", "cycling", "driving"], { id: "valhalla" });
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: val },
    ]);
    const orch = createRoutingOrchestrator(ctx);
    // Driving prefers Valhalla (richer voice/lane data); OSRM stays as fallback.
    expect(orch.getRoutingProviders("driving").map((p) => p.integrationId)).toEqual([
      "routing-valhalla",
      "routing-osrm",
    ]);
    expect(orch.getRoutingProvider("driving")?.integrationId).toBe("routing-valhalla");
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

describe("routing orchestrator getMatchProvider", () => {
  it("returns the first provider that implements getMatch and supports the mode", () => {
    const osrm = makeProvider(["driving"]); // no getMatch
    const valhalla = makeProvider(["driving", "walking", "cycling"], { supportsMatch: true });
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: valhalla },
    ]);
    const orch = createRoutingOrchestrator(ctx);
    expect(orch.getMatchProvider("driving")?.integrationId).toBe("routing-valhalla");
  });

  it("returns null when no provider implements getMatch for the mode", () => {
    const osrm = makeProvider(["driving"]);
    const ctx = makeCtx([{ id: "routing-osrm", provider: osrm }]);
    const orch = createRoutingOrchestrator(ctx);
    expect(orch.getMatchProvider("driving")).toBeNull();
  });
});

describe("routing orchestrator requireTimeAware filter", () => {
  it("getRoutingProviders drops time-agnostic providers when requireTimeAware is set", () => {
    const osrm = makeProvider(["driving"]); // supportsTimeAware undefined
    const valhalla = makeProvider(["driving", "walking", "cycling"], {
      supportsTimeAware: true,
    });
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: valhalla },
    ]);
    const orch = createRoutingOrchestrator(ctx);

    const all = orch.getRoutingProviders("driving");
    expect(all.map((p) => p.integrationId)).toEqual(["routing-osrm", "routing-valhalla"]);

    const timed = orch.getRoutingProviders("driving", { requireTimeAware: true });
    expect(timed.map((p) => p.integrationId)).toEqual(["routing-valhalla"]);
  });

  it("getRoutingProviders returns empty when no time-aware provider supports the mode", () => {
    const osrm = makeProvider(["driving"]);
    const ctx = makeCtx([{ id: "routing-osrm", provider: osrm }]);
    const orch = createRoutingOrchestrator(ctx);
    expect(orch.getRoutingProviders("driving", { requireTimeAware: true })).toEqual([]);
  });

  it("getOptimizeProvider drops time-agnostic providers when requireTimeAware is set", () => {
    const osrm = makeProvider(["driving"], { supportsOptimize: true });
    const valhalla = makeProvider(["driving"], {
      supportsOptimize: true,
      supportsTimeAware: true,
    });
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: valhalla },
    ]);
    const orch = createRoutingOrchestrator(ctx);

    expect(orch.getOptimizeProvider("driving")?.integrationId).toBe("routing-osrm");
    expect(orch.getOptimizeProvider("driving", { requireTimeAware: true })?.integrationId).toBe(
      "routing-valhalla",
    );
  });

  it("getOptimizeProvider does NOT cross-mode-fall-back when requireTimeAware is set", () => {
    // Without requireTimeAware, the cross-mode fallback returns the lone
    // optimize-capable provider even if it doesn't support the requested mode.
    // With requireTimeAware, that fallback would silently drop the time
    // semantics, so we want a clean null instead.
    const driving = makeProvider(["driving"], {
      supportsOptimize: true,
      supportsTimeAware: false,
    });
    const ctx = makeCtx([{ id: "routing-osrm", provider: driving }]);
    const orch = createRoutingOrchestrator(ctx);

    expect(orch.getOptimizeProvider("walking")?.integrationId).toBe("routing-osrm");
    expect(orch.getOptimizeProvider("walking", { requireTimeAware: true })).toBeNull();
  });
});
