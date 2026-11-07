import {
  type IntegrationContext,
  type PlatformEndpointId,
  type RealtimeProvider,
  resolveIntegrationPlatformEndpoint,
} from "@openmapx/integration-framework";
import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../manifest.json";

vi.mock("@motis-project/motis-client", () => ({
  stoptimes: vi.fn(),
  trip: vi.fn(),
}));
vi.mock("@openmapx/mobility-core/motis-radar", () => ({ getMotisVehicleRadar: vi.fn() }));

interface CtxHandle {
  ctx: IntegrationContext;
  getProvider(): RealtimeProvider;
}

// A self-hosted MOTIS unless a test passes its own config.
function createCtx(config: Record<string, unknown> = { endpoint: "http://motis:8080" }): CtxHandle {
  let provider: RealtimeProvider | undefined;
  const ctx = {
    config,
    manifest: {
      dataSources: [
        {
          sourceId: "transitous",
          name: "Transitous",
          url: "https://api.transitous.org/",
          licensing: licensingFromDeclaration("Mixed", undefined, "Transitous"),
          providerCountry: "DE",
          providerPrivacyUrl: "https://transitous.org/privacy/",
        },
        {
          sourceId: "motis-rt",
          name: "MOTIS GTFS-RT Pass-through",
          url: "https://motis-project.de/",
          licensing: {
            version: 1,
            bindings: [
              { scope: "data", subject: "Data", license: { kind: "spdx", expression: "MIT" } },
            ],
          } as const,
          providerCountry: "DE",
          providerPrivacyUrl: "https://motis-project.de/",
        },
      ],
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getRequiredService: () => null,
    resolvePlatformEndpoint: (id: PlatformEndpointId) =>
      resolveIntegrationPlatformEndpoint(
        {
          manifest,
          config,
        },
        () => null,
        id,
      ),
    onActivate: (activate: () => void) => activate(),
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
    vi.unstubAllEnvs();
  });

  it("maps radar positions to the canonical live-transit vehicle contract", async () => {
    const { getMotisVehicleRadar } = await import("@openmapx/mobility-core/motis-radar");
    vi.mocked(getMotisVehicleRadar).mockResolvedValueOnce([
      {
        id: "ms:vehicle-1",
        provider: "transit-motis-local",
        tripId: "ms:trip-1",
        mode: "rail",
        label: "ICE 612",
        lat: 50.1,
        lng: 8.6,
        updatedAt: "2026-08-31T12:00:00.000Z",
      },
    ]);

    const mod = await loadModule();
    const { ctx, getProvider } = createCtx();
    mod.setup(ctx);
    const provider = getProvider();
    expect(provider.id).toBe("live-transit-motis");
    expect(provider.coverage).toEqual({ all: true });
    expect(provider.capabilities).toEqual({
      vehiclePositions: true,
      alerts: { byStop: true, byRoute: false, byBbox: false },
      tripUpdates: true,
    });
    expect(provider.attribution.map((a) => a.sourceId)).toEqual(
      expect.arrayContaining(["transitous", "motis-rt"]),
    );
    expect(provider.getAlertsForRoute).toBeUndefined();
    expect(provider.getAlertsForBbox).toBeUndefined();
    const result = await provider.getVehiclePositions?.([8, 49, 9, 51]);

    expect(result?.data).toEqual([
      expect.objectContaining({
        id: "ms:vehicle-1",
        sourceId: "motis-rt",
        mode: "rail",
        displayLabel: "ICE 612",
        positionKind: "interpolated",
      }),
    ]);
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
    expect(result?.attributions).toEqual([]);
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
      contributors: result?.attributions,
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

    const result = await provider.getTripUpdate?.("entur:1234");
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
    expect(result?.data).toEqual({
      tripId: "ms:trip-42",
      canceled: true,
      contributors: result?.attributions,
    });
  });

  describe("prefix routing", () => {
    it("keeps clients scoped to their integration setup generation", async () => {
      const motisClient = await import("@motis-project/motis-client");
      vi.mocked(motisClient.stoptimes).mockResolvedValue({
        data: { place: { alerts: [] } },
      } as never);
      const mod = await loadModule();
      const first = createCtx({ endpoint: "https://first-local.example" });
      const second = createCtx({ endpoint: "https://second-local.example" });
      mod.setup(first.ctx);
      mod.setup(second.ctx);

      await first.getProvider().getAlertsForStop?.("ms:first");
      await second.getProvider().getAlertsForStop?.("ms:second");

      const firstClient = vi.mocked(motisClient.stoptimes).mock.calls.at(-2)?.[0]?.client;
      const secondClient = vi.mocked(motisClient.stoptimes).mock.calls.at(-1)?.[0]?.client;
      expect(firstClient).toBeDefined();
      expect(secondClient).toBeDefined();
      expect(firstClient).not.toBe(secondClient);
      expect(firstClient?.getConfig().baseUrl).toBe("https://first-local.example");
      expect(secondClient?.getConfig().baseUrl).toBe("https://second-local.example");
    });

    it("serves stops and vehicles from Transitous without a local MOTIS", async () => {
      vi.stubEnv("MOTIS_URL", "");
      const motisClient = await import("@motis-project/motis-client");
      const { getMotisVehicleRadar } = await import("@openmapx/mobility-core/motis-radar");
      vi.mocked(motisClient.stoptimes).mockResolvedValueOnce({
        data: { place: { alerts: [] } },
      } as never);
      vi.mocked(getMotisVehicleRadar).mockResolvedValueOnce([
        {
          id: "mo:vehicle",
          provider: "mo",
          mode: "rail",
          lat: 50,
          lng: 8,
          label: "Train",
          updatedAt: "2026-08-31T12:00:00Z",
        },
      ]);
      const mod = await loadModule();
      const { ctx, getProvider } = createCtx({});
      mod.setup(ctx);
      const provider = getProvider();
      const alerts = await provider.getAlertsForStop?.("8000105");
      expect(vi.mocked(motisClient.stoptimes).mock.calls[0][0].client?.getConfig().baseUrl).toBe(
        "https://api.transitous.org",
      );
      expect(alerts?.attributions.map((credit) => credit.sourceId)).toEqual(["transitous"]);
      const vehicles = await provider.getVehiclePositions?.([8, 49, 9, 51]);
      expect(vehicles?.data).toMatchObject([{ id: "mo:vehicle", sourceId: "transitous" }]);
      expect(vehicles?.attributions.map((credit) => credit.sourceId)).toEqual(["transitous"]);
    });

    it("queries Transitous for mo: stops and the local instance for ms: and unprefixed stops", async () => {
      const motisClient = await import("@motis-project/motis-client");
      vi.mocked(motisClient.stoptimes).mockResolvedValue({
        data: { place: { alerts: [] } },
      } as never);

      const mod = await loadModule();
      const { ctx, getProvider } = createCtx();
      mod.setup(ctx);
      const provider = getProvider();

      await provider.getAlertsForStop?.("mo:NL:123");
      const transitousClient = vi.mocked(motisClient.stoptimes).mock.calls.at(-1)?.[0]?.client;

      await provider.getAlertsForStop?.("ms:DE:456");
      const localClient = vi.mocked(motisClient.stoptimes).mock.calls.at(-1)?.[0]?.client;

      expect(transitousClient).toBeDefined();
      expect(localClient).toBeDefined();
      expect(transitousClient).not.toBe(localClient);
      expect(transitousClient?.getConfig().baseUrl).toBe("https://api.transitous.org");
      expect(localClient?.getConfig().baseUrl).toBe("http://motis:8080");
      await provider.getAlertsForStop?.("8000105");
      expect(vi.mocked(motisClient.stoptimes).mock.calls.at(-1)?.[0]?.client).toBe(localClient);
    });
  });
});

it("captures local realtime records from their typed feed references, not the MOTIS backend manifest", async () => {
  const motisClient = await import("@motis-project/motis-client");
  vi.mocked(motisClient.trip).mockResolvedValueOnce({
    data: {
      legs: [
        {
          from: {
            stopId: "feed_A_stop",
            scheduledDeparture: "2026-05-22T08:00:00Z",
            departure: "2026-05-22T08:02:00Z",
          },
          to: { stopId: "feed_A_to" },
        },
      ],
    },
  } as never);
  const mod = await loadModule();
  const { ctx, getProvider } = createCtx();
  const a = { sourceId: "feed_A", name: "Actual feed A", notes: "Required feed notice" };
  Object.assign(ctx, {
    attributionIndex: {
      listMotisFeedTags: () => ["feed_A"],
      getById: (id: string) => (id === "feed_A" ? a : undefined),
    },
  });
  mod.setup(ctx);
  const result = await getProvider().getTripUpdate?.("ms:feed_A_trip", "ms:feed_A_stop");
  expect(result?.data?.contributors).toEqual([a]);
  expect(result?.attributions).toEqual([a]);
  a.name = "Updated registry";
  expect(result?.data?.contributors?.[0].name).toBe("Actual feed A");
});
