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
    manifest: {
      dataSources: [
        {
          sourceId: "transitous",
          name: "Transitous",
          url: "https://api.transitous.org/",
          license: "Mixed",
          providerCountry: "DE",
          providerPrivacyUrl: "https://transitous.org/privacy/",
        },
        {
          sourceId: "motis-rt",
          name: "MOTIS GTFS-RT Pass-through",
          url: "https://motis-project.de/",
          license: "MIT",
          providerCountry: "DE",
          providerPrivacyUrl: "https://motis-project.de/",
        },
      ],
    },
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
    expect(provider.attribution.map((a) => a.sourceId)).toEqual(
      expect.arrayContaining(["transitous", "motis-rt"]),
    );
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
        affectedStopIds: ["ms:DE:8000105"],
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

  it("returns a structured TripUpdate from the MOTIS itinerary", async () => {
    const motisClient = await import("@motis-project/motis-client");
    const itinerary = {
      legs: [
        {
          from: {
            stopId: "DE:8000105",
            scheduledDeparture: "2026-05-22T08:00:00Z",
            departure: "2026-05-22T08:02:30Z",
            track: "7",
            cancelled: false,
          },
          to: { stopId: "DE:8000010" },
          cancelled: false,
        },
      ],
    };
    vi.mocked(motisClient.trip).mockResolvedValueOnce({ data: itinerary } as never);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getTripUpdate?.("ms:trip-42", "ms:DE:8000105");
    expect(motisClient.trip).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ tripId: "trip-42" }) }),
    );
    expect(result?.data).toEqual({
      tripId: "ms:trip-42",
      expectedAt: "2026-05-22T08:02:30Z",
      delaySeconds: 150,
      platform: "7",
    });
    expect(result?.freshness.hasRealtimeData).toBe(true);
  });

  it("returns null when the tripId prefix is not MOTIS-owned", async () => {
    const motisClient = await import("@motis-project/motis-client");
    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getTripUpdate?.("db-hafas:1234");
    expect(motisClient.trip).not.toHaveBeenCalled();
    expect(result?.data).toBeNull();
  });

  it("returns null when scheduled equals actual and nothing is cancelled", async () => {
    const motisClient = await import("@motis-project/motis-client");
    const itinerary = {
      legs: [
        {
          from: {
            stopId: "DE:8000105",
            scheduledDeparture: "2026-05-22T08:00:00Z",
            departure: "2026-05-22T08:00:00Z",
          },
          to: { stopId: "DE:8000010" },
        },
      ],
    };
    vi.mocked(motisClient.trip).mockResolvedValueOnce({ data: itinerary } as never);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getTripUpdate?.("ms:trip-42", "ms:DE:8000105");
    expect(result?.data).toBeNull();
  });

  it("propagates trip-level cancellation when no per-stop delta", async () => {
    const motisClient = await import("@motis-project/motis-client");
    const itinerary = {
      legs: [
        {
          from: {
            stopId: "DE:8000105",
            scheduledDeparture: "2026-05-22T08:00:00Z",
            departure: "2026-05-22T08:00:00Z",
          },
          to: { stopId: "DE:8000010" },
          cancelled: true,
        },
      ],
    };
    vi.mocked(motisClient.trip).mockResolvedValueOnce({ data: itinerary } as never);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();

    const result = await provider.getTripUpdate?.("ms:trip-42", "ms:DE:8000105");
    expect(result?.data).toEqual({ tripId: "ms:trip-42", canceled: true });
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

  describe("resolveMotisUrl resolution chain", () => {
    const ORIGINAL_ENV = process.env.MOTIS_URL;

    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.MOTIS_URL;
      else process.env.MOTIS_URL = ORIGINAL_ENV;
    });

    function ctxWith(opts: {
      service?: { url: string } | null;
      configEndpoint?: string;
    }): IntegrationContext {
      return {
        config: opts.configEndpoint ? { endpoint: opts.configEndpoint } : {},
        getRequiredService: () => opts.service ?? null,
      } as unknown as IntegrationContext;
    }

    it("prefers the service registry url", async () => {
      delete process.env.MOTIS_URL;
      const mod = await loadModule();
      const ctx = ctxWith({
        service: { url: "http://motis.registry:8080" },
        configEndpoint: "http://config.example",
      });
      expect(mod.__testing.resolveMotisUrl(ctx)).toBe("http://motis.registry:8080");
    });

    it("falls back to config.endpoint", async () => {
      delete process.env.MOTIS_URL;
      const mod = await loadModule();
      const ctx = ctxWith({
        service: null,
        configEndpoint: "http://config.example",
      });
      expect(mod.__testing.resolveMotisUrl(ctx)).toBe("http://config.example");
    });

    it("falls back to the MOTIS_URL env var", async () => {
      process.env.MOTIS_URL = "http://env.example:9000";
      const mod = await loadModule();
      const ctx = ctxWith({ service: null });
      expect(mod.__testing.resolveMotisUrl(ctx)).toBe("http://env.example:9000");
    });

    it("uses the localhost default when nothing else is wired", async () => {
      delete process.env.MOTIS_URL;
      const mod = await loadModule();
      const ctx = ctxWith({ service: null });
      expect(mod.__testing.resolveMotisUrl(ctx)).toBe("http://localhost:8081");
    });
  });

  describe("prefix routing", () => {
    it("routeForId picks the client + attribution by id prefix", async () => {
      const mod = await loadModule();
      const { ctx } = createCtx();
      mod.setup(ctx);
      const { routeForId, transitousClient, localClient } = mod.__testing;

      expect(routeForId("mo:NL:123").client).toBe(transitousClient);
      expect(routeForId("ms:DE:456").client).toBe(localClient);
      expect(routeForId("8000105").client).toBe(localClient);

      expect(routeForId("mo:x").attribution[0]?.sourceId).toBe("transitous");
      expect(routeForId("ms:x").attribution[0]?.sourceId).toBe("motis-rt");
    });

    it("queries Transitous for mo: stops and the local instance for ms: stops", async () => {
      const motisClient = await import("@motis-project/motis-client");
      vi.mocked(motisClient.stoptimes).mockResolvedValue({
        data: { place: { alerts: [] } },
      } as never);

      const mod = await loadModule();
      const { ctx, getProvider } = createCtx();
      mod.setup(ctx);
      const provider = getProvider();

      await provider.getAlertsForStop?.("mo:NL:123");
      expect(motisClient.stoptimes).toHaveBeenLastCalledWith(
        expect.objectContaining({ client: mod.__testing.transitousClient }),
      );

      await provider.getAlertsForStop?.("ms:DE:456");
      expect(motisClient.stoptimes).toHaveBeenLastCalledWith(
        expect.objectContaining({ client: mod.__testing.localClient }),
      );
    });
  });
});
