import type { IntegrationContext, RealtimeProvider } from "@openmapx/integration-framework";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@motis-project/motis-client", () => ({
  stoptimes: vi.fn(),
  trip: vi.fn(),
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
    getRequiredService: () => null,
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

describe("live-transit-motis provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a RealtimeProvider with the expected shape", async () => {
    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    expect(provider.id).toBe("live-transit-motis");
    expect(provider.coverage).toEqual({ all: true });
    expect(provider.priority).toBe(12);
    expect(provider.capabilities).toEqual({
      vehiclePositions: false,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      tripUpdates: true,
    });
    expect(provider.attribution[0]?.sourceId).toBe("motis-rt");
    expect(typeof provider.getAlertsForStop).toBe("function");
    expect(typeof provider.getTripUpdate).toBe("function");
    expect(provider.getVehiclePositions).toBeUndefined();
    expect(provider.getAlertsForRoute).toBeUndefined();
    expect(provider.getAlertsForBbox).toBeUndefined();
  });

  it("maps MOTIS alerts on a stop to ServiceAlerts", async () => {
    const motisClient = await import("@motis-project/motis-client");
    vi.mocked(motisClient.stoptimes).mockResolvedValueOnce({
      data: {
        place: {
          alerts: [
            {
              code: "ALERT-123",
              headerText: "Track closure",
              descriptionText: "Track 3 closed for maintenance",
              cause: "MAINTENANCE",
              effect: "DETOUR",
              severityLevel: "WARNING",
              impactPeriod: [{ start: "2026-05-22T08:00:00Z", end: "2026-05-22T18:00:00Z" }],
            },
          ],
        },
      },
    } as never);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getAlertsForStop?.("ms:DE:8000105");
    expect(motisClient.stoptimes).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({ stopId: "DE:8000105", withAlerts: true }),
      }),
    );

    const alerts = result?.data ?? [];
    expect(alerts).toEqual([
      expect.objectContaining({
        id: "mr:ALERT-123",
        providers: ["motis-rt"],
        severity: "warning",
        effect: "DETOUR",
        title: "Track closure",
        description: "Track 3 closed for maintenance",
        affectedRouteIds: [],
        affectedStopIds: [],
        activePeriods: [{ start: "2026-05-22T08:00:00Z", end: "2026-05-22T18:00:00Z" }],
      }),
    ]);
    expect(result?.attributions.map((a) => a.sourceId)).toContain("motis-rt");
    expect(result?.freshness.hasRealtimeData).toBe(true);
  });

  it("returns an empty alert list when MOTIS fails", async () => {
    const motisClient = await import("@motis-project/motis-client");
    vi.mocked(motisClient.stoptimes).mockRejectedValueOnce(new Error("boom"));

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getAlertsForStop?.("ms:STOP");
    expect(result?.data).toEqual([]);
  });

  it("returns the raw MOTIS itinerary for trip updates", async () => {
    const motisClient = await import("@motis-project/motis-client");
    const itinerary = { legs: [{ headsign: "Berlin Hbf" }] };
    vi.mocked(motisClient.trip).mockResolvedValueOnce({ data: itinerary } as never);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getTripUpdate?.("ms:trip-42");
    expect(motisClient.trip).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ tripId: "trip-42" }) }),
    );
    expect(result?.data).toBe(itinerary);
    expect(result?.freshness.hasRealtimeData).toBe(true);
  });

  it("maps severity levels to ServiceAlert severities", async () => {
    const mod = await loadModule();
    const { mapMotisAlertSeverity } = mod.__testing;
    expect(mapMotisAlertSeverity("SEVERE")).toBe("severe");
    expect(mapMotisAlertSeverity("WARNING")).toBe("warning");
    expect(mapMotisAlertSeverity("INFO")).toBe("info");
    expect(mapMotisAlertSeverity("UNKNOWN_SEVERITY")).toBe("info");
    expect(mapMotisAlertSeverity(undefined)).toBe("info");
  });
});
