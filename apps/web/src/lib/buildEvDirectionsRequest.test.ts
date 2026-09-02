import { describe, expect, it } from "vitest";
import {
  buildEvDirectionsRequest,
  type EvDirectionsRequestInput,
  garageVehicleId,
} from "./buildEvDirectionsRequest";

const SPEC = {
  batteryKwh: 64,
  baseWhPerKm: 170,
  massTonnes: 2,
  maxDcKw: 150,
  maxAcKw: 11,
  vehicleTaperSocPct: 80,
  connectors: ["ccs2" as const],
};

function input(patch: Partial<EvDirectionsRequestInput> = {}): EvDirectionsRequestInput {
  return {
    isEvMode: true,
    waypoints: [
      [6.6, 51.5],
      [7.0, 51.9],
    ],
    allWaypointsFilled: true,
    vehicleId: "volkswagen:id_4:2024:id_4",
    garageVehicle: null,
    socStartPct: 80,
    socArrivalMinPct: 10,
    socTargetPct: 80,
    avoidHighways: false,
    avoidTolls: false,
    avoidFerries: false,
    avoidClosures: true,
    preferredNetworks: [],
    avoidedNetworks: [],
    exclusiveNetworks: false,
    forceNonExclusive: false,
    preferCheaper: true,
    homePricePerKwh: null,
    homeCurrency: "EUR",
    units: "metric",
    lang: "en",
    ...patch,
  };
}

describe("buildEvDirectionsRequest", () => {
  it("sends a dataset preset by id", () => {
    expect(buildEvDirectionsRequest(input())).toMatchObject({
      vehicleId: "volkswagen:id_4:2024:id_4",
    });
  });

  it("sends a garage vehicle as an inline spec", () => {
    const request = buildEvDirectionsRequest(
      input({ vehicleId: garageVehicleId("v1"), garageVehicle: SPEC }),
    );
    expect(request).toMatchObject({ vehicle: SPEC });
    expect(request).not.toHaveProperty("vehicleId");
  });

  it("returns null when a garage selection cannot be resolved", () => {
    expect(
      buildEvDirectionsRequest(
        input({ vehicleId: garageVehicleId("deleted"), garageVehicle: null }),
      ),
    ).toBeNull();
  });

  it("returns null when no vehicle is selected", () => {
    expect(buildEvDirectionsRequest(input({ vehicleId: null }))).toBeNull();
  });

  it("returns null outside EV mode or with an unfilled waypoint", () => {
    expect(buildEvDirectionsRequest(input({ isEvMode: false }))).toBeNull();
    expect(buildEvDirectionsRequest(input({ allWaypointsFilled: false }))).toBeNull();
  });
});
