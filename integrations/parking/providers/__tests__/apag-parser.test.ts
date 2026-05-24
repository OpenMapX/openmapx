import { describe, expect, it, vi } from "vitest";
import { parseApagBundled } from "../apag-parser.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function ctx() {
  return {
    log,
    sourceId: "apag",
    sourceDomain: "parking",
    jobId: "test",
    kind: "bundled" as const,
    config: {},
  };
}

const SAMPLE = [
  {
    uuid: "99aadd76-3bc9-4fcb-896e-d7480ea5df78",
    type: "ParkingFacility",
    name: "Pontstraße",
    label: "Parkplatz Pontstraße",
    lat: 50.781642,
    lng: 6.0797,
    address_street: "Wittekindstraße",
    address_zip: "52062",
    address_city: "Aachen",
    capacity_parking: 60,
    capacity_charging: null,
    available_parking: 26,
    available_charging: null,
    facility_type: { de: "Parkplatz", en: "Parking lot" },
    opening_times: "Mo-Sa 07:00-20:00",
    entrance_height: "2.00 m",
    short_term_parking_rates: [{ rate_type_name: "Tages-Tarif", prices: "1,50 € / 60 Min." }],
    updated_at: "2024-01-01T00:00:00Z",
  },
  {
    uuid: "99aadd76-32ca-4734-9598-e11386c84b70",
    type: "ParkingFacility",
    name: "Eurogress",
    label: "Parkhaus Eurogress",
    lat: 50.780654,
    lng: 6.09267,
    address_street: "Monheimsallee 48",
    address_zip: "52062",
    address_city: "Aachen",
    capacity_parking: 700,
    capacity_charging: 8,
    available_parking: 0,
    facility_type: { de: "Parkhaus", en: "Car park" },
    opening_times: "24/7",
    entrance_height: "1.90 m",
  },
  {
    // Non-parking entry — must be skipped.
    uuid: "00000000-0000-0000-0000-000000000001",
    type: "BikeStation",
    name: "Bike X",
    lat: 50.78,
    lng: 6.09,
  },
  {
    // Missing coordinates — must be skipped.
    uuid: "00000000-0000-0000-0000-000000000002",
    type: "ParkingFacility",
    name: "No coords",
    capacity_parking: 10,
  },
];

describe("parseApagBundled", () => {
  it("emits only ParkingFacility entries with valid coordinates", async () => {
    const parse = parseApagBundled();
    const { static: rows } = await parse(Buffer.from(JSON.stringify(SAMPLE)), ctx());
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.poiId).sort()).toEqual([
      "99aadd76-32ca-4734-9598-e11386c84b70",
      "99aadd76-3bc9-4fcb-896e-d7480ea5df78",
    ]);
  });

  it("maps facility_type.de to canonical parkingType", async () => {
    const parse = parseApagBundled();
    const { static: rows } = await parse(Buffer.from(JSON.stringify(SAMPLE)), ctx());
    const pont = rows.find((r) => r.payload.name === "Parkplatz Pontstraße");
    const eurog = rows.find((r) => r.payload.name === "Parkhaus Eurogress");
    expect(pont?.payload.parkingType).toBe("surface");
    expect(eurog?.payload.parkingType).toBe("garage");
  });

  it("converts entrance_height to centimeters", async () => {
    const parse = parseApagBundled();
    const { static: rows } = await parse(Buffer.from(JSON.stringify(SAMPLE)), ctx());
    const eurog = rows.find((r) => r.payload.name === "Parkhaus Eurogress");
    expect(eurog?.payload.maxHeight).toBe(190);
    const pont = rows.find((r) => r.payload.name === "Parkplatz Pontstraße");
    expect(pont?.payload.maxHeight).toBe(200);
  });

  it("joins address into a single string and carries operator + fee=paid", async () => {
    const parse = parseApagBundled();
    const { static: rows } = await parse(Buffer.from(JSON.stringify(SAMPLE)), ctx());
    const pont = rows.find((r) => r.payload.name === "Parkplatz Pontstraße");
    expect(pont?.payload.address).toBe("Wittekindstraße, 52062 Aachen");
    expect(pont?.payload.operator).toBe("APAG - Aachener Parkhaus GmbH");
    expect(pont?.payload.fee).toBe("paid");
    expect(pont?.payload.feeDescription).toBe("1,50 € / 60 Min.");
  });

  it("emits live entries for facilities with numeric available_parking (incl. zero)", async () => {
    const parse = parseApagBundled();
    const { live } = await parse(Buffer.from(JSON.stringify(SAMPLE)), ctx());
    expect(live.size).toBe(2);
    expect(live.get("99aadd76-3bc9-4fcb-896e-d7480ea5df78")).toMatchObject({ freeSpaces: 26 });
    expect(live.get("99aadd76-32ca-4734-9598-e11386c84b70")).toMatchObject({ freeSpaces: 0 });
  });

  it("returns empty result for non-JSON or non-array payload", async () => {
    const parse = parseApagBundled();
    const a = await parse(Buffer.from("not json"), ctx());
    expect(a).toEqual({ static: [], live: new Map() });
    const b = await parse(Buffer.from(JSON.stringify({})), ctx());
    expect(b).toEqual({ static: [], live: new Map() });
  });
});
