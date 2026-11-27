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
        data: { itineraries: [{ ...itinerary, source }] },
        attributions: [],
        freshness: {},
      }),
    } as unknown as TransitOrchestrator;
    const session = createRefreshSession(ctx, orchestrator, SECRET);
    const token = await session.issueForSearch(itinerary, {
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
  expect(session.canRefresh("transit-acme")).toBe(true);
  expect(session.canRefresh("transit-plain")).toBe(false);
  expect(session.canRefresh("transit-motis-local")).toBe(false);
  expect(session.canRefresh(undefined)).toBe(false);
});
