/** Disposable pinned-engine probe. Uses real writer, provider, API auth and receipt consumer. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoadConditionEvent, TrafficApplicationSnapshot } from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import Fastify from "fastify";
import { verifyRouteTraffic } from "../../../integrations/routing/traffic-application.js";
import {
  setValhallaUrl,
  valhallaService,
} from "../../../integrations/routing-valhalla/provider.js";
import { event as fixtureEvent } from "../src/__tests__/fixtures/road-condition.js";
import { registerApi } from "../src/api.js";
import { registerAuth } from "../src/auth.js";
import type { BoundCondition } from "../src/jobs/traffic/conditions-to-edges.js";
import { readTrafficGraphState } from "../src/jobs/traffic/graph-generation.js";
import { buildTrafficReceipts } from "../src/jobs/traffic/receipts.js";
import { decodeGraphId, type WayEdge } from "../src/jobs/traffic/ways-to-edges.js";
import { expireLiveTraffic, writeLiveTraffic } from "../src/jobs/traffic/write-live.js";

const [baseUrl, directory] = process.argv.slice(2);
if (!baseUrl || !directory || !["localhost", "127.0.0.1"].includes(new URL(baseUrl).hostname))
  throw new Error("Supply disposable loopback proof proxy URL and synthetic graph directory");
const ways = new Map<number, WayEdge[]>();
for (const line of (await readFile(join(directory, "tiles/way_edges.txt"), "utf8"))
  .trim()
  .split("\n")) {
  const cells = line.split(",");
  const edges: WayEdge[] = [];
  for (let i = 1; i + 1 < cells.length; i += 2)
    edges.push({ forward: cells[i] === "1", ...decodeGraphId(BigInt(cells[i + 1] ?? "")) });
  ways.set(Number(cells[0]), edges);
}
assert.deepEqual([...ways.keys()].sort(), [10, 20, 30, 40], "Refusing a non-synthetic graph");
// Only this disposable direct-service fixture bypasses the maintenance operation.
await writeFile(
  join(directory, "traffic-generations.json"),
  JSON.stringify({
    schemaVersion: 1,
    completedAt: new Date().toISOString(),
    graphGeneration: "1111111111111111111111111111111111111111111111111111111111111111",
    extractGeneration: "1111111111111111111111111111111111111111111111111111111111111111",
    waysToEdgesGeneration: "1111111111111111111111111111111111111111111111111111111111111111",
  }),
);
const state = await readTrafficGraphState(directory);
const graphGeneration = createHash("sha256")
  .update(JSON.stringify([state.generation, [...ways]]))
  .digest("hex");
const validUntil = new Date(Date.now() + 90_000).toISOString();
const event = fixtureEvent();
event.id = "synthetic-closure";
event.geometry = {
  type: "LineString",
  coordinates: [
    [13, 52],
    [13.02, 52],
  ],
};
assert.ok(event.routingEvidence);
Object.assign(event.routingEvidence, {
  source_checked_at: new Date().toISOString(),
  fresh_until: validUntil,
  evaluated_at: new Date().toISOString(),
  direction_mode: "forward",
});
const condition: BoundCondition = {
  id: event.id,
  source: event.source,
  routingEvidence: event.routingEvidence,
  type: event.type,
  roadState: "closed",
  speedLimitKph: null,
  vehiclesAffected: [],
  originKind: "feed",
  routingEligible: true,
  bindingStatus: "exact",
  segments: [{ wayId: 10, dir: "f", startFraction: 0, endFraction: 1, geometry: null }],
};
const overrides = new Map(
  JSON.parse(await readFile(join(directory, "probe-overrides.json"), "utf8")),
) as NonNullable<Parameters<typeof writeLiveTraffic>[0]["overrides"]>;
const deps = {
  tarPath: join(directory, "traffic.tar"),
  statePath: join(directory, "watchdog-state/live-state.json"),
  csv: "way_id,dir,current_kph,free_flow_kph,los\n",
  waysToEdges: ways,
};
setValhallaUrl(baseUrl);
const waypoints: [number, number][] = [
  [12.996, 52],
  [13.024, 52],
];
const baseline = await valhallaService.getRoute(waypoints, "driving", { useLiveTraffic: true });
const baselineRoute = baseline.routes[0];
assert.ok(baselineRoute);
assert.ok(baselineRoute.distance < 2000);
assert.equal(baselineRoute.trafficProof, undefined, "Startup clear cannot attest event actuation");
const writeId = randomUUID();
const result = await writeLiveTraffic({
  ...deps,
  overrides,
  validUntil,
  writeId,
  graphGeneration,
  engineBootId: state.engineBootId,
  expectedGraphGeneration: state.generation,
});
let snapshot: TrafficApplicationSnapshot = {
  schemaVersion: 1,
  mode: "active",
  providerId: "routing-valhalla",
  writeId,
  graphGeneration,
  engineBootId: state.engineBootId,
  policyRevision: "synthetic-policy",
  validUntil,
  writtenAt: new Date().toISOString(),
  observationIds: result.appliedObservationIds,
  resolverVersion: "r1",
  receipts: buildTrafficReceipts({
    conditions: [condition],
    overrides,
    appliedObservationIds: result.appliedObservationIds,
    graphGeneration,
    policyRevision: "synthetic-policy",
    validUntil,
  }),
};
assert.equal(snapshot.receipts.length, 1);
const app = Fastify();
const priorToken = process.env.DATA_MANAGER_AUTH_TOKEN;
const token = randomUUID();
process.env.DATA_MANAGER_AUTH_TOKEN = token;
registerAuth(app, token);
registerApi(app, { getTrafficConditionsApplied: () => snapshot });
const dmUrl = await app.listen({ host: "127.0.0.1", port: 0 });
let events: RoadConditionEvent[] = [event];
let policyRevision = "synthetic-policy";
const ctx = {
  getRequiredService: () => ({ url: dmUrl }),
  http: {
    get: async (url: string, opts: { headers: Record<string, string> }) => {
      const response = await fetch(url, { headers: opts.headers, cache: "no-store" });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response.json();
    },
  },
  getIntegrationsByDomain: () => [
    {
      providers: new Map([
        [
          "road-conditions",
          [
            {
              getEvents: async () => events,
              getRoutingEvents: async () => ({ complete: true, events }),
            },
          ],
        ],
      ]),
    },
  ],
  getDisallowedSourceIds: async () => new Set(),
  getRoadConditionsPolicySnapshot: async () => ({
    authoritative: true,
    revision: policyRevision,
    validUntil,
    disallowedSourceIds: [],
  }),
} as unknown as IntegrationContext;
const fallback = {
  availability: "unsupported" as const,
  evaluatedAt: new Date().toISOString(),
  validUntil: null,
  reasons: ["unverified_engine_application"],
};
try {
  assert.equal((await fetch(`${dmUrl}/traffic/conditions/applied`)).status, 401);
  // No retry: a proof must agree with the very first route after the durable write.
  const routed = await valhallaService.getRoute(waypoints, "driving", { useLiveTraffic: true });
  const routedRoute = routed.routes[0];
  assert.ok(routedRoute);
  assert.ok(
    routed.routes.every((r) => r.distance > 3000),
    "First attested route must avoid the real closure",
  );
  assert.equal(routedRoute.trafficProof?.writeId, writeId);
  assert.equal(
    (await verifyRouteTraffic(ctx, routed.routes, fallback, "routing-valhalla"))?.availability,
    "current",
  );
  assert.ok(valhallaService.optimizeRoute);
  const optimized = await valhallaService.optimizeRoute(waypoints, "driving", {
    useLiveTraffic: true,
  });
  assert.equal(optimized.routes[0]?.trafficProof?.endpoint, "optimized_route");
  assert.equal(
    (await verifyRouteTraffic(ctx, optimized.routes, fallback, "routing-valhalla"))?.availability,
    "current",
  );
  policyRevision = "changed";
  assert.notEqual(
    (await verifyRouteTraffic(ctx, routed.routes, fallback, "routing-valhalla"))?.availability,
    "current",
  );
  policyRevision = "synthetic-policy";
  events = [{ ...event, id: "unapplied", type: "roadworks", speedLimitKph: 30 }];
  assert.equal(
    (await verifyRouteTraffic(ctx, routed.routes, fallback, "routing-valhalla"))?.availability,
    "limited",
  );
  events = [event];
  snapshot = { ...snapshot, mode: "shadow" };
  assert.notEqual(
    (await verifyRouteTraffic(ctx, routed.routes, fallback, "routing-valhalla"))?.availability,
    "current",
  );
  snapshot = { ...snapshot, mode: "active", writeId: randomUUID() };
  assert.notEqual(
    (await verifyRouteTraffic(ctx, routed.routes, fallback, "routing-valhalla"))?.availability,
    "current",
  );
  for (const options of [
    { useLiveTraffic: false },
    { useLiveTraffic: true, departAt: new Date(Date.now() + 86400000).toISOString().slice(0, 16) },
  ]) {
    const route = await valhallaService.getRoute(waypoints, "driving", options);
    const first = route.routes[0];
    assert.ok(first);
    assert.equal(first.trafficProof, undefined);
    assert.ok(first.distance < 2000);
  }
  const capEvent: RoadConditionEvent = { ...event, type: "roadworks", speedLimitKph: 10 };
  const capCondition: BoundCondition = {
    ...condition,
    type: "roadworks",
    roadState: null,
    speedLimitKph: 10,
  };
  const capOverrides = new Map(
    [...overrides].map(([key, value]) => [
      key,
      {
        closed: false as const,
        capKph: 10,
        observationId: event.id,
        edge: value.edge,
      },
    ]),
  );
  const capWriteId = randomUUID();
  const capResult = await writeLiveTraffic({
    ...deps,
    csv: "way_id,dir,current_kph,free_flow_kph,los\n10,f,60,60,1\n",
    overrides: capOverrides,
    validUntil,
    writeId: capWriteId,
    graphGeneration,
    engineBootId: state.engineBootId,
    expectedGraphGeneration: state.generation,
  });
  snapshot = {
    ...snapshot,
    writeId: capWriteId,
    writtenAt: new Date().toISOString(),
    observationIds: capResult.appliedObservationIds,
    receipts: buildTrafficReceipts({
      conditions: [capCondition],
      overrides: capOverrides,
      appliedObservationIds: capResult.appliedObservationIds,
      graphGeneration,
      policyRevision: "synthetic-policy",
      validUntil,
    }),
  };
  assert.equal(snapshot.receipts[0]?.effect, "speed_cap");
  events = [capEvent];
  const capped = await valhallaService.getRoute(waypoints, "driving", { useLiveTraffic: true });
  const cappedRoute = capped.routes[0];
  assert.ok(cappedRoute);
  assert.ok(
    cappedRoute.duration > baselineRoute.duration,
    "Representable cap must affect actual route costing",
  );
  assert.equal(
    (await verifyRouteTraffic(ctx, capped.routes, fallback, "routing-valhalla"))?.availability,
    "current",
  );
  console.log(
    JSON.stringify({
      baselineMetres: baselineRoute.distance,
      attestedClosureMetres: routedRoute.distance,
      routeAndOptimizeCurrent: true,
      appliedSpeedCapCurrent: true,
      policyChangeShadowUnappliedCapWriteMismatchRejected: true,
      futureAndNoLiveUnaffected: true,
    }),
  );
} finally {
  await app.close();
  if (priorToken === undefined) delete process.env.DATA_MANAGER_AUTH_TOKEN;
  else process.env.DATA_MANAGER_AUTH_TOKEN = priorToken;
  await expireLiveTraffic({ ...deps, now: Date.now() + 120_001 });
}
