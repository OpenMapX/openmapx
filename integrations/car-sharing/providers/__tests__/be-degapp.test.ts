import { describe, expect, it } from "vitest";
import { parseDegapp } from "../be-degapp.js";

const COOPSTROOM = { sourceId: "be-coopstroom", operator: "CoopStroom" };
const DEGAGE = { sourceId: "be-degage", operator: "Dégage" };

describe("parseDegapp — CoopStroom shape", () => {
  const body = JSON.stringify([
    {
      geoPosition: { latitude: 51.140066, longitude: 3.332612 },
      displayName: "CoopStroom - Claudio - Nissan e-NV200 - Beernem",
      vehicleInformation: {
        brand: "Nissan",
        model: "Nissan e-NV200 2018",
        category: "mpv_car",
        fuelType: "electric",
        transmissionType: "automatic",
      },
      isAvailable: true,
      stationName: "Beernem - Gemeentehuis",
      stationType: "fixed",
    },
    {
      geoPosition: { latitude: 51.149427, longitude: 3.237669 },
      displayName: "CoopStroom - Zoé - Renault Zoë - Oostkamp",
      vehicleInformation: { brand: "Renault", model: "Renault ZOE 40kWh", fuelType: "electric" },
      isAvailable: false,
      stationName: "Oostkamp",
      stationType: "fixed",
    },
  ]);

  it("maps an available electric car with make/model/propulsion and transmission", () => {
    const [station] = parseDegapp(body, COOPSTROOM);
    expect(station).toMatchObject({
      id: "be-coopstroom/coopstroom-claudio-nissan-e-nv200-beernem",
      name: "Beernem - Gemeentehuis",
      coordinates: [3.332612, 51.140066],
      availableVehicles: 1,
      operator: "CoopStroom",
      vehicleTypes: ["car"],
      stationType: "fixed",
      isActive: true,
      isRenting: true,
      sources: ["be-coopstroom"],
      vehicleTypeDetails: [
        {
          name: "Nissan e-NV200 2018",
          formFactor: "car",
          make: "Nissan",
          model: "Nissan e-NV200 2018",
          propulsion: "electric",
          accessories: ["automatic"],
        },
      ],
    });
  });

  it("reports 0 available cars when isAvailable is false", () => {
    const stations = parseDegapp(body, COOPSTROOM);
    expect(stations[1].availableVehicles).toBe(0);
    expect(stations[1].isRenting).toBe(false);
  });
});

describe("parseDegapp — Dégage shape", () => {
  const body = JSON.stringify([
    {
      geoPosition: { latitude: 51.05259, longitude: 3.70554 },
      vehicleInformation: { fuelType: "diesel", type: "manual" },
      displayName: "BlackBird",
      stationType: "fixed",
      vehicleId: 3,
    },
  ]);

  it("uses vehicleId for the id and assumes availability when no field is present", () => {
    const [station] = parseDegapp(body, DEGAGE);
    expect(station).toMatchObject({
      id: "be-degage/3",
      name: "BlackBird",
      availableVehicles: 1, // no isAvailable field → assumed available
      isRenting: true,
      operator: "Dégage",
      vehicleTypeDetails: [
        {
          name: "Car",
          formFactor: "car",
          propulsion: "combustion_diesel",
          accessories: ["manual"],
        },
      ],
    });
  });
});

describe("parseDegapp — resilience", () => {
  it("skips entries without a geoPosition", () => {
    const body = JSON.stringify([
      { displayName: "no-coords" },
      { geoPosition: { latitude: 51, longitude: 3.7 }, vehicleId: 9 },
    ]);
    const stations = parseDegapp(body, DEGAGE);
    expect(stations).toHaveLength(1);
    expect(stations[0].id).toBe("be-degage/9");
  });

  it("returns an empty array for a non-array body", () => {
    expect(parseDegapp(JSON.stringify({ error: "nope" }), DEGAGE)).toEqual([]);
  });

  it("maps propulsion for the various cooperative fuel types", () => {
    const fuels: [string, string | undefined][] = [
      ["gasoline", "combustion"],
      ["cng", "combustion"],
      ["lpg", "combustion"],
      ["hybrid", "hybrid"],
      ["pluginhybrid", "plug_in_hybrid"],
      ["mystery", undefined],
    ];
    for (const [fuelType, expected] of fuels) {
      const body = JSON.stringify([
        {
          geoPosition: { latitude: 51, longitude: 3.7 },
          vehicleId: fuelType,
          vehicleInformation: { fuelType },
        },
      ]);
      const [station] = parseDegapp(body, DEGAGE);
      expect(station.vehicleTypeDetails?.[0]?.propulsion).toBe(expected);
    }
  });
});
