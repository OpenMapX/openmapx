import type { QuotaDecision, UpstreamRuntime } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import {
  createDirectionsResult,
  createRoutingHandlerEnvironment,
  createRoutingTestReply,
} from "./support/routing-handler-contract.js";

const WAYPOINTS = "0.1,51.1;0.2,51.2";

function fakeRuntime(limitPerBucket: number, options: { unavailable?: boolean } = {}) {
  const used = new Map<string, number>();
  const consumeQuota = vi.fn(
    async (input: { bucket: string; cost: number }): Promise<QuotaDecision> => {
      if (options.unavailable) {
        return { allowed: false, remaining: {}, retryAt: null, diagnostic: "store_unavailable" };
      }
      const current = used.get(input.bucket) ?? 0;
      if (current + input.cost > limitPerBucket) {
        return { allowed: false, remaining: {}, retryAt: Date.now() + 42_000 };
      }
      used.set(input.bucket, current + input.cost);
      return { allowed: true, remaining: {}, retryAt: null };
    },
  );
  return {
    consumeQuota,
    runtime: { consumeQuota } as unknown as UpstreamRuntime,
  };
}

function provider(integrationId: string, priority: number) {
  const getRoute = vi.fn(async () => createDirectionsResult());
  const optimizeRoute = vi.fn(async () => createDirectionsResult());
  return {
    getRoute,
    optimizeRoute,
    fixture: { integrationId, providerId: integrationId, priority, getRoute, optimizeRoute },
  };
}

describe("routing provider admission", () => {
  it("answers 429 and never calls the engine once its shared budget is spent", async () => {
    const engine = provider("routing-valhalla", 1);
    const { runtime, consumeQuota } = fakeRuntime(2);
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [engine.fixture],
      contextOverrides: { upstreamRuntime: runtime },
    });
    const directions = environment.getHandler("/directions");

    const replies = [];
    for (let index = 0; index < 3; index += 1) {
      const reply = createRoutingTestReply();
      await directions({ query: { waypoints: WAYPOINTS, mode: "driving" } }, reply);
      replies.push(reply);
    }

    expect(replies.map((reply) => reply.code)).toEqual([200, 200, 429]);
    expect(engine.getRoute).toHaveBeenCalledTimes(2);
    expect(replies[2]?.header).toHaveBeenCalledWith("Retry-After", "42");
    expect(consumeQuota).toHaveBeenLastCalledWith({
      bucket: "routing-provider:routing-valhalla",
      cost: 1,
      windows: [
        { id: "minute", limit: 600, durationMs: 60_000 },
        { id: "day", limit: 100_000, durationMs: 86_400_000 },
      ],
    });
  });

  it("refuses with 503 and never calls the engine when the shared store is unavailable", async () => {
    const engine = provider("routing-valhalla", 1);
    const { runtime } = fakeRuntime(10, { unavailable: true });
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [engine.fixture],
      contextOverrides: { upstreamRuntime: runtime },
    });
    const reply = createRoutingTestReply();

    await environment.getHandler("/directions")(
      { query: { waypoints: WAYPOINTS, mode: "driving" } },
      reply,
    );

    expect(reply.code).toBe(503);
    expect(engine.getRoute).not.toHaveBeenCalled();
  });

  it("falls through to the next engine when the preferred one is over budget", async () => {
    const preferred = provider("routing-valhalla", 1);
    const fallback = provider("routing-osrm", 2);
    const { runtime } = fakeRuntime(0);
    const consumeQuota = vi.fn(async (input: { bucket: string }) =>
      input.bucket === "routing-provider:routing-osrm"
        ? { allowed: true, remaining: {}, retryAt: null }
        : runtime.consumeQuota({ bucket: input.bucket, cost: 1, windows: [] }),
    );
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [preferred.fixture, fallback.fixture],
      contextOverrides: { upstreamRuntime: { consumeQuota } as unknown as UpstreamRuntime },
    });
    const reply = createRoutingTestReply();

    await environment.getHandler("/directions")(
      { query: { waypoints: WAYPOINTS, mode: "driving" } },
      reply,
    );

    expect(reply.code).toBe(200);
    expect(preferred.getRoute).not.toHaveBeenCalled();
    expect(fallback.getRoute).toHaveBeenCalledOnce();
  });

  it("applies operator limits and admits optimize calls too", async () => {
    const engine = provider("routing-valhalla", 1);
    const { runtime, consumeQuota } = fakeRuntime(1);
    const environment = createRoutingHandlerEnvironment({
      routingProviders: [engine.fixture],
      contextOverrides: {
        upstreamRuntime: runtime,
        config: { providerRequestsPerMinute: 5, providerRequestsPerDay: 50 },
      },
    });
    const optimize = environment.getHandler("/directions/optimize");
    const first = createRoutingTestReply();
    const second = createRoutingTestReply();

    await optimize({ query: { waypoints: `${WAYPOINTS};0.3,51.3`, mode: "driving" } }, first);
    await optimize({ query: { waypoints: `${WAYPOINTS};0.4,51.4`, mode: "driving" } }, second);

    expect([first.code, second.code]).toEqual([200, 429]);
    expect(engine.optimizeRoute).toHaveBeenCalledOnce();
    expect(consumeQuota.mock.calls[0]?.[0]).toMatchObject({
      windows: [
        { id: "minute", limit: 5 },
        { id: "day", limit: 50 },
      ],
    });
  });
});
