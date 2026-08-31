import type { RentalsResponse } from "@motis-project/motis-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMotisRentalId,
  decodeMotisRentalId,
  fetchMotisRentals,
  mapMotisRentalSnapshot,
  setMotisRentalSourceIndex,
  setSharedMobilityMotisUrl,
  setSharedMobilityTransitousUrl,
} from "../src/motis-rentals.js";
import { encodePolyline } from "../src/polyline.js";

const outer = [
  [13.36, 52.51],
  [13.42, 52.51],
  [13.42, 52.54],
  [13.36, 52.54],
  [13.36, 52.51],
] as [number, number][];
const hole = [
  [13.38, 52.52],
  [13.39, 52.52],
  [13.39, 52.53],
  [13.38, 52.53],
  [13.38, 52.52],
] as [number, number][];
const polygon = [
  [
    { points: encodePolyline(outer, 6), precision: 6, length: outer.length },
    { points: encodePolyline(hole, 6), precision: 6, length: hole.length },
  ],
];

function provider(id: string, formFactor: "BICYCLE" | "SCOOTER_STANDING") {
  const typeId = formFactor === "BICYCLE" ? "bike/type:ä" : "scooter";
  return {
    id,
    name: `${id} display`,
    groupId: "group/all",
    operator: `${id} operator`,
    url: `https://${id}.example.test`,
    purchaseUrl: `https://${id}.example.test/join`,
    color: "#123456",
    bbox: [13.3, 52.4, 13.5, 52.6] as [number, number, number, number],
    vehicleTypes: [
      {
        id: typeId,
        name: `${id} vehicle`,
        formFactor,
        propulsionType: formFactor === "BICYCLE" ? ("HUMAN" as const) : ("ELECTRIC" as const),
        returnConstraint: "ANY_STATION" as const,
        returnConstraintGuessed: false,
      },
    ],
    formFactors: [formFactor],
    defaultRestrictions: {
      vehicleTypeIdxs: [],
      rideStartAllowed: true,
      rideEndAllowed: true,
      rideThroughAllowed: true,
    },
    globalGeofencingRules: [
      {
        vehicleTypeIdxs: [0],
        rideStartAllowed: true,
        rideEndAllowed: false,
        rideThroughAllowed: true,
        stationParking: true,
      },
    ],
  };
}

function fixture(): RentalsResponse {
  const bike = provider("provider/ä", "BICYCLE");
  const scooter = provider("competitor", "SCOOTER_STANDING");
  return {
    providerGroups: [
      {
        id: "group/all",
        name: "All mobility",
        color: "#abcdef",
        providers: [bike.id, scooter.id],
        formFactors: ["BICYCLE", "SCOOTER_STANDING"],
      },
    ],
    providers: [bike, scooter],
    stations: [
      {
        id: "station:/中央",
        providerId: bike.id,
        providerGroupId: "group/all",
        name: "Mixed station",
        lat: 52.525,
        lon: 13.369,
        address: "Main Street 1",
        crossStreet: "Central Avenue",
        rentalUriAndroid: "app://android/station",
        rentalUriIOS: "app://ios/station",
        rentalUriWeb: "https://bike.example.test/station",
        isRenting: true,
        isReturning: false,
        numVehiclesAvailable: 9,
        formFactors: ["BICYCLE", "SCOOTER_STANDING"],
        vehicleTypesAvailable: { "bike/type:ä": 2, scooter: 7 },
        vehicleDocksAvailable: { "bike/type:ä": 0, scooter: 4 },
        stationArea: polygon,
        bbox: [13.36, 52.52, 13.38, 52.53],
      },
    ],
    vehicles: [
      {
        id: "same/native:id",
        providerId: bike.id,
        providerGroupId: "group/all",
        typeId: "bike/type:ä",
        lat: 52.526,
        lon: 13.37,
        formFactor: "BICYCLE",
        propulsionType: "HUMAN",
        returnConstraint: "ROUNDTRIP_STATION",
        stationId: "station:/中央",
        homeStationId: "home/one",
        isReserved: false,
        isDisabled: false,
        rentalUriAndroid: "app://android/vehicle",
        rentalUriIOS: "app://ios/vehicle",
        rentalUriWeb: "https://bike.example.test/vehicle",
      },
      {
        id: "same/native:id",
        providerId: scooter.id,
        providerGroupId: "group/all",
        typeId: "scooter",
        lat: 52.526,
        lon: 13.37,
        formFactor: "SCOOTER_STANDING",
        propulsionType: "ELECTRIC",
        returnConstraint: "NONE",
        isReserved: false,
        isDisabled: false,
      },
    ],
    zones: [
      {
        providerId: bike.id,
        providerGroupId: "group/all",
        name: "Parking area",
        z: 7,
        bbox: [13.36, 52.51, 13.42, 52.54],
        area: polygon,
        rules: [
          {
            vehicleTypeIdxs: [0],
            rideStartAllowed: true,
            rideEndAllowed: false,
            rideThroughAllowed: true,
            stationParking: true,
          },
        ],
      },
    ],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setMotisRentalSourceIndex([]);
  setSharedMobilityMotisUrl(undefined);
  setSharedMobilityTransitousUrl(undefined);
});

describe("complete MOTIS rental mapping", () => {
  it("maps collision-safe identities, providers, rules, holes, URIs, and filtered counts", () => {
    setMotisRentalSourceIndex([
      { sourceId: "mobilitydata:de:bike", registrySystemId: "provider/ä" },
    ]);
    const snapshot = mapMotisRentalSnapshot(fixture(), "motis-local", ["bicycle"]);
    expect(snapshot.origin).toBe("motis-local");
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providerGroups[0]).toMatchObject({ nativeId: "group/all" });
    expect(snapshot.providers[0]).toMatchObject({
      nativeId: "provider/ä",
      sourceId: "mobilitydata:de:bike",
      globalRestrictions: [
        {
          rideEndAllowed: false,
          stationParking: true,
          vehicleTypeIds: [expect.stringContaining("/type/")],
        },
      ],
    });
    expect(snapshot.stations[0]).toMatchObject({
      nativeId: "station:/中央",
      availableVehicles: 2,
      emptySlots: 0,
      capacity: 2,
      isRenting: true,
      isReturning: false,
      crossStreet: "Central Avenue",
      sources: ["mobilitydata:de:bike"],
      rentalUris: {
        web: "https://bike.example.test/station",
        android: "app://android/station",
        ios: "app://ios/station",
      },
    });
    expect(snapshot.stations[0]?.stationArea?.coordinates[0]).toHaveLength(2);
    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.vehicles[0]).toMatchObject({
      nativeId: "same/native:id",
      returnConstraint: "roundtrip_station",
      stationId: expect.stringContaining("/station/"),
      homeStationId: expect.stringContaining("/station/"),
    });
    expect(snapshot.zones[0]).toMatchObject({
      z: 7,
      rules: [{ rideEndAllowed: false, stationParking: true }],
    });
    expect(snapshot.zones[0]?.area.coordinates[0]).toHaveLength(2);
    expect(snapshot.completeness.warnings).toEqual([]);
  });

  it("keeps identical native IDs distinct across providers and roundtrips arbitrary segments", () => {
    const snapshot = mapMotisRentalSnapshot(fixture(), "motis-local");
    expect(snapshot.vehicles).toHaveLength(2);
    expect(new Set(snapshot.vehicles.map((vehicle) => vehicle.id)).size).toBe(2);
    const id = createMotisRentalId("motis-local", "provider/ä", "station", "station:/中央");
    expect(decodeMotisRentalId(id)).toEqual({
      origin: "motis-local",
      providerId: "provider/ä",
      kind: "station",
      nativeId: "station:/中央",
    });
  });

  it("preserves zero versus missing docks and independent rent/return state", () => {
    const response = fixture();
    const first = response.stations[0];
    if (!first) throw new Error("fixture must contain a station");
    first.isRenting = false;
    first.isReturning = true;
    let snapshot = mapMotisRentalSnapshot(response, "motis-local", ["bicycle"]);
    expect(snapshot.stations[0]).toMatchObject({
      emptySlots: 0,
      capacity: 2,
      isRenting: false,
      isReturning: true,
      isActive: true,
    });

    first.vehicleDocksAvailable = {};
    first.isReturning = false;
    snapshot = mapMotisRentalSnapshot(response, "motis-local", ["bicycle"]);
    expect(snapshot.stations[0]?.emptySlots).toBeUndefined();
    expect(snapshot.stations[0]?.capacity).toBeUndefined();
    expect(snapshot.stations[0]?.isActive).toBe(false);
  });

  it("keeps other providers when one zone geometry is malformed", () => {
    const response = fixture();
    const firstPoint = response.zones[0]?.area[0]?.[0];
    if (!firstPoint) throw new Error("fixture must contain a zone geometry");
    firstPoint.precision = 5;
    const snapshot = mapMotisRentalSnapshot(response, "motis-local");
    expect(snapshot.providers).toHaveLength(2);
    expect(snapshot.zones).toEqual([]);
    expect(snapshot.completeness.zones).toBe(false);
    expect(snapshot.completeness.warnings[0]).toContain("expected 6");
  });

  it("hard-fails an unresolved provider-local rule index", () => {
    const response = fixture();
    const firstRule = response.providers[0]?.globalGeofencingRules[0];
    if (!firstRule) throw new Error("fixture must contain a geofencing rule");
    firstRule.vehicleTypeIdxs = [99];
    expect(() => mapMotisRentalSnapshot(response, "motis-local")).toThrow(
      /missing vehicle type index 99/,
    );
  });
});

describe("MOTIS rental request fallback", () => {
  function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function requestUrl(input: string | URL | Request): string {
    return input instanceof Request ? input.url : String(input);
  }

  function requestMethod(input: string | URL | Request, init?: RequestInit): string {
    return input instanceof Request ? input.method : (init?.method ?? "GET");
  }

  it("does no HEAD preflight and treats a healthy empty local snapshot as authoritative", async () => {
    setSharedMobilityMotisUrl("https://local.test");
    setSharedMobilityTransitousUrl("https://hosted.test");
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: requestUrl(input), method: requestMethod(input, init) });
        return jsonResponse({
          providerGroups: [],
          providers: [],
          stations: [],
          vehicles: [],
          zones: [],
        });
      }),
    );
    const snapshot = await fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("motis-local");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).not.toBe("HEAD");
    expect(calls[0]?.url).toContain("local.test");
  });

  it("falls back to hosted only for a local transport/5xx failure", async () => {
    setSharedMobilityMotisUrl("https://local.test");
    setSharedMobilityTransitousUrl("https://hosted.test");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = requestUrl(input);
        calls.push(url);
        return url.includes("local.test")
          ? jsonResponse({ message: "down" }, 503)
          : jsonResponse(fixture());
      }),
    );
    const snapshot = await fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("transitous");
    expect(calls.some((url) => url.includes("hosted.test"))).toBe(true);
  });

  it("does not hide a local 4xx contract failure behind hosted fallback", async () => {
    setSharedMobilityMotisUrl("https://local.test");
    setSharedMobilityTransitousUrl("https://hosted.test");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        calls.push(requestUrl(input));
        return jsonResponse({ message: "bad request" }, 400);
      }),
    );
    const snapshot = await fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("motis-local");
    expect(snapshot.completeness.warnings).toContain("HTTP 400");
    expect(calls).toHaveLength(1);
  });
});
