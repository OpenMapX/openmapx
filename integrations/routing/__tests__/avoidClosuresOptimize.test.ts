import { expect, it, vi } from "vitest";
import {
  closureRoutingContract,
  createDirectionsResult,
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

const WAYPOINTS_QUERY = "0.1,51.1;0.2,51.2;0.3,51.3";

it("returns 503 when closure avoidance is requested but no optimizer supports exclusions", async () => {
  const optimizeSpy = vi.fn(async () => createDirectionsResult());
  const environment = createRoutingHandlerEnvironment({
    routingProviders: [
      {
        integrationId: "routing-fallback",
        providerId: "engine-a",
        getRoute: vi.fn(async () => createDirectionsResult()),
        optimizeRoute: optimizeSpy,
      },
    ],
    closurePoints: [[0.15, 51.15]],
  });
  const reply = createRoutingTestReply();

  await environment.getHandler("/directions/optimize")(
    { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
    reply,
  );

  expect(reply.code).toBe(503);
  expect(optimizeSpy).not.toHaveBeenCalled();
});

it("re-evaluates the protected request through the next capable optimizer after failure", async () => {
  const failing = vi.fn(async () => {
    throw new Error("first optimizer unavailable");
  });
  const succeeding = vi.fn(async () => createDirectionsResult());
  const environment = createRoutingHandlerEnvironment({
    routingProviders: [
      {
        integrationId: "routing-first",
        providerId: "engine-a",
        priority: 10,
        supportsExclusions: true,
        getRoute: vi.fn(async () => createDirectionsResult()),
        optimizeRoute: failing,
      },
      {
        integrationId: "routing-second",
        providerId: "engine-b",
        priority: 20,
        supportsExclusions: true,
        getRoute: vi.fn(async () => createDirectionsResult()),
        optimizeRoute: succeeding,
      },
    ],
    closurePoints: [[0.15, 51.15]],
  });
  const reply = createRoutingTestReply();

  await environment.getHandler("/directions/optimize")(
    { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
    reply,
  );

  expect(reply.code).toBe(200);
  expect(failing).toHaveBeenCalledOnce();
  expect(succeeding).toHaveBeenCalledOnce();
  expect(succeeding.mock.calls[0]?.[2]).toMatchObject({
    excludeLocations: [[0.15, 51.15]],
  });
  expect(reply.body).toMatchObject({ provider: "routing-second" });
});

closureRoutingContract({
  name: "route optimization",
  path: "/directions/optimize",
  operation: "optimize",
  waypointsQuery: WAYPOINTS_QUERY,
});
