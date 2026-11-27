import {
  createFencedMemoryCache,
  createMockIntegrationContext,
} from "@openmapx/integration-framework/testing";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { afterEach, expect, it, vi } from "vitest";
import type { TransitOrchestrator } from "../orchestrator";
import { createRefreshSession } from "../refresh-session";
import { verifyRefreshHandle } from "../refresh-token";

const SECRET = "refresh-session-secret";
const START = Date.parse("2026-11-20T10:00:00Z");
const TTL_SECONDS = 15 * 60;

afterEach(() => {
  vi.useRealTimers();
});

const itinerary = {
  id: "itinerary-1",
  legs: [
    { mode: "walking", from: {}, to: {} },
    { mode: "walking", from: {}, to: {} },
  ],
} as unknown as TripItinerary;

it("never lets a refresh token outlive the state its cache write stored", async () => {
  vi.useFakeTimers({ now: START });
  const writes: Array<{ ttl: number | undefined; at: number }> = [];
  const ctx = createMockIntegrationContext({
    cache: {
      get: async () => null,
      set: async (_key, _value, ttl) => {
        writes.push({ ttl, at: Date.now() });
        // A slow cache round-trip: the state's lifetime starts before this returns.
        vi.setSystemTime(Date.now() + 5_000);
      },
      del: async () => {},
      withCache: async (_key, _ttl, load) => load(new AbortController().signal),
    },
  });
  const session = createRefreshSession(ctx, {} as TransitOrchestrator, SECRET);

  const token = await session.issueForSearch(itinerary, {
    integrationId: "transit-motis",
    providerId: "motis",
    instance: "primary",
    datasetEpoch: "epoch",
    requestFingerprint: "fingerprint",
    request: {} as never,
  });

  expect(writes).toEqual([{ ttl: TTL_SECONDS, at: START }]);
  const { exp } = verifyRefreshHandle(token ?? "", SECRET, START / 1000);
  expect(exp).toBe(START / 1000 + TTL_SECONDS);
});

it("issues a refresh token for any planner that declares refresh", async () => {
  const planner = (id: string, refresh: boolean) => ({
    id,
    prefix: `${id}:`,
    capabilities: { planningFeatures: { refresh } },
  });
  const ctx = createMockIntegrationContext({ id: "transit", cache: createFencedMemoryCache() });
  ctx.getIntegrationsByDomain = (domain) =>
    domain === "transit"
      ? ([
          {
            id: "transit-acme",
            manifest: {},
            providers: new Map([["transit", [planner("transit-acme", true)]]]),
          },
          {
            id: "transit-plain",
            manifest: {},
            providers: new Map([["transit", [planner("transit-plain", false)]]]),
          },
        ] as never)
      : [];
  const replanned = async (source: string) => {
    const orchestrator = {
      refreshTrip: async () => ({ status: "ok", result: { data: null } }),
      planTrip: async () => ({
        data: { source, datasetEpoch: "epoch", itineraries: [{ ...itinerary, source }] },
        attributions: [],
        freshness: {},
        planner: { integrationId: source, providerId: source },
      }),
    } as unknown as TransitOrchestrator;
    const session = createRefreshSession(ctx, orchestrator, SECRET);
    const token = await session.issueForSearch(itinerary, {
      integrationId: source,
      providerId: source,
      instance: source,
      datasetEpoch: "epoch",
      requestFingerprint: "fingerprint",
      request: {} as never,
    });
    const verified = session.verify(token);
    if (!verified.ok) throw new Error(verified.error);
    const outcome = await session.refresh(verified.id);
    return (outcome.body as { data: { itinerary: TripItinerary } }).data.itinerary.refreshToken;
  };
  expect(await replanned("transit-acme")).toEqual(expect.any(String));
  expect(await replanned("transit-plain")).toBeUndefined();
  const session = createRefreshSession(ctx, {} as TransitOrchestrator, SECRET);
  const named = (integrationId: string, providerId = integrationId) => ({
    integrationId,
    providerId,
  });
  expect(session.canRefresh(named("transit-acme"))).toBe(true);
  expect(session.canRefresh(named("transit-plain"))).toBe(false);
  expect(session.canRefresh(named("transit-motis", "transit-motis-local"))).toBe(false);
  // The provider id alone, or under another integration, names no planner.
  expect(session.canRefresh({ providerId: "transit-acme" })).toBe(false);
  expect(session.canRefresh(named("transit-plain", "transit-acme"))).toBe(false);
  expect(session.canRefresh(undefined)).toBe(false);
});

function twoRefreshingPlanners() {
  const planner = (id: string) => ({
    id,
    prefix: `${id}:`,
    capabilities: { planningFeatures: { refresh: true } },
  });
  const ctx = createMockIntegrationContext({ id: "transit", cache: createFencedMemoryCache() });
  ctx.getIntegrationsByDomain = (domain) =>
    domain === "transit"
      ? ([
          {
            id: "transit-acme",
            manifest: {},
            providers: new Map([["transit", [planner("transit-acme")]]]),
          },
          {
            id: "transit-other",
            manifest: {},
            providers: new Map([["transit", [planner("transit-other")]]]),
          },
        ] as never)
      : [];
  return ctx;
}

it("binds the token of a replanned itinerary to the planner that replanned it", async () => {
  const ctx = twoRefreshingPlanners();
  const refreshCalls: Array<[string, { itineraryId: string; datasetEpoch: string }]> = [];
  const orchestrator = {
    refreshTrip: vi.fn(async (planner: { providerId: string }, params) => {
      refreshCalls.push([planner.providerId, params]);
      return { status: "gone", result: { data: null } };
    }),
    planTrip: async () => ({
      data: {
        source: "transit-other",
        instance: "other-instance",
        datasetEpoch: "other-epoch",
        itineraries: [{ ...itinerary, id: "other-itin-9", source: "transit-other" }],
      },
      attributions: [],
      freshness: {},
      planner: { integrationId: "transit-other", providerId: "transit-other" },
    }),
  } as unknown as TransitOrchestrator;
  const session = createRefreshSession(ctx, orchestrator, SECRET);
  const redeem = async (token: string | undefined) => {
    const verified = session.verify(token);
    if (!verified.ok) throw new Error(verified.error);
    const outcome = await session.refresh(verified.id);
    return (outcome.body as { data: { itinerary: TripItinerary } }).data.itinerary.refreshToken;
  };

  const issued = await session.issueForSearch(itinerary, {
    integrationId: "transit-acme",
    providerId: "transit-acme",
    instance: "acme-instance",
    datasetEpoch: "acme-epoch",
    requestFingerprint: "fingerprint",
    request: {} as never,
  });
  const replannedToken = await redeem(issued);
  expect(replannedToken).toEqual(expect.any(String));
  await redeem(replannedToken);

  expect(refreshCalls.map(([providerId, params]) => [providerId, params.itineraryId])).toEqual([
    ["transit-acme", "itinerary-1"],
    ["transit-other", "other-itin-9"],
  ]);
  expect(refreshCalls[1]?.[1].datasetEpoch).toBe("other-epoch");
});

it("issues no token for a replanned itinerary whose planner names no dataset epoch", async () => {
  const ctx = twoRefreshingPlanners();
  const orchestrator = {
    refreshTrip: async () => ({ status: "gone", result: { data: null } }),
    planTrip: async () => ({
      data: { source: "transit-other", itineraries: [{ ...itinerary, source: "transit-other" }] },
      attributions: [],
      freshness: {},
      planner: { integrationId: "transit-other", providerId: "transit-other" },
    }),
  } as unknown as TransitOrchestrator;
  const session = createRefreshSession(ctx, orchestrator, SECRET);
  const issued = await session.issueForSearch(itinerary, {
    integrationId: "transit-acme",
    providerId: "transit-acme",
    instance: "acme-instance",
    datasetEpoch: "acme-epoch",
    requestFingerprint: "fingerprint",
    request: {} as never,
  });
  const verified = session.verify(issued);
  if (!verified.ok) throw new Error(verified.error);
  const outcome = await session.refresh(verified.id);
  expect(outcome.status).toBe(200);
  expect(
    (outcome.body as { data: { itinerary: TripItinerary } }).data.itinerary.refreshToken,
  ).toBeUndefined();
});

it("keeps a refreshed itinerary's next token on the planner that issued the first", async () => {
  const ctx = twoRefreshingPlanners();
  const refreshCalls: string[] = [];
  const orchestrator = {
    refreshTrip: async (
      planner: { integrationId: string; providerId: string },
      params: { itineraryId: string },
    ) => {
      refreshCalls.push(`${planner.integrationId}/${planner.providerId}:${params.itineraryId}`);
      // An answer that names another source must not move the token there.
      return {
        status: "ok",
        result: {
          data: { ...itinerary, id: "acme-itin-2", source: "transit-other" },
          attributions: [],
          freshness: {},
        },
      };
    },
    planTrip: vi.fn(),
  } as unknown as TransitOrchestrator;
  const session = createRefreshSession(ctx, orchestrator, SECRET);
  let token = await session.issueForSearch(itinerary, {
    integrationId: "transit-acme",
    providerId: "transit-acme",
    instance: "acme-instance",
    datasetEpoch: "acme-epoch",
    requestFingerprint: "fingerprint",
    request: {} as never,
  });
  for (let round = 0; round < 2; round++) {
    const verified = session.verify(token);
    if (!verified.ok) throw new Error(verified.error);
    const outcome = await session.refresh(verified.id);
    token = (outcome.body as { data: { itinerary: TripItinerary } }).data.itinerary.refreshToken;
  }
  expect(refreshCalls).toEqual([
    "transit-acme/transit-acme:itinerary-1",
    "transit-acme/transit-acme:acme-itin-2",
  ]);
});
