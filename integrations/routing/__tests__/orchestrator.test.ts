import {
  effectiveProviderOrder,
  type IntegrationContext,
  providerOrderFingerprintInput,
} from "@openmapx/integration-framework";
import { nth } from "@openmapx/integration-framework/testing";
import type {
  DirectionsResult,
  MatchResult,
  RoutingProvider,
  TravelMode,
} from "@openmapx/provider-kit/routing";
import { describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";
import { captureRoutingResult, createRoutingOrchestrator } from "../orchestrator";

const ROUTING_DEFAULT_ORDER: readonly string[] =
  manifest.configSchema.properties.providerOrder.default;

it("orders the built-in engines BRouter, Valhalla, OSRM by default", () => {
  expect(ROUTING_DEFAULT_ORDER).toEqual(["routing-brouter", "routing-valhalla", "routing-osrm"]);
});

function makeProvider(
  modes: TravelMode[],
  opts: {
    id?: string;
    priority?: number;
    failing?: boolean;
    supportsMatch?: boolean;
    supportsTimeAware?: boolean;
    supportsOptimize?: boolean;
    supportsExclusions?: boolean;
  } = {},
): RoutingProvider {
  const provider: RoutingProvider = {
    id: opts.id ?? "test-provider",
    supportedModes: modes,
    priority: opts.priority,
    supportsTimeAware: opts.supportsTimeAware,
    supportsExclusions: opts.supportsExclusions,
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
          mode: nth(modes, 0),
        }) satisfies MatchResult,
    );
  }
  return provider;
}

function makeCtx(
  integrations: { id: string; provider: RoutingProvider }[],
  order: readonly string[] = [],
): IntegrationContext {
  return {
    getProviderOrder: (domain: string) => (domain === "routing" ? order : []),
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

  it("uses adapter priority for driving even when the lower-priority engine registers first", () => {
    const osrm = makeProvider(["driving"], { id: "engine-a", priority: 20 });
    const val = makeProvider(["walking", "cycling", "driving"], {
      id: "engine-b",
      priority: 10,
    });
    const ctx = makeCtx([
      { id: "routing-osrm", provider: osrm },
      { id: "routing-valhalla", provider: val },
    ]);
    const orch = createRoutingOrchestrator(ctx);
    // The generic orchestrator sees only adapter-declared priority.
    expect(orch.getRoutingProviders("driving").map((p) => p.integrationId)).toEqual([
      "routing-valhalla",
      "routing-osrm",
    ]);
    expect(orch.getRoutingProvider("driving")?.integrationId).toBe("routing-valhalla");
  });

  it("tries engines in the operator's order, not by their own priority", () => {
    const acme = makeProvider(["driving"], { id: "acme", priority: 1 });
    const valhalla = makeProvider(["driving"], { id: "valhalla", priority: 10 });
    const ctx = makeCtx(
      [
        { id: "routing-acme", provider: acme },
        { id: "routing-valhalla", provider: valhalla },
      ],
      ["routing-valhalla"],
    );
    const chain = createRoutingOrchestrator(ctx).getRoutingProviders("driving");
    expect(chain.map((e) => e.integrationId)).toEqual(["routing-valhalla", "routing-acme"]);
  });

  it("serves the order the fingerprint and the admin list describe", () => {
    const providers = [
      { id: "routing-acme", provider: makeProvider(["driving"], { id: "acme", priority: 1 }) },
      { id: "routing-osrm", provider: makeProvider(["driving"], { id: "osrm", priority: 20 }) },
      {
        id: "routing-valhalla",
        provider: makeProvider(["driving"], { id: "valhalla", priority: 10 }),
      },
      {
        id: "routing-brouter",
        provider: makeProvider(["driving"], { id: "brouter", priority: 5 }),
      },
    ];
    const ctx = makeCtx(providers, ROUTING_DEFAULT_ORDER);
    const served = createRoutingOrchestrator(ctx)
      .getRoutingProviders("driving")
      .map((e) => e.integrationId);
    expect(served).toEqual(["routing-brouter", "routing-valhalla", "routing-osrm", "routing-acme"]);
    expect(
      effectiveProviderOrder(
        ROUTING_DEFAULT_ORDER,
        ctx.getIntegrationsByDomain("routing"),
        "routing",
      ).map((e) => e.integrationId),
    ).toEqual(served);
    expect(
      (JSON.parse(providerOrderFingerprintInput(ctx, "routing")) as [string, string][]).map(
        ([integrationId]) => integrationId,
      ),
    ).toEqual(served);
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

  it("uses the first engine in order that can map-match", () => {
    const first = makeProvider(["driving"], { id: "first", supportsMatch: true });
    const second = makeProvider(["driving"], { id: "second", supportsMatch: true });
    const ctx = makeCtx(
      [
        { id: "routing-first", provider: first },
        { id: "routing-second", provider: second },
      ],
      ["routing-second"],
    );
    expect(createRoutingOrchestrator(ctx).getMatchProvider("driving")?.integrationId).toBe(
      "routing-second",
    );
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

it("captures only named routing suppliers at the orchestration boundary", () => {
  const supplier = { sourceId: "known", name: "Known" };
  const base = {
    distance: 1,
    duration: 1,
    geometry: [
      [0, 0],
      [1, 1],
    ] as [number, number][],
    mode: "driving" as const,
    legs: [],
    steps: [],
  };
  const served = {
    integrationId: "provider",
    provider: makeProvider(["driving"]),
    contributors: [supplier],
  };
  const result = captureRoutingResult(
    {
      waypoints: [],
      activeRouteIndex: 0,
      routes: [
        base,
        { ...base, sourceIds: ["known"] },
        { ...base, sourceIds: ["unknown"] },
        { ...base, contributors: [] },
      ],
    },
    served,
  );
  expect(result.routes.map((route) => route.contributors)).toEqual([[], [supplier], [], []]);
});
