import { setRisCredentials } from "@integrations/geocoding-db-ris/ris-client.js";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setup } from "./index.js";

const GERMANY_CENTER = { lat: 52.52, lng: 13.405 };
const OUTSIDE = { lat: 0, lng: 0 };

function mockOk(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

/** Run setup() with credentials and return the registered realtime provider. */
function registerProvider() {
  const ctx = createMockIntegrationContext({
    id: "live-transit-db-ris",
    config: { clientId: "cid", apiKey: "key" },
    manifest: { dataSources: [] } as never,
  });
  setup(ctx);
  const provider = ctx.registered.realtime[0];
  if (!provider) throw new Error("no realtime provider registered");
  return provider;
}

function liveEntry(overrides: Record<string, unknown> = {}) {
  return {
    journeyID: "j-live",
    latitude: GERMANY_CENTER.lat,
    longitude: GERMANY_CENTER.lng,
    direction: 180,
    speed: 36,
    info: {
      transportAtStart: { journeyName: "ICE 521", category: "HIGH_SPEED_TRAIN" },
      origin: { name: "Köln Hbf" },
      destination: { name: "Berlin Hbf" },
    },
    meta: { timeCreated: "2026-03-10T10:00:00Z" },
    ...overrides,
  };
}

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  setRisCredentials({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** First POST is /journey-positions/ (live), second is .../emulated. */
function mockPositions(live: unknown, emulated: unknown) {
  mockFetch.mockImplementation((url: string) =>
    Promise.resolve(mockOk(url.includes("/emulated") ? emulated : live)),
  );
}

describe("live-transit-db-ris setup", () => {
  it("registers a realtime provider exposing vehicle positions only", () => {
    const provider = registerProvider();
    expect(provider.id).toBe("live-transit-db-ris");
    expect(provider.capabilities.vehiclePositions).toBe(true);
    expect(provider.capabilities.alerts).toMatchObject({ byBbox: false });
  });

  it("registers no provider when credentials are absent (still wires the provider)", () => {
    const ctx = createMockIntegrationContext({
      id: "live-transit-db-ris",
      manifest: { dataSources: [] } as never,
    });
    setup(ctx);
    // The provider is always registered; without credentials it yields no data.
    expect(ctx.registered.realtime).toHaveLength(1);
  });
});

describe("getVehiclePositions", () => {
  it("maps a live journey position into a rail LiveTransitVehicle", async () => {
    mockPositions({ positions: [liveEntry()] }, { positions: [] });

    const result = await registerProvider().getVehiclePositions([5.87, 47.27, 15.04, 55.06]);

    expect(result.data).toEqual([
      {
        id: "db-ris-maps:j-live",
        provider: "db-ris-maps",
        sourceId: "db-ris-maps",
        mode: "rail",
        displayLabel: "ICE 521",
        secondaryLabel: "Köln Hbf -> Berlin Hbf",
        tripId: "ris:j-live",
        lat: GERMANY_CENTER.lat,
        lng: GERMANY_CENTER.lng,
        bearing: 180,
        speed: 10,
        label: "ICE 521\nKöln Hbf -> Berlin Hbf",
        updatedAt: "2026-03-10T10:00:00Z",
      },
    ]);
  });

  it("filters out vehicles outside the requested bbox", async () => {
    mockPositions(
      {
        positions: [
          liveEntry({ journeyID: "j-far", latitude: OUTSIDE.lat, longitude: OUTSIDE.lng }),
        ],
      },
      { positions: [] },
    );

    const result = await registerProvider().getVehiclePositions([5.87, 47.27, 15.04, 55.06]);
    expect(result.data).toEqual([]);
  });

  it("prefers the live feed over the emulated feed for the same journey id", async () => {
    mockPositions(
      { positions: [liveEntry({ info: { transportAtStart: { journeyName: "LIVE" } } })] },
      { positions: [liveEntry({ info: { transportAtStart: { journeyName: "EMULATED" } } })] },
    );

    const result = await registerProvider().getVehiclePositions([5.87, 47.27, 15.04, 55.06]);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.displayLabel).toBe("LIVE");
  });

  it("returns no data when credentials are not configured", async () => {
    const ctx = createMockIntegrationContext({
      id: "live-transit-db-ris",
      manifest: { dataSources: [] } as never,
    });
    setup(ctx);
    const result = await ctx.registered.realtime[0]?.getVehiclePositions([
      5.87, 47.27, 15.04, 55.06,
    ]);
    expect(result?.data).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
