import { createTransitOrchestrator } from "@integrations/transit/orchestrator";
import type { IntegrationContext, TransitProvider } from "@openmapx/integration-framework";
import type Redis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { ProviderHealth, type ProviderHealthState } from "../index.js";

/**
 * In-memory Redis double. The Lua transition is a spy so any recorded outcome
 * is visible; the probe release runs the same compare-and-delete as its script.
 */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly transitions = vi.fn(async () => "");

  defineCommand(name: string): void {
    (this as unknown as Record<string, unknown>)[name] =
      name === "providerHealthReleaseProbe"
        ? async (key: string, token: string) => {
            if (this.store.get(key) !== token) return 0;
            this.store.delete(key);
            return 1;
          }
        : this.transitions;
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<"OK" | null> {
    if (args.includes("NX") && this.store.has(key)) return null;
    this.store.set(key, value);
    return "OK";
  }
}

const NOW = 1_700_000_000_000;

function openCircuit(retryAt: number): ProviderHealthState {
  return {
    schema: 2,
    state: "open",
    successCount: 3,
    failureCount: 5,
    countedFailureCount: 5,
    consecutiveSuccesses: 0,
    consecutiveFailures: 5,
    reopenCount: 0,
    emaLatencyMs: 120,
    window: [{ outcome: "error", at: new Date(NOW - 60_000).toISOString(), latencyMs: 120 }],
    lastSuccessAt: null,
    lastFailureAt: new Date(NOW - 60_000).toISOString(),
    lastFailureOutcome: "auth",
    lastOperatorMessage: "credential rejected",
    retryAt: new Date(retryAt).toISOString(),
  };
}

function hangingSearch(id: string): TransitProvider {
  return {
    id,
    prefix: `${id}:`,
    coverage: { all: true },
    priority: 5,
    role: "regional",
    attribution: [{ sourceId: id, name: id }],
    capabilities: {
      stops: {
        lookup: false,
        nearby: false,
        bbox: false,
        search: true,
        infrastructure: false,
        platforms: false,
        timetable: false,
      },
      departures: false,
      arrivals: false,
      routes: { lookup: false, forStop: false, stops: false, geometry: false },
      planning: false,
      vehicleJourney: false,
    },
    healthCheck: async () => ({ healthy: true }),
    searchStopsByName: vi.fn(() => new Promise<never>(() => {})),
  } as unknown as TransitProvider;
}

describe("caller cancellation and provider health", () => {
  it("releases a cancelled half-open probe's lease without recording any outcome", async () => {
    const redis = new FakeRedis();
    const health = await ProviderHealth.init({
      redis: redis as unknown as Redis,
      now: () => NOW,
    });
    redis.store.set("provider:health:probe", JSON.stringify(openCircuit(NOW - 1)));
    const provider = hangingSearch("probe");
    const transit = createTransitOrchestrator({
      providerHealth: health,
      metricsRecorder: { recordProviderCall: vi.fn() },
      getDisallowedSourceIds: async () => new Set<string>(),
      getIntegrationsByDomain: (domain: string) =>
        domain === "transit"
          ? [
              {
                manifest: { dataSources: [{ sourceId: "probe" }] },
                providers: new Map([["transit", [provider]]]),
              },
            ]
          : [],
    } as unknown as IntegrationContext);
    const before = redis.store.get("provider:health:probe");

    const controller = new AbortController();
    const search = transit.searchByNameRaw("Cen", 10, undefined, {
      signal: controller.signal,
      deadlineAt: NOW + 5_000,
    });
    await vi.waitFor(() => expect(provider.searchStopsByName).toHaveBeenCalled());
    // This request owns the half-open probe lease.
    expect(redis.store.has("provider:health-probe:probe")).toBe(true);
    controller.abort();
    await expect(search).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redis.transitions).not.toHaveBeenCalled();
    expect(redis.store.get("provider:health:probe")).toBe(before);
    expect(redis.store.has("provider:health-probe:probe")).toBe(false);
    expect(health.heldProbe("probe")).toBeUndefined();
    // The next request can probe at once, and the circuit's history is intact.
    const snapshot = await health.getSnapshot("probe");
    expect(snapshot).toMatchObject({
      state: "half-open",
      ownsHalfOpenProbe: true,
      failureCount: 5,
      lastFailureOutcome: "auth",
      lastOperatorMessage: "credential rejected",
      emaLatencyMs: 120,
    });
  });

  it("never releases a lease another owner holds", async () => {
    const redis = new FakeRedis();
    const health = await ProviderHealth.init({
      redis: redis as unknown as Redis,
      now: () => NOW,
    });
    redis.store.set("provider:health:probe", JSON.stringify(openCircuit(NOW - 1)));
    expect(await health.isHealthy("probe")).toBe(true);
    const stale = health.heldProbe("probe") as string;
    // The lease expired and another process claimed a new one.
    redis.store.set("provider:health-probe:probe", "another-owner");

    await health.releaseProbe("probe", stale);

    expect(redis.store.get("provider:health-probe:probe")).toBe("another-owner");
  });

  it("leaves a lease alone when a call that was not the probe is cancelled", async () => {
    const redis = new FakeRedis();
    const health = await ProviderHealth.init({
      redis: redis as unknown as Redis,
      now: () => NOW,
    });
    const provider = hangingSearch("busy");
    const transit = createTransitOrchestrator({
      providerHealth: health,
      metricsRecorder: { recordProviderCall: vi.fn() },
      getDisallowedSourceIds: async () => new Set<string>(),
      getIntegrationsByDomain: (domain: string) =>
        domain === "transit"
          ? [
              {
                manifest: { dataSources: [{ sourceId: "busy" }] },
                providers: new Map([["transit", [provider]]]),
              },
            ]
          : [],
    } as unknown as IntegrationContext);
    // A call starts while the provider is healthy, then the circuit opens and
    // another request claims the probe before the first call is cancelled.
    const controller = new AbortController();
    const search = transit.searchByNameRaw("Cen", 10, undefined, {
      signal: controller.signal,
      deadlineAt: NOW + 5_000,
    });
    await vi.waitFor(() => expect(provider.searchStopsByName).toHaveBeenCalled());
    redis.store.set("provider:health:busy", JSON.stringify(openCircuit(NOW - 1)));
    expect(await health.isHealthy("busy")).toBe(true);
    controller.abort();
    await expect(search).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(redis.store.has("provider:health-probe:busy")).toBe(true);
    expect(redis.transitions).not.toHaveBeenCalled();
  });

  it("ignores a cancellation recorded directly by any orchestrator", async () => {
    const redis = new FakeRedis();
    const health = await ProviderHealth.init({ redis: redis as unknown as Redis });

    await health.recordFailure("any", 900, "caller_cancelled", "provider call cancelled");

    expect(redis.transitions).not.toHaveBeenCalled();
  });
});
