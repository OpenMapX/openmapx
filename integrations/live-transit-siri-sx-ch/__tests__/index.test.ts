import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@integrations/transit-opentransportdata-ch/provider.js", () => ({
  getAlerts: vi.fn(),
  getStopAlerts: vi.fn(),
  getRouteAlerts: vi.fn(),
}));

interface CtxHandle {
  ctx: IntegrationContext;
  getProvider(): RealtimeProvider;
}

function createCtx(config: Record<string, unknown> = {}): CtxHandle {
  let provider: RealtimeProvider | undefined;
  const ctx = {
    config,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerRealtimeProvider: (next: RealtimeProvider) => {
      provider = next;
    },
  } as unknown as IntegrationContext;
  return {
    ctx,
    getProvider() {
      if (!provider) throw new Error("provider was not registered");
      return provider;
    },
  };
}

async function loadModule() {
  vi.resetModules();
  return import("../index.js");
}

describe("live-transit-siri-sx-ch provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a RealtimeProvider with Swiss coverage and alert capabilities", async () => {
    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    expect(provider.id).toBe("live-transit-siri-sx-ch");
    expect(provider.coverage).toEqual({ bbox: [5.96, 45.82, 10.49, 47.81] });
    expect(provider.priority).toBe(5);
    expect(provider.capabilities).toEqual({
      vehiclePositions: false,
      alerts: { byStop: true, byRoute: true, byBbox: true },
      tripUpdates: false,
    });
    expect(provider.attribution[0]?.sourceId).toBe("opentransportdata-ch-siri-sx");
    expect(typeof provider.getAlertsForStop).toBe("function");
    expect(typeof provider.getAlertsForRoute).toBe("function");
    expect(typeof provider.getAlertsForBbox).toBe("function");
    expect(provider.getVehiclePositions).toBeUndefined();
    expect(provider.getTripUpdate).toBeUndefined();
  });

  it("passes stop alerts through to OTD-CH and wraps with attribution", async () => {
    const otd = await import("@integrations/transit-opentransportdata-ch/provider.js");
    const sampleAlert = {
      id: "otdch:alert-1",
      providers: ["transit-opentransportdata-ch"],
      severity: "warning" as const,
      title: "Disruption",
      affectedRouteIds: [],
      affectedStopIds: ["otdch:8503000"],
      activePeriods: [],
    };
    vi.mocked(otd.getStopAlerts).mockResolvedValueOnce([sampleAlert]);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getAlertsForStop?.("otdch:8503000");
    expect(otd.getStopAlerts).toHaveBeenCalledWith("otdch:8503000");
    expect(result?.data).toEqual([sampleAlert]);
    expect(result?.attributions.map((a) => a.sourceId)).toContain("opentransportdata-ch-siri-sx");
    expect(result?.freshness.hasRealtimeData).toBe(true);
  });

  it("delegates route alert lookups to OTD-CH", async () => {
    const otd = await import("@integrations/transit-opentransportdata-ch/provider.js");
    vi.mocked(otd.getRouteAlerts).mockResolvedValueOnce([]);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getAlertsForRoute?.("otdch:line-1");
    expect(otd.getRouteAlerts).toHaveBeenCalledWith("otdch:line-1");
    expect(result?.data).toEqual([]);
  });

  it("delegates bbox alert lookups to OTD-CH", async () => {
    const otd = await import("@integrations/transit-opentransportdata-ch/provider.js");
    vi.mocked(otd.getAlerts).mockResolvedValueOnce([]);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const bbox: [number, number, number, number] = [6.0, 46.0, 7.0, 47.0];
    const result = await provider.getAlertsForBbox?.(bbox);
    expect(otd.getAlerts).toHaveBeenCalledWith(bbox);
    expect(result?.data).toEqual([]);
  });
});
