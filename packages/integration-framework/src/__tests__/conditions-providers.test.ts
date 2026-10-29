import type { BorderCrossing } from "@openmapx/mobility-core/border-crossing";
import type { RoadWeatherStation } from "@openmapx/mobility-core/road-weather";
import type { ServiceVehicle } from "@openmapx/mobility-core/service-vehicle";
import { describe, expect, test } from "vitest";
import type { BorderCrossingProvider } from "../contracts/border-crossing-provider.js";
import type { RoadWeatherProvider } from "../contracts/road-weather-provider.js";
import type { ServiceVehicleProvider } from "../contracts/service-vehicle-provider.js";
import { createMockIntegrationContext } from "../testing/index.js";

const station: RoadWeatherStation = {
  id: "oc:feature:fi-test-weather:1001",
  name: "Road 1 Espoo, Nupuri",
  coordinates: [24.596399, 60.228227],
  status: "operational",
  air: { temperatureC: { value: 9.7 } },
  surface: [{ index: 1, state: { value: "dry" } }],
  stale: false,
  sources: ["fi-test-weather"],
  attributions: [],
};

const vehicle: ServiceVehicle = {
  id: "oc:observation:fi-test-maintenance:1",
  coordinates: [25.5, 65.0],
  activity: "plowing",
  plowDown: true,
  tasks: ["PLOUGHING_AND_SLUSH_REMOVAL"],
  observedAt: "2026-10-14T23:20:57Z",
  sources: ["fi-test-maintenance"],
  attributions: [],
};

const crossing: BorderCrossing = {
  id: "oc:feature:us-test-waits:090101",
  name: "Peace Bridge",
  coordinates: [-78.9056, 42.9069],
  countries: ["CA", "US"],
  queues: [
    {
      key: "passenger/standard",
      mode: "passenger",
      program: "standard",
      from: "CA",
      to: "US",
      status: "delay",
      waitMinutes: 20,
      stale: false,
    },
  ],
  sources: ["us-test-waits"],
  attributions: [],
};

describe("OpenConditions-domain registrars", () => {
  test("registerRoadWeatherProvider stores the provider under roadWeather", async () => {
    const ctx = createMockIntegrationContext();
    const provider: RoadWeatherProvider = {
      id: "test",
      searchStations: async () => ({ stations: [station] }),
      getStation: async () => station,
    };
    ctx.registerRoadWeatherProvider(provider);
    expect(ctx.registered.roadWeather).toEqual([provider]);
    await expect(ctx.registered.roadWeather[0]?.getStation(station.id)).resolves.toBe(station);
  });

  test("registerServiceVehicleProvider stores the provider under serviceVehicles", async () => {
    const ctx = createMockIntegrationContext();
    const provider: ServiceVehicleProvider = {
      id: "test",
      searchVehicles: async () => ({ vehicles: [vehicle] }),
      getVehicle: async () => vehicle,
    };
    ctx.registerServiceVehicleProvider(provider);
    expect(ctx.registered.serviceVehicles).toEqual([provider]);
    await expect(ctx.registered.serviceVehicles[0]?.getVehicle(vehicle.id)).resolves.toBe(vehicle);
  });

  test("registerBorderCrossingProvider stores the provider under borderCrossings", async () => {
    const ctx = createMockIntegrationContext();
    const provider: BorderCrossingProvider = {
      id: "test",
      searchCrossings: async () => ({ crossings: [crossing] }),
      getCrossing: async () => crossing,
    };
    ctx.registerBorderCrossingProvider(provider);
    expect(ctx.registered.borderCrossings).toEqual([provider]);
    await expect(ctx.registered.borderCrossings[0]?.getCrossing(crossing.id)).resolves.toBe(
      crossing,
    );
  });
});
