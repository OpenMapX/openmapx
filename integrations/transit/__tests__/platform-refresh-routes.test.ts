import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setup } from "../index";
import { signRefreshHandle } from "../refresh-token";

const orchestrator = vi.hoisted(() => ({
  getVehicleJourney: vi.fn(),
  enrichJourneyPlatforms: vi.fn(),
  refreshTrip: vi.fn(),
  planTrip: vi.fn(),
}));
vi.mock("../orchestrator", async (original) => ({
  ...(await original<object>()),
  createTransitOrchestrator: () => orchestrator,
}));
function fixture() {
  const values = new Map<string, unknown>();
  const ctx = createMockIntegrationContext({
    cache: {
      get: async (key) => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
      },
      del: async (key) => {
        values.delete(key);
      },
      withCache: async (key, _ttl, load) => {
        if (!values.has(key)) values.set(key, await load(new AbortController().signal));
        return values.get(key) as never;
      },
    },
  });
  vi.stubEnv("BETTER_AUTH_SECRET", "route-test-secret");
  setup(ctx);
  const call = async (path: string, req: unknown) => {
    let body: unknown;
    let status = 200;
    const reply = {
      status: (code: number) => {
        status = code;
        return reply;
      },
      header: () => reply,
      send: (value: unknown) => {
        body = value;
        return reply;
      },
    };
    const route = ctx.registered.routes.find((r) => r.path === path);
    if (!route) throw new Error("missing route");
    await route.handler(req as never, reply as never);
    return { status, body };
  };
  return { values, call, ctx };
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());
it("enriches after a baseline cache hit so disabling a source takes effect", async () => {
  const f = fixture();
  const base = { data: { id: "trip", stops: [] }, attributions: [], freshness: {} };
  let enabled = true;
  orchestrator.getVehicleJourney.mockResolvedValue(base);
  orchestrator.enrichJourneyPlatforms.mockImplementation(async (value) =>
    enabled ? { ...value, data: { ...value.data, platform: "3" } } : value,
  );
  expect(
    (await f.call("/vehicles/:id", { params: { id: "trip" }, query: {} })).body,
  ).toHaveProperty("data.platform", "3");
  enabled = false;
  expect(
    (await f.call("/vehicles/:id", { params: { id: "trip" }, query: {} })).body,
  ).not.toHaveProperty("data.platform");
  expect(orchestrator.getVehicleJourney).toHaveBeenCalledTimes(1);
  expect(orchestrator.enrichJourneyPlatforms).toHaveBeenCalledTimes(2);
});
it("retains a bound handle after 503, then replays its exact successor", async () => {
  const f = fixture();
  const id = "verified-state";
  f.values.set(`transit-refresh:${id}`, {
    providerId: "local",
    instance: "local",
    datasetEpoch: "epoch",
    itineraryId: "original",
    requestFingerprint: "fingerprint",
    request: { modes: ["rail"] },
  });
  const token = signRefreshHandle(id, "route-test-secret", Math.floor(Date.now() / 1000) + 600);
  orchestrator.refreshTrip.mockResolvedValueOnce({ status: "unavailable" }).mockResolvedValue({
    status: "ok",
    result: {
      data: {
        id: "next",
        source: "transit-motis-local",
        legs: [{ mode: "rail", from: { stopId: "a" }, to: { stopId: "b" } }],
      },
      attributions: [],
      freshness: {},
    },
  });
  expect((await f.call("/plan/refresh", { body: { token } })).status).toBe(503);
  expect(f.values.has(`transit-refresh:${id}`)).toBe(true);
  const success = await f.call("/plan/refresh", { body: { token } });
  expect(success.status).toBe(200);
  expect(success.body).toHaveProperty("data.itinerary.refreshToken");
  expect(f.values.has(`transit-refresh:${id}`)).toBe(false);
  expect(await f.call("/plan/refresh", { body: { token } })).toEqual(success);
  expect(orchestrator.refreshTrip).toHaveBeenCalledTimes(2);
});

it("gates a cached response by its declared provider sources without exposing the binding", async () => {
  const f = fixture();
  let disabled = false;
  Object.assign(f.ctx, {
    getDisallowedSourceIds: async () => new Set(disabled ? ["source"] : []),
    getIntegrationsByDomain: () => [
      {
        manifest: { dataSources: [{ sourceId: "source" }] },
        providers: new Map([["transit", [{ id: "local", prefix: "ms:" }]]]),
      },
    ],
  });
  f.values.set("transit-refresh:policy", {
    providerId: "local",
    instance: "ms",
    datasetEpoch: "e",
    itineraryId: "original",
    requestFingerprint: "f",
    request: { modes: ["rail"] },
  });
  const token = signRefreshHandle(
    "policy",
    "route-test-secret",
    Math.floor(Date.now() / 1000) + 600,
  );
  orchestrator.refreshTrip.mockResolvedValue({
    status: "ok",
    result: {
      data: {
        id: "next",
        source: "transit-motis-local",
        legs: [{ mode: "rail", from: { stopId: "a" }, to: { stopId: "b" } }],
      },
      attributions: [],
      freshness: {},
    },
  });
  const success = await f.call("/plan/refresh", { body: { token } });
  expect(success.status).toBe(200);
  expect(success.body).not.toHaveProperty("sourceIds");
  disabled = true;
  expect((await f.call("/plan/refresh", { body: { token } })).status).toBe(409);
  expect(orchestrator.refreshTrip).toHaveBeenCalledTimes(1);
});
