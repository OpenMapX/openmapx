import type { RentalsResponse } from "@motis-project/motis-client";
import { describe, expect, it } from "vitest";
import {
  createMotisRentalId,
  createMotisRentalsClient,
  decodeMotisRentalId,
  type MotisRentalsHttp,
  mapMotisRentalSnapshot,
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
        stationArea: structuredClone(polygon),
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
        area: structuredClone(polygon),
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

describe("complete MOTIS rental mapping", () => {
  it("maps collision-safe identities, providers, rules, holes, URIs, and filtered counts", () => {
    const snapshot = mapMotisRentalSnapshot(
      fixture(),
      "motis-local",
      ["bicycle"],
      [{ sourceId: "mobilitydata:de:bike", registrySystemId: "provider/ä" }],
    );
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
  function jsonResponse(value: unknown, status = 200) {
    return { status, body: JSON.stringify(value) };
  }

  /** A rental client answering each request URL (with its query) from `answer`. */
  function rentalsHttp(
    answer: (
      url: string,
    ) => { status: number; body: string } | Promise<{ status: number; body: string }>,
  ): MotisRentalsHttp {
    return {
      async getText(url, options) {
        const requestUrl = new URL(url);
        for (const [name, value] of Object.entries(options.params)) {
          requestUrl.searchParams.set(name, String(value));
        }
        const response = await answer(requestUrl.toString());
        return response.status >= 200 && response.status < 300
          ? response
          : { ...response, body: "" };
      },
    };
  }

  it("does no HEAD preflight and treats a healthy empty local snapshot as authoritative", async () => {
    const calls: string[] = [];
    const client = createMotisRentalsClient({
      http: rentalsHttp((url) => {
        calls.push(url);
        return jsonResponse({
          providerGroups: [],
          providers: [],
          stations: [],
          vehicles: [],
          zones: [],
        });
      }),
      motisUrl: "https://local.test",
      transitousUrl: "https://hosted.test",
    });
    const snapshot = await client.fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("motis-local");
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0] ?? "");
    expect(url.origin + url.pathname).toBe("https://local.test/api/v1/rentals");
    expect(url.searchParams.get("min")).toBe("52.4,13.3");
    expect(url.searchParams.get("max")).toBe("52.6,13.5");
    expect(url.searchParams.get("withZones")).toBe("true");
  });

  it("asks Transitous directly when the deployment has no local MOTIS", async () => {
    const calls: string[] = [];
    const client = createMotisRentalsClient({
      http: rentalsHttp((url) => {
        calls.push(url);
        return jsonResponse(fixture());
      }),
      transitousUrl: "https://hosted.test",
    });
    const snapshot = await client.fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("transitous");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("hosted.test");
  });

  it("falls back to hosted only for a local transport/5xx failure", async () => {
    const calls: string[] = [];
    const client = createMotisRentalsClient({
      http: rentalsHttp((url) => {
        calls.push(url);
        return url.includes("local.test")
          ? jsonResponse({ message: "down" }, 503)
          : jsonResponse(fixture());
      }),
      motisUrl: "https://local.test",
      transitousUrl: "https://hosted.test",
    });
    const snapshot = await client.fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("transitous");
    expect(calls.some((url) => url.includes("hosted.test"))).toBe(true);
  });

  it("falls back to hosted when the local request fails outright", async () => {
    const client = createMotisRentalsClient({
      http: rentalsHttp((url) => {
        if (url.includes("local.test")) throw new Error("connect ECONNREFUSED");
        return jsonResponse(fixture());
      }),
      motisUrl: "https://local.test",
      transitousUrl: "https://hosted.test",
    });
    expect((await client.fetchMotisRentals([13.3, 52.4, 13.5, 52.6])).origin).toBe("transitous");
  });

  it("does not hide a local 4xx contract failure behind hosted fallback", async () => {
    const calls: string[] = [];
    const client = createMotisRentalsClient({
      http: rentalsHttp((url) => {
        calls.push(url);
        return jsonResponse({ message: "bad request" }, 400);
      }),
      motisUrl: "https://local.test",
      transitousUrl: "https://hosted.test",
    });
    const snapshot = await client.fetchMotisRentals([13.3, 52.4, 13.5, 52.6]);
    expect(snapshot.origin).toBe("motis-local");
    expect(snapshot.completeness.warnings).toContain("HTTP 400");
    expect(calls).toHaveLength(1);
  });
});

it("captures known Transitous branch for stations, vehicles and station-area geometry without guessing unknown networks", () => {
  const receipt = {
    sourceId: "transitous",
    name: "Transitous",
    attributionText: "Original transit credit",
  };
  const mapped = mapMotisRentalSnapshot(fixture(), "transitous", undefined, [], (ids) =>
    ids.includes("transitous") ? [receipt] : [],
  );
  expect(mapped.stations[0]?.sources).toContain("transitous");
  expect(mapped.stations[0]?.contributors).toEqual([receipt]);
  expect(mapped.vehicles[0]?.contributors).toEqual([receipt]);
  expect(mapped.providers[0]?.contributors).toEqual([receipt]);
  expect(mapped.zones[0]?.contributors).toEqual([receipt]);
});
