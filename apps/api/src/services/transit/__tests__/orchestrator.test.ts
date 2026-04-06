import type { TransitProvider } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { TransitOrchestrator } from "../orchestrator";

function makeProvider(overrides: Partial<TransitProvider>): TransitProvider {
  return {
    id: "test-provider",
    prefix: "tp:",
    coverage: { bbox: [-180, -90, 180, 90] },
    priority: 1,
    capabilities: {
      stops: true,
      departures: true,
      arrivals: true,
      search: true,
      tripPlanning: true,
      alerts: true,
      vehicles: true,
    },
    ...overrides,
  };
}

describe("TransitOrchestrator.getRoutesForStop", () => {
  it("derives routes from departures when provider route lookup is missing", async () => {
    const departures = vi.fn().mockResolvedValue([
      {
        tripId: "trip-1",
        route: {
          id: "tp:r-1",
          shortName: "Bus 1",
          longName: "Bus 1",
          mode: "bus",
          color: "00AA00",
        },
        headsign: "Downtown",
        scheduledAt: "2026-04-06T10:00:00Z",
      },
      {
        tripId: "trip-2",
        route: {
          id: "tp:r-2",
          shortName: "12345",
          longName: "Trip Number",
          mode: "bus",
          color: "AA0000",
        },
        headsign: "Somewhere",
        scheduledAt: "2026-04-06T10:05:00Z",
      },
    ]);

    const orchestrator = new TransitOrchestrator();
    orchestrator.register(
      makeProvider({
        id: "test-provider",
        prefix: "tp:",
        getDepartures: departures,
      }),
    );

    const routes = await orchestrator.getRoutesForStop("tp:stop-1");

    expect(departures).toHaveBeenCalledWith("tp:stop-1", 720);
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      id: "tp:r-1",
      shortName: "Bus 1",
      longName: "Bus 1",
      mode: "bus",
      color: "00AA00",
    });
  });

  it("uses provider route lookup when available and non-empty", async () => {
    const getRoutesForStop = vi.fn().mockResolvedValue([
      {
        id: "tp:r-1",
        shortName: "U1",
        longName: "Main Line",
        mode: "subway",
        operatorName: "",
      },
    ]);
    const departures = vi.fn().mockResolvedValue([]);

    const orchestrator = new TransitOrchestrator();
    orchestrator.register(
      makeProvider({
        id: "test-provider",
        prefix: "tp:",
        getRoutesForStop,
        getDepartures: departures,
      }),
    );

    const routes = await orchestrator.getRoutesForStop("tp:stop-1");

    expect(routes).toHaveLength(1);
    expect(getRoutesForStop).toHaveBeenCalledWith("tp:stop-1");
    expect(departures).not.toHaveBeenCalled();
  });
});

describe("TransitOrchestrator.getRouteStops", () => {
  it("derives stop sequence from departure trip detail when provider route-stops lookup is missing", async () => {
    const departures = vi.fn().mockResolvedValue([
      {
        tripId: "tp:trip-1",
        route: {
          id: "tp:r-1",
          shortName: "Bus 1",
          longName: "Bus 1",
          mode: "bus",
          color: "00AA00",
        },
        headsign: "Downtown",
        scheduledAt: "2026-04-06T10:00:00Z",
      },
    ]);

    const getVehicleJourney = vi.fn().mockResolvedValue({
      id: "tp:trip-1",
      name: "Bus 1",
      provider: "test-provider",
      stops: [
        { stopId: "tp:s1", name: "First", lat: 50.1, lng: 6.1, platform: "1" },
        { stopId: "tp:s2", name: "Second", lat: 50.2, lng: 6.2, platform: "2" },
      ],
    });

    const orchestrator = new TransitOrchestrator();
    orchestrator.register(
      makeProvider({
        id: "test-provider",
        prefix: "tp:",
        getDepartures: departures,
        getVehicleJourney,
      }),
    );

    const stops = await orchestrator.getRouteStops("tp:r-1", "tp:hint-stop");

    expect(departures).toHaveBeenCalledWith("tp:hint-stop", 720);
    expect(getVehicleJourney).toHaveBeenCalledWith("tp:trip-1");
    expect(stops).toHaveLength(2);
    expect(stops[0]).toMatchObject({
      id: "tp:s1",
      name: "First",
      lat: 50.1,
      lng: 6.1,
      platformCode: "1",
    });
  });

  it("uses provider route-stops endpoint when available and non-empty", async () => {
    const getRouteStops = vi.fn().mockResolvedValue([
      {
        id: "tp:s1",
        name: "First",
        lat: 50.1,
        lng: 6.1,
        modes: ["bus"],
        provider: "test-provider",
      },
    ]);
    const departures = vi.fn().mockResolvedValue([]);
    const getVehicleJourney = vi.fn().mockResolvedValue(null);

    const orchestrator = new TransitOrchestrator();
    orchestrator.register(
      makeProvider({
        id: "test-provider",
        prefix: "tp:",
        getRouteStops,
        getDepartures: departures,
        getVehicleJourney,
      }),
    );

    const stops = await orchestrator.getRouteStops("tp:r-1", "tp:hint-stop");

    expect(stops).toHaveLength(1);
    expect(getRouteStops).toHaveBeenCalledWith("tp:r-1", "tp:hint-stop");
    expect(departures).not.toHaveBeenCalled();
    expect(getVehicleJourney).not.toHaveBeenCalled();
  });
});
