import type {
  RoadConditionEvent,
  Route,
  RoutingTrafficProof,
  TrafficApplicationSnapshot,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./__tests__/support/routing-handler-contract.js";
import {
  receiptCoversEvent,
  snapshotMatchesProof,
  verifyRouteTraffic,
} from "./traffic-application.js";

const NOW = Date.parse("2026-09-12T12:00:00Z");

function event(overrides: Partial<RoadConditionEvent> = {}): RoadConditionEvent {
  return {
    id: "oc:1",
    source: "oc-child",
    provider: "road-conditions-openconditions",
    type: "road_closure",
    severity: "high",
    geometry: { type: "Point", coordinates: [7, 50] },
    headline: "Closed",
    originKind: "feed",
    routingEvidence: {
      schema_version: 1,
      observation_revision: "obs-1",
      binding_revision: "obs-1",
      graph_generation: "graph-1",
      resolver_version: "resolver-1",
      source_id: "oc-parent",
      child_source_id: "oc-child",
      source_license: "CC BY 4.0",
      license_url: "https://example.test/license",
      attribution: "Example road authority",
      record_url: null,
      source_checked_at: "2026-09-12T11:55:00Z",
      fresh_until: "2026-09-12T12:05:00Z",
      expires_at: "2026-09-12T12:10:00Z",
      valid_from: "2026-09-12T11:00:00Z",
      valid_to: "2026-09-12T13:00:00Z",
      next_transition_at: null,
      direction_mode: "both",
      applicability: { kind: "all" },
      rights: {
        source_redistribution: "yes",
        derived_redistribution: "yes",
        commercial_use: "yes",
        attribution_required: "yes",
        retention: "yes",
        evidence_origin: "source-catalogue",
        evidence_version: "1",
        reviewed_at: "2026-09-01T00:00:00Z",
      },
      segments: [
        { segment_id: "way:1:f", direction: "forward", from_fraction: 0, to_fraction: 1 },
        { segment_id: "way:1:r", direction: "reverse", from_fraction: 0, to_fraction: 1 },
      ],
      binding_status: "exact",
      reason_codes: [],
      evaluated_at: "2026-09-12T11:55:00Z",
    },
    ...overrides,
  };
}

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
  const e = event().routingEvidence;
  if (!e) throw new Error("missing fixture evidence");
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
    observationIds: ["oc:1"],
    resolverVersion: "resolver-1",
    receipts: [
      {
        observationId: "oc:1",
        observationRevision: e.observation_revision,
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
  it("requires exact revision, source graph, policy, spans and current rights", () => {
    expect(receiptCoversEvent(event(), snapshot(), proof, new Set(), NOW)).toBe(true);
    for (const patch of [
      { observationRevision: "old" },
      { sourceGraphGeneration: "old" },
      { policyRevision: "old" },
      { intendedSpans: [] },
      { complete: false },
    ]) {
      const s = snapshot();
      Object.assign(s.receipts[0] as object, patch);
      expect(receiptCoversEvent(event(), s, proof, new Set(), NOW)).toBe(false);
    }
    expect(receiptCoversEvent(event(), snapshot(), proof, new Set(["oc-parent"]), NOW)).toBe(false);
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
    getEvents.mockResolvedValue([
      event(),
      event({ id: "unapplied-cap", type: "roadworks", speedLimitKph: 30 }),
    ]);
    expect(
      (await verifyRouteTraffic(ctx, routes, fallback, "routing-valhalla"))?.reasons,
    ).toContain("incomplete_engine_application");
    getEvents.mockResolvedValue([event({ isStale: true })]);
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
