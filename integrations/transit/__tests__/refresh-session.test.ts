import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
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
