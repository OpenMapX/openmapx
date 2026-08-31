import { RoutingProviderError } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import type { DirectionsResult } from "../types.js";
import {
  closureRoutingContract,
  createDirectionsResult,
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

const WAYPOINTS_QUERY = "0.1,51.1;0.2,51.2";

describe("/directions handler — avoidClosures=true with active closures", () => {
  it("filters the chain to exclusion-capable providers", async () => {
    const fallbackSpy = vi.fn(async () => createDirectionsResult());
    const capableSpy = vi.fn(async () => createDirectionsResult());
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-fallback",
          providerId: "engine-a",
          priority: 20,
          getRoute: fallbackSpy,
        },
        {
          integrationId: "routing-closure-aware",
          providerId: "engine-b",
          priority: 10,
          supportsExclusions: true,
          getRoute: capableSpy,
        },
      ],
      closurePoints: [[0.15, 51.15]],
    });

    const reply = createRoutingTestReply();
    await environment.getHandler("/directions")(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    expect(capableSpy).toHaveBeenCalledOnce();
    expect(fallbackSpy).not.toHaveBeenCalled();
  });

  it("maps a provider capability failure to 503 without naming an engine", async () => {
    const providerSpy = vi.fn(async () => {
      throw new RoutingProviderError(
        "unsupported-exclusions",
        "provider cannot represent this exclusion geometry",
      );
    });
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-closure-aware",
          providerId: "engine-b",
          supportsExclusions: true,
          getRoute: providerSpy,
        },
      ],
      closurePoints: [[0.15, 51.15]],
    });

    const reply = createRoutingTestReply();
    await environment.getHandler("/directions")(
      { query: { waypoints: WAYPOINTS_QUERY, avoidClosures: "true" } },
      reply,
    );

    expect(reply.code).toBe(503);
    expect(reply.body).toEqual({ error: "Closure avoidance unavailable for this route" });
  });
});

describe("/directions handler — routing metrics", () => {
  it("records provider latency and route-level alternate/baseline values", async () => {
    const metricsRecorder = {
      recordProviderCall: vi.fn(),
      recordRoutingRequest: vi.fn(),
    };
    const valhallaSpy = vi.fn(async () =>
      createDirectionsResult([
        { duration: 600, baselineDuration: 500 } as DirectionsResult["routes"][number],
        { duration: 700, baselineDuration: 650 } as DirectionsResult["routes"][number],
        { duration: 800, baselineDuration: 750 } as DirectionsResult["routes"][number],
      ]),
    );
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [
        {
          integrationId: "routing-preferred",
          providerId: "engine-b",
          priority: 10,
          supportsExclusions: true,
          getRoute: valhallaSpy,
        },
      ],
      metricsRecorder,
    });

    const reply = createRoutingTestReply();
    await environment.getHandler("/directions")({ query: { waypoints: WAYPOINTS_QUERY } }, reply);

    expect(metricsRecorder.recordProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "routing-preferred",
        method: "getRoute",
        outcome: "ok",
      }),
      expect.any(Number),
    );
    expect(metricsRecorder.recordRoutingRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "routing-preferred",
        operation: "directions",
        outcome: "ok",
        routeCount: 3,
        alternateCount: 2,
        trafficDelaySeconds: 100,
        baselineAvailable: true,
      }),
    );
  });
});

closureRoutingContract({
  name: "directions",
  path: "/directions",
  operation: "directions",
  waypointsQuery: WAYPOINTS_QUERY,
});
