import {
  type Logger,
  PROVIDER_SHAPES,
  type ProviderDomain,
  ProviderTimeoutError,
} from "@openmapx/integration-framework";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindProviderToScope,
  currentIntegrationScope,
  type IntegrationScope,
  PROVIDER_CALL_DEADLINE_MS,
  runInIntegrationScope,
} from "../integration-scope";

const scope: IntegrationScope = { integrationId: "demo", isBuiltIn: false, revoked: false };

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies Logger;
}

const log = makeLog();
const opts = { domain: "weather" as const, log };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("integration scope", () => {
  it("names the integration across awaits and timers", async () => {
    const seen: Array<string | undefined> = [];
    await runInIntegrationScope(
      { integrationId: "demo", isBuiltIn: false, revoked: false },
      async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(currentIntegrationScope()?.integrationId);
      },
    );
    expect(seen).toEqual(["demo"]);
    expect(currentIntegrationScope()).toBeUndefined();
  });

  it("keeps private fields working behind the binding", async () => {
    class P {
      #n = 1;
      id = "p";
      get n() {
        return this.#n;
      }
      async get() {
        return this.#n;
      }
    }
    const bound = bindProviderToScope(new P(), scope, opts);
    expect(await bound.get()).toBe(1);
    expect(bound.n).toBe(1);
    expect(bound).toBeInstanceOf(P);
  });

  it("binds a frozen provider", async () => {
    const bound = bindProviderToScope(
      Object.freeze({
        id: "f",
        getCurrentWeather: async () => currentIntegrationScope()?.integrationId,
      }),
      scope,
      opts,
    );
    expect(await bound.getCurrentWeather()).toBe("demo");
  });

  it("runs inherited methods in scope with the provider as this", async () => {
    class Base {
      id = "base";
      async whoAmI() {
        return { self: this, scope: currentIntegrationScope()?.integrationId };
      }
    }
    class Derived extends Base {}
    const provider = new Derived();
    const bound = bindProviderToScope(provider, scope, opts);
    expect(Object.hasOwn(bound, "whoAmI")).toBe(true);
    expect(await bound.whoAmI()).toEqual({ self: provider, scope: "demo" });
    expect(bound.id).toBe("base");
    expect(bound).toBeInstanceOf(Base);
  });

  it("rejects with the host's timeout error at the domain deadline", async () => {
    vi.useFakeTimers();
    const p = bindProviderToScope(
      { id: "slow", getCurrentWeather: () => new Promise(() => {}) },
      scope,
      { domain: "weather", log },
    );
    const call = p.getCurrentWeather();
    const settled = expect(call).rejects.toBeInstanceOf(ProviderTimeoutError);
    await vi.advanceTimersByTimeAsync(15_000);
    await settled;
  });

  it("gives every domain a deadline of at least 15 seconds", () => {
    for (const domain of Object.keys(PROVIDER_SHAPES))
      expect(PROVIDER_CALL_DEADLINE_MS[domain as ProviderDomain]).toBeGreaterThanOrEqual(15_000);
  });

  it("leaves every built-in's longest chain of awaited requests inside its domain's deadline", () => {
    expect(PROVIDER_CALL_DEADLINE_MS).toEqual({
      transit: 450_000,
      "live-transit": 45_000,
      "data-source": 315_000,
      weather: 15_000,
      "air-quality": 15_000,
      geocoding: 15_000,
      routing: 140_000,
      "ride-hailing": 90_000,
      "road-conditions": 155_000,
      "fuel-stations": 315_000,
      "parking-sites": 315_000,
      "charging-sites": 1_200_000,
      cameras: 255_000,
      "message-signs": 255_000,
      "landmark-models": 45_000,
      "road-weather": 255_000,
      "service-vehicles": 45_000,
      "border-crossings": 195_000,
      hazards: 60_000,
      photos: 15_000,
      "street-level-imagery": 45_000,
      reviews: 45_000,
      "poi-search": 105_000,
      "search-suggestions": 15_000,
      knowledge: 30_000,
      "gtfs-catalog": 2_320_000,
    });
  });

  it("leaves synchronous members and non-function members alone", () => {
    const provider = {
      id: "sync",
      priority: 3,
      sourceIds: ["a"],
      label: () => currentIntegrationScope()?.integrationId,
    };
    const bound = bindProviderToScope(provider, scope, opts);
    expect(bound.label()).toBe("demo");
    expect(bound.priority).toBe(3);
    expect(bound.sourceIds).toBe(provider.sourceIds);
    provider.priority = 4;
    expect(bound.priority).toBe(4);
    expect(Object.hasOwn(bound, "priority")).toBe(false);
  });

  it("warns once for a call slower than five seconds, naming integration, domain and method", async () => {
    vi.useFakeTimers();
    const bound = bindProviderToScope(
      {
        id: "slowish",
        getCurrentWeather: () => new Promise((resolve) => setTimeout(() => resolve("ok"), 6_000)),
        fast: async () => "fast",
      },
      scope,
      opts,
    );
    const call = bound.getCurrentWeather();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await call).toBe("ok");
    expect(await bound.fast()).toBe("fast");
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), {
      integrationId: "demo",
      domain: "weather",
      method: "getCurrentWeather",
      durationMs: expect.any(Number),
    });
    expect(log.warn.mock.calls[0]?.[1]).toMatchObject({
      durationMs: expect.toSatisfy((ms: number) => ms >= 5_000),
    });
  });
});
