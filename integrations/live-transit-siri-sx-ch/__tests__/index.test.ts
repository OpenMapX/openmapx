import type {
  IntegrationContext,
  RealtimeProvider,
  TransitProvider,
} from "@openmapx/integration-framework";
import { freshnessNow } from "@openmapx/mobility-core/freshness";
import type { MobilityResult } from "@openmapx/mobility-core/result";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { describe, expect, it, vi } from "vitest";
import { setup } from "../index.js";

function createCtx(dependency: Partial<TransitProvider>) {
  let provider!: RealtimeProvider;
  let current = dependency;
  const ctx = {
    manifest: { dataSources: [] },
    getIntegrationsByDomain: () => [
      {
        id: "transit-opentransportdata-ch",
        providers: new Map([["transit", [{ id: "transit-opentransportdata-ch", ...current }]]]),
      },
    ],
    registerRealtimeProvider: (value: RealtimeProvider) => {
      provider = value;
    },
  } as unknown as IntegrationContext;
  return {
    ctx,
    getProvider: () => provider,
    replace: (value: Partial<TransitProvider>) => {
      current = value;
    },
  };
}

function result(): MobilityResult<ServiceAlert[]> {
  return {
    data: [],
    attributions: [{ sourceId: "original", name: "Original acquisition" }],
    freshness: freshnessNow({ hasRealtimeData: true }),
  };
}

describe("Swiss SIRI dependency ownership", () => {
  it("delegates each operation and preserves the exact acquired result", async () => {
    const acquired = result();
    const stop = vi.fn(async () => acquired);
    const route = vi.fn(async () => acquired);
    const bbox = vi.fn(async () => acquired);
    const handle = createCtx({
      getAlertsForStop: stop,
      getAlertsForRoute: route,
      getAlertsForBbox: bbox,
    });
    setup(handle.ctx);
    const provider = handle.getProvider();
    expect(provider.id).toBe("live-transit-siri-sx-ch");
    expect(provider.coverage).toEqual({ bbox: [5.96, 45.82, 10.49, 47.81] });
    expect(await provider.getAlertsForStop?.("otdch:1")).toBe(acquired);
    expect(await provider.getAlertsForRoute?.("otdch:r")).toBe(acquired);
    const area: [number, number, number, number] = [6, 46, 7, 47];
    expect(await provider.getAlertsForBbox?.(area)).toBe(acquired);
    expect(stop).toHaveBeenCalledWith("otdch:1");
    expect(route).toHaveBeenCalledWith("otdch:r");
    expect(bbox).toHaveBeenCalledWith(area);
  });

  it("captures its staged dependency and a failed candidate leaves it untouched", async () => {
    const acquiredA = result();
    const acquiredB = result();
    const stopA = vi.fn(async () => acquiredA);
    const handle = createCtx({
      getAlertsForStop: stopA,
      getAlertsForRoute: stopA,
      getAlertsForBbox: stopA,
    });
    setup(handle.ctx);
    const first = handle.getProvider();
    const stopB = vi.fn(async () => acquiredB);
    handle.replace({ getAlertsForStop: stopB, getAlertsForRoute: stopB, getAlertsForBbox: stopB });
    setup(handle.ctx);
    const second = handle.getProvider();
    handle.replace({});
    expect(() => setup(handle.ctx)).toThrow(/staged Swiss transit/);
    expect(await first.getAlertsForStop?.("a")).toBe(acquiredA);
    expect(await second.getAlertsForStop?.("b")).toBe(acquiredB);
    expect(stopA).toHaveBeenCalledTimes(1);
    expect(stopB).toHaveBeenCalledTimes(1);
  });
});
