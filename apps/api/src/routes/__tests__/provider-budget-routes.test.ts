import { Readable } from "node:stream";
import type { SharedRequestDecision } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uniformErrorHandler } from "../../server-wiring.js";
import {
  createProviderDailyBudget,
  type ProviderDailyBudget,
} from "../../services/provider-daily-budget.js";

const getFlowTile = vi.hoisted(() => vi.fn());
vi.mock("../../services/traffic.factory.js", () => ({
  getTrafficProvider: () => ({ getFlowTile }),
}));
vi.mock("../../db/index.js", () => ({
  db: { select: () => ({ from: async () => [] }) },
}));
vi.mock("../../db/schema.js", () => ({ systemSettings: {} }));

function sharedAdmission(decide: (count: number) => SharedRequestDecision) {
  let count = 0;
  const admitSharedRequest = vi.fn(async () => decide(++count));
  return { admitSharedRequest };
}

function budgetAllowing(limit: number): {
  budget: ProviderDailyBudget;
  admitSharedRequest: ReturnType<typeof vi.fn>;
} {
  const admission = sharedAdmission((count) =>
    count <= limit
      ? { allowed: true, remaining: limit - count }
      : { allowed: false, reason: "quota", retryAfterMs: 3_600_500 },
  );
  return {
    budget: createProviderDailyBudget({ provider: "test", limit, admission }),
    admitSharedRequest: admission.admitSharedRequest,
  };
}

const unavailableBudget = createProviderDailyBudget({
  provider: "test",
  limit: 10,
  admission: sharedAdmission(() => ({
    allowed: false,
    reason: "store_unavailable",
    retryAfterMs: null,
  })),
});

async function appWith(
  register: (app: FastifyInstance) => PromiseLike<unknown>,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler(uniformErrorHandler);
  await register(app);
  await app.ready();
  return app;
}

afterEach(() => {
  getFlowTile.mockReset();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("provider daily budget", () => {
  it("asks the shared admission for one daily budget per provider", async () => {
    const admission = sharedAdmission(() => ({ allowed: true, remaining: 1 }));
    const budget = createProviderDailyBudget({ provider: "maptiler", limit: 3_300, admission });

    expect(await budget.admit()).toEqual({ allowed: true });
    expect(admission.admitSharedRequest).toHaveBeenCalledWith({
      scope: "provider-daily-budget",
      key: "maptiler",
      policy: { id: "daily", limit: 3_300, durationMs: 86_400_000, minIntervalMs: 0 },
    });
  });

  it("meters nothing when no shared store is configured", async () => {
    const budget = createProviderDailyBudget({ provider: "maptiler", limit: 1, admission: null });
    expect(await budget.admit()).toEqual({ allowed: true });
    expect(await budget.admit()).toEqual({ allowed: true });
  });
});

describe("TomTom traffic tiles under the daily budget", () => {
  it("answers 429 once the budget is spent and never calls TomTom", async () => {
    getFlowTile.mockImplementation(async () => ({
      body: Readable.from([Buffer.from([1])]),
      contentType: "image/png",
    }));
    const { budget } = budgetAllowing(1);
    const { trafficRoute } = await import("../traffic.js");
    const app = await appWith((instance) => instance.register(trafficRoute, { budget }));

    const first = await app.inject({ url: "/traffic/flow/10/1/1.png" });
    const refused = await app.inject({ url: "/traffic/flow/10/1/2.png" });

    expect(first.statusCode).toBe(200);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("3601");
    expect(refused.headers["cache-control"]).toBe("no-store");
    expect(getFlowTile).toHaveBeenCalledOnce();
    await app.close();
  });

  it("refuses with 503 when the shared store is unavailable", async () => {
    const { trafficRoute } = await import("../traffic.js");
    const app = await appWith((instance) =>
      instance.register(trafficRoute, { budget: unavailableBudget }),
    );

    const refused = await app.inject({ url: "/traffic/flow/10/1/1.png" });

    expect(refused.statusCode).toBe(503);
    expect(getFlowTile).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("MapTiler proxy under the daily budget", () => {
  it("answers 429 once the budget is spent and never calls MapTiler", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { budget } = budgetAllowing(1);
    const { maptilerRoute } = await import("../maptiler.js");
    const app = await appWith((instance) => instance.register(maptilerRoute, { budget }));

    const first = await app.inject({ url: "/maptiler/tiles/v3/1/0/0.pbf" });
    const refused = await app.inject({ url: "/maptiler/tiles/v3/1/0/1.pbf" });

    expect(first.statusCode).toBe(200);
    expect(refused.statusCode).toBe(429);
    expect(fetchMock).toHaveBeenCalledOnce();
    await app.close();
  });

  it("refuses with 503 when the shared store is unavailable", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { maptilerRoute } = await import("../maptiler.js");
    const app = await appWith((instance) =>
      instance.register(maptilerRoute, { budget: unavailableBudget }),
    );

    const refused = await app.inject({ url: "/maptiler/tiles/v3/1/0/0.pbf" });

    expect(refused.statusCode).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    await app.close();
  });
});
