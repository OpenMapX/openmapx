import type {
  RoadConditionEvent,
  Route,
  RoutingTrafficProof,
  TrafficApplicationSnapshot,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  boundEvent,
  effect,
  firstEffect,
  routingEvidence,
} from "./__tests__/support/road-condition.js";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./__tests__/support/routing-handler-contract.js";
import {
  engineEffectOf,
  receiptCoversEffect,
  snapshotMatchesProof,
  verifyRouteTraffic,
} from "./traffic-application.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");

const event = (overrides: Partial<RoadConditionEvent> = {}): RoadConditionEvent =>
  boundEvent({ geometry: { type: "Point", coordinates: [7, 50] }, ...overrides });
const closureOf = firstEffect;
const snapshotEvidence = () => routingEvidence("oc:1", "oc:1/closure");
const speedLimit = (id: string, kph: number) =>
  effect(id, "speed_limit", { limit: { value: kph, unit: "km/h" } });

const proof: RoutingTrafficProof = {
  schemaVersion: 1,
  requestId: "nonce",
  writeId: "write",
  engineBootId: "boot",
  graphGeneration: "host-graph",
  evaluatedAt: new Date(NOW).toISOString(),
  validUntil: new Date(NOW + 60000).toISOString(),
  endpoint: "route",
  costing: "auto",
};
function snapshot(): TrafficApplicationSnapshot {
  const e = snapshotEvidence();
  return {
    schemaVersion: 1,
    mode: "active",
    providerId: "routing-valhalla",
    writeId: "write",
    engineBootId: "boot",
    graphGeneration: "host-graph",
    policyRevision: "policy",
    validUntil: proof.validUntil,
    writtenAt: new Date(NOW - 1000).toISOString(),
    observationIds: ["oc:1#oc:1/closure"],
    resolverVersion: "resolver-1",
    receipts: [
      {
        observationId: "oc:1#oc:1/closure",
        observationRevision: String(e.record_revision),
        sourceId: "oc-child",
        graphGeneration: "host-graph",
        sourceGraphGeneration: e.graph_generation,
        policyRevision: "policy",
        validUntil: proof.validUntil,
        complete: true,
        effect: "closure",
        intendedSpans: e.segments,
        edgeKeys: ["edge"],
        sourceLicense: e.source_license,
        attribution: e.attribution,
      },
    ],
  };
}
const fallback = {
  availability: "unsupported" as const,
  evaluatedAt: proof.evaluatedAt,
  validUntil: null,
  reasons: ["unverified_engine_application"],
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe("engine application reconciliation", () => {
  it("requires the same committed write, boot and graph", () => {
    expect(snapshotMatchesProof(snapshot(), proof, NOW)).toBe(true);
    for (const patch of [
      { writeId: "other" },
      { engineBootId: "other" },
      { graphGeneration: "other" },
      { mode: "shadow" as const },
      { validUntil: proof.evaluatedAt },
    ])
      expect(snapshotMatchesProof({ ...snapshot(), ...patch }, proof, NOW)).toBe(false);
  });
  it("requires exact revision, effect, source graph, policy, spans and current rights", () => {
    const e = event();
    const covers = (s: TrafficApplicationSnapshot, disallowed = new Set<string>()) =>
      receiptCoversEffect(e, closureOf(e), s, proof, disallowed, NOW);
    expect(covers(snapshot())).toBe(true);
    for (const patch of [
      { observationRevision: "2" },
      { observationId: "oc:1" },
      { effect: "speed_cap" as const },
      { sourceGraphGeneration: "old" },
      { policyRevision: "old" },
      { intendedSpans: [] },
      { complete: false },
    ]) {
      const s = snapshot();
      Object.assign(s.receipts[0] as object, patch);
      expect(covers(s), JSON.stringify(patch)).toBe(false);
    }
    expect(covers(snapshot(), new Set(["oc-parent"]))).toBe(false);
  });

  it("covers a speed cap only with a speed-cap receipt", () => {
    const cap = speedLimit("oc:1/speed_limit", 40);
    const e = event({ effects: [cap] });
    e.routingEvidence = {
      [cap.id]: { ...snapshotEvidence(), effect_id: cap.id, effect_kind: "speed_limit" },
    };
    const s = snapshot();
    Object.assign(s.receipts[0] as object, { observationId: "oc:1#oc:1/speed_limit" });
    expect(receiptCoversEffect(e, cap, s, proof, new Set(), NOW)).toBe(false);
    Object.assign(s.receipts[0] as object, { effect: "speed_cap" });
    expect(receiptCoversEffect(e, cap, s, proof, new Set(), NOW)).toBe(true);
  });

  it("names what the writer does for each effect", () => {
    expect(engineEffectOf(closureOf(event()))).toBe("closure");
    expect(
      engineEffectOf(effect("x", "lane_restriction", { vehicleImpact: "all_lanes_closed" })),
    ).toBe("closure");
    expect(engineEffectOf(speedLimit("x", 30))).toBe("speed_cap");
    expect(
      engineEffectOf(
        effect("x", "speed_limit", { limit: { value: 30, unit: "km/h" }, advisory: true }),
      ),
    ).toBeNull();
    expect(engineEffectOf(effect("x", "delay"))).toBeNull();
    expect(
      engineEffectOf(
        effect("x", "closure", { applicability: { kind: "classes", include: [{ class: "hgv" }] } }),
      ),
    ).toBeNull();
  });
  it("uses fresh authenticated evidence and covers all events, including speed caps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "test-secret");
    const get = vi.fn().mockResolvedValue(snapshot());
    const getEvents = vi.fn().mockResolvedValue([event()]);
    const getRoutingEvents = vi.fn(async () => ({ complete: true, events: await getEvents() }));
    const ctx = {
      http: { get },
      getRequiredService: () => ({ url: "http://localhost:4000" }),
      getIntegrationsByDomain: () => [
        { providers: new Map([["road-conditions", [{ getEvents, getRoutingEvents }]]]) },
      ],
      getDisallowedSourceIds: async () => new Set(),
      getRoadConditionsPolicySnapshot: async () => ({
        authoritative: true,
        revision: "policy",
        validUntil: proof.validUntil,
        disallowedSourceIds: [],
      }),
    } as unknown as IntegrationContext;
    const routes = [{ trafficProof: proof, geometry: [[7, 50]], mode: "driving" }] as Route[];
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.availability,
    ).toBe("current");
    const legacyCtx = {
      ...ctx,
      getIntegrationsByDomain: () => [
        { providers: new Map([["road-conditions", [{ getEvents }]]]) },
      ],
    } as unknown as IntegrationContext;
    expect(
      (await verifyRouteTraffic(legacyCtx, routes, fallback, "routing-valhalla"))?.availability,
    ).not.toBe("current");
    getRoutingEvents.mockResolvedValueOnce({ complete: false, events: [] });
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.availability,
    ).not.toBe("current");
    getRoutingEvents.mockResolvedValueOnce([] as never);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.availability,
    ).not.toBe("current");
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining("/traffic/conditions/applied"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-secret" }),
      }),
    );
    expect(getRoutingEvents).toHaveBeenCalledWith(expect.any(Array));
    const cap = speedLimit("unapplied-cap/speed_limit", 30);
    getEvents.mockResolvedValue([
      event(),
      boundEvent({ id: "unapplied-cap", geometry: { type: "Point", coordinates: [7, 50] } }, cap),
    ]);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.reasons,
    ).toContain("incomplete_engine_application");
    // A second effect of the applied situation is its own obligation.
    const twoEffects = event({ effects: [closureOf(event()), speedLimit("oc:1/speed_limit", 30)] });
    twoEffects.routingEvidence = {
      ...twoEffects.routingEvidence,
      "oc:1/speed_limit": routingEvidence("oc:1", "oc:1/speed_limit", {
        effect_kind: "speed_limit",
      }),
    };
    getEvents.mockResolvedValue([twoEffects]);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.reasons,
    ).toContain("incomplete_engine_application");
    // Unbound effects the writer never applies leave the proof current.
    getEvents.mockResolvedValue([
      event({ effects: [closureOf(event()), effect("oc:1/delay", "delay")] }),
    ]);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.availability,
    ).toBe("current");
    // An unbound closure is a gap in the proof.
    getEvents.mockResolvedValue([
      event({ effects: [closureOf(event()), effect("oc:1/ramp", "closure", { scope: "ramp" })] }),
    ]);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.reasons,
    ).toContain("missing_routing_evidence");
    getEvents.mockResolvedValue([
      boundEvent({ geometry: { type: "Point", coordinates: [7, 50] } }, effect("oc:1/closure"), {
        source_checked_at: "2026-09-12T11:40:00Z",
        fresh_until: "2026-09-12T11:50:00Z",
      }),
    ]);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.reasons,
    ).toContain("stale_source");
    get.mockResolvedValue({ ...snapshot(), policyRevision: "old-policy" });
    expect(await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla")).toEqual(fallback);
    get.mockResolvedValue(snapshot());
    getEvents.mockRejectedValue(new Error("provider failed"));
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.availability,
    ).toBe("limited");
    expect(await verifyRouteTraffic(ctx, routes, fallback, "routing-osrm")).toEqual(fallback);
    expect(
      await verifyRouteTraffic(
        ctx,
        [{ ...routes[0], trafficProof: undefined }] as Route[],
        fallback,
        "routing-valhalla",
      ),
    ).toEqual(fallback);
  });
});

describe("route handler proof orchestration", () => {
  it.each(["/directions", "/directions/optimize"])(
    "%s validates the served response and never reuses proof cache",
    async (path) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "test-secret");
      const getRoute = vi.fn(async () => ({
        waypoints: [
          [7, 50],
          [7.1, 50.1],
        ] as [number, number][],
        activeRouteIndex: 0,
        routes: [
          {
            trafficProof: {
              ...proof,
              endpoint: path.endsWith("optimize")
                ? ("optimized_route" as const)
                : ("route" as const),
            },
            geometry: [
              [7, 50],
              [7.1, 50.1],
            ],
            mode: "driving",
            distance: 1000,
            duration: 100,
            steps: [],
          },
        ] as Route[],
      }));
      const cached = vi.fn();
      const environment = createRoutingHandlerEnvironment({
        routingProviders: [
          {
            integrationId: "routing-valhalla",
            providerId: "valhalla",
            getRoute,
            optimizeRoute: getRoute,
          },
        ],
        additionalIntegrations: {
          "road-conditions": [
            {
              id: "conditions",
              providers: new Map([
                [
                  "road-conditions",
                  [
                    {
                      getEvents: async () => [event()],
                      getRoutingEvents: async () => ({ complete: true, events: [event()] }),
                    },
                  ],
                ],
              ]),
            },
          ],
        },
        contextOverrides: {
          getRequiredService: () => ({ url: "http://localhost:4000" }),
          http: { get: vi.fn().mockResolvedValue(snapshot()) },
          cache: { withCache: cached },
          getRoadConditionsPolicySnapshot: async () => ({
            authoritative: true,
            revision: "policy",
            validUntil: proof.validUntil,
            disallowedSourceIds: [],
          }),
        } as unknown as Partial<IntegrationContext>,
      });
      for (let i = 0; i < 2; i++) {
        const reply = createRoutingTestReply();
        await environment.getHandler(path)(
          { query: { waypoints: "7,50;7.1,50.1;7.2,50.2", useLiveTraffic: "true" } },
          reply,
        );
        expect(reply.code).toBe(200);
        expect(reply.body).toMatchObject({ roadConditionImpact: { availability: "current" } });
        expect(reply.header).toHaveBeenCalledWith("Cache-Control", "no-store");
      }
      expect(getRoute).toHaveBeenCalledTimes(2);
      expect(cached).not.toHaveBeenCalled();
    },
  );
});
