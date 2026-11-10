import { Readable } from "node:stream";
import type { SharedRequestDecision } from "@openmapx/integration-framework";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uniformErrorHandler } from "../../server-wiring.js";
import {
  createProviderDailyBudget,
  maptilerDailyBudget,
  type ProviderDailyBudget,
  sendProviderBudgetRefusal,
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

function budgetAllowing(
  limit: number,
  whenStoreUnavailable: "refuse" | "meter-locally" = "refuse",
): {
  budget: ProviderDailyBudget;
  admitSharedRequest: ReturnType<typeof vi.fn>;
} {
  const admission = sharedAdmission((count) =>
    count <= limit
      ? { allowed: true, remaining: limit - count }
      : { allowed: false, reason: "quota", retryAfterMs: 3_600_500 },
  );
  return {
    budget: createProviderDailyBudget({ provider: "test", limit, admission, whenStoreUnavailable }),
    admitSharedRequest: admission.admitSharedRequest,
  };
}

function unavailableBudget(limit: number, whenStoreUnavailable: "refuse" | "meter-locally") {
  return createProviderDailyBudget({
    provider: "test",
    limit,
    admission: sharedAdmission(() => ({
      allowed: false,
      reason: "store_unavailable",
      retryAfterMs: null,
    })),
    whenStoreUnavailable,
  });
}

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
    const budget = createProviderDailyBudget({
      provider: "maptiler",
      limit: 3_300,
      admission,
      whenStoreUnavailable: "refuse",
    });

    expect(await budget.admit()).toEqual({ allowed: true });
    expect(admission.admitSharedRequest).toHaveBeenCalledWith({
      scope: "provider-daily-budget",
      key: "maptiler",
      policy: { id: "daily", limit: 3_300, durationMs: 86_400_000, minIntervalMs: 0 },
    });
  });

  it("meters nothing when no shared store is configured", async () => {
    const budget = createProviderDailyBudget({
      provider: "maptiler",
      limit: 1,
      admission: null,
      whenStoreUnavailable: "refuse",
    });
    expect(await budget.admit()).toEqual({ allowed: true });
    expect(await budget.admit()).toEqual({ allowed: true });
  });

  it("leaves MapTiler without a global budget unless the operator sets one", () => {
    vi.stubEnv("MAPTILER_DAILY_REQUEST_LIMIT", "");
    expect(maptilerDailyBudget()).toBeNull();
    vi.stubEnv("MAPTILER_DAILY_REQUEST_LIMIT", "0");
    expect(maptilerDailyBudget()).toBeNull();
    vi.stubEnv("MAPTILER_DAILY_REQUEST_LIMIT", "100000");
    expect(maptilerDailyBudget()).not.toBeNull();
  });

  it("marks only the first refusal of a spent window, and logs only that one", async () => {
    const { budget } = budgetAllowing(1);
    await budget.admit();
    const refusals = [await budget.admit(), await budget.admit(), await budget.admit()];
    const warn = vi.fn();
    const reply = { header: vi.fn(), status: () => ({ send: vi.fn() }) };

    for (const refusal of refusals) {
      if (refusal.allowed) throw new Error("expected a refusal");
      sendProviderBudgetRefusal(reply, refusal, "MapTiler", { warn });
    }

    expect(refusals.map((refusal) => !refusal.allowed && refusal.firstRefusalInWindow)).toEqual([
      true,
      false,
      false,
    ]);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "provider.daily-budget-spent",
      provider: "MapTiler",
    });
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
      instance.register(trafficRoute, { budget: unavailableBudget(10, "refuse") }),
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

  it("keeps serving and meters in process when the shared store is unavailable", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2]), {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { maptilerRoute } = await import("../maptiler.js");
    const app = await appWith((instance) =>
      instance.register(maptilerRoute, { budget: unavailableBudget(2, "meter-locally") }),
    );

    const codes: number[] = [];
    for (const y of [0, 1, 0]) {
      codes.push((await app.inject({ url: `/maptiler/tiles/v3/1/0/${y}.pbf` })).statusCode);
    }

    expect(codes).toEqual([200, 200, 429]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("serves without any global budget when none is configured", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubEnv("MAPTILER_DAILY_REQUEST_LIMIT", "");
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: { "content-type": "application/x-protobuf" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { maptilerRoute } = await import("../maptiler.js");
    const app = await appWith((instance) => instance.register(maptilerRoute));

    for (let y = 0; y < 3; y += 1) {
      expect((await app.inject({ url: `/maptiler/tiles/v3/1/0/${y % 2}.pbf` })).statusCode).toBe(
        200,
      );
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await app.close();
  });
});
