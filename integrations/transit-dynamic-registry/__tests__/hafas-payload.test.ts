import { classifyProviderFailure } from "@openmapx/integration-framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import departuresFixture from "../__fixtures__/hafas-departures.json";
import nearbyFixture from "../__fixtures__/hafas-nearby.json";
import type { RegistryEntry } from "../registry-types";

const client = vi.hoisted(() => ({
  nearby: vi.fn(),
  locations: vi.fn(),
  departures: vi.fn(),
  arrivals: vi.fn(),
}));
const createClient = vi.hoisted(() => vi.fn(() => client));
vi.mock("hafas-client", () => ({ createClient }));

const { createHafasMgateAdapter } = await import("../hafas-mgate");
const hafasMgateAdapter = createHafasMgateAdapter();

let sequence = 0;
function entry(): RegistryEntry {
  sequence += 1;
  return {
    id: `de/test-${sequence}-hafas-mgate`,
    slug: "vbb",
    prefix: "vbb:",
    protocol: "hafasMgate",
    options: { endpoint: "https://hafas.test/mgate" },
    supportedLanguages: ["de"],
    timezone: "Europe/Berlin",
    coverage: { bbox: [13, 52, 14, 53], tiers: [] },
  } as unknown as RegistryEntry;
}

beforeEach(() => {
  client.nearby.mockReset();
  client.locations.mockReset();
  client.departures.mockReset();
  client.arrivals.mockReset();
});

describe("HAFAS payload validation", () => {
  it("maps documented nearby stops and passes the radius to hafas-client", async () => {
    client.nearby.mockResolvedValue(nearbyFixture);

    const stops = await hafasMgateAdapter.getStopsNearby(entry(), 52.5137, 13.4745, 399.6);

    expect(stops.map((stop) => [stop.id, stop.lat, stop.lng])).toEqual([
      ["vbb:900000120001", 52.513616, 13.475298],
      ["vbb:900000120540", 52.512339, 13.470174],
    ]);
    expect(client.nearby).toHaveBeenCalledWith(
      { type: "location", latitude: 52.5137, longitude: 13.4745 },
      { results: 30, distance: 400 },
    );
  });

  it("drops a stop without a location instead of placing it at null island", async () => {
    const [first, second] = nearbyFixture;
    client.nearby.mockResolvedValue([{ ...first, location: undefined }, second]);

    const stops = await hafasMgateAdapter.getStopsNearby(entry(), 52.5, 13.4, 400);

    expect(stops.map((stop) => stop.id)).toEqual(["vbb:900000120540"]);
  });

  it("reports a failed nearby lookup instead of answering no stops", async () => {
    const upstream = Object.assign(new Error("HAFAS: SERVER_ERROR"), { code: "SERVER_ERROR" });
    client.nearby.mockRejectedValue(upstream);

    const failure = await hafasMgateAdapter
      .getStopsNearby(entry(), 52.5, 13.4, 400)
      .catch((error: unknown) => error);

    expect((failure as Error).message).toBe("HAFAS nearby stops unavailable");
    expect(classifyProviderFailure(failure)).toBe("upstream_5xx");
  });

  it("maps a documented departure board and requests the stop's window", async () => {
    client.departures.mockResolvedValue(departuresFixture);

    const board = await hafasMgateAdapter.getDepartures(entry(), "vbb:900000024101", 30);

    expect(board.departures.map((d) => [d.route.shortName, d.scheduledAt, d.canceled])).toEqual([
      ["S9", "2017-12-17T19:32:00+01:00", false],
      ["S5", "2017-12-17T19:33:00+01:00", true],
    ]);
    expect(board.dataAsOf).toBe("2017-12-17T18:30:00.000Z");
    expect(client.departures).toHaveBeenCalledWith("900000024101", {
      duration: 30,
      results: 90,
      remarks: true,
    });
  });

  it("keeps timed departures and drops one with neither a planned nor current time", async () => {
    const [first, second] = departuresFixture.departures;
    client.departures.mockResolvedValue({
      departures: [{ ...first, when: null, plannedWhen: null }, second],
    });

    const board = await hafasMgateAdapter.getDepartures(entry(), "vbb:900000024101", 30);

    expect(board.departures.map((d) => d.route.shortName)).toEqual(["S5"]);
  });

  it.each([
    ["a board without departures", { realtimeDataUpdatedAt: 1 }],
    ["departures without times", { departures: [{ tripId: "1|2" }] }],
  ])("reports %s as an invalid payload", async (_case, result) => {
    client.departures.mockResolvedValue(result);

    const failure = await hafasMgateAdapter
      .getDepartures(entry(), "vbb:900000024101", 30)
      .catch((error: unknown) => error);

    expect(classifyProviderFailure(failure)).toBe("invalid_payload");
  });

  it("keeps the library error on a failed arrivals board and reports a malformed one", async () => {
    client.arrivals.mockRejectedValue(
      Object.assign(new Error("HAFAS: SERVER_ERROR"), { code: "SERVER_ERROR" }),
    );
    const failure = await hafasMgateAdapter
      .getArrivals(entry(), "vbb:900000024101", 30)
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("HAFAS timetable unavailable");
    expect(classifyProviderFailure(failure)).toBe("upstream_5xx");

    client.arrivals.mockResolvedValue({ arrivals: [{ tripId: "1|2" }] });
    const malformed = await hafasMgateAdapter
      .getArrivals(entry(), "vbb:900000024101", 30)
      .catch((error: unknown) => error);
    expect(classifyProviderFailure(malformed)).toBe("invalid_payload");
  });

  it("searches stops only and rejects matches without coordinates", async () => {
    client.locations.mockResolvedValue([
      { type: "location", address: "Somewhere 1", latitude: 52.5, longitude: 13.4 },
      ...nearbyFixture,
    ]);

    const stops = await hafasMgateAdapter.searchByName?.(entry(), "Frankfurter", 5);

    expect(stops?.map((stop) => stop.id)).toEqual(["vbb:900000120001", "vbb:900000120540"]);
    expect(client.locations).toHaveBeenCalledWith("Frankfurter", {
      results: 5,
      stops: true,
      addresses: false,
      poi: false,
    });

    client.locations.mockResolvedValue([{ type: "stop", id: "900000000001", name: "No place" }]);
    const failure = await hafasMgateAdapter
      .searchByName?.(entry(), "No place", 5)
      .catch((error: unknown) => error);
    expect(classifyProviderFailure(failure)).toBe("invalid_payload");
  });
});

describe("HAFAS client ownership", () => {
  it("reuses a client within a generation and builds new ones for the next", async () => {
    client.nearby.mockResolvedValue([]);
    const first = entry();
    const replacement = { ...first, options: { endpoint: "https://replacement.test/mgate" } };
    createClient.mockClear();

    const generation = createHafasMgateAdapter();
    await generation.getStopsNearby(first, 52.5, 13.4, 100);
    await generation.getStopsNearby(first, 52.5, 13.4, 100);
    await createHafasMgateAdapter().getStopsNearby(replacement, 52.5, 13.4, 100);

    const endpoints = (createClient.mock.calls as unknown as Array<[{ endpoint?: string }]>).map(
      ([profile]) => profile.endpoint,
    );
    expect(endpoints).toEqual(["https://hafas.test/mgate", "https://replacement.test/mgate"]);
  });
});
