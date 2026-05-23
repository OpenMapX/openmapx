import { afterEach, describe, expect, it, vi } from "vitest";

const API_BASE = "https://api.transport.nsw.gov.au/v1";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadProvider() {
  vi.resetModules();
  return import("../nsw-au.js");
}

/**
 * Fixture from TfNSW Car Park API documentation v2.3, section 2.1.5 (Sample feed).
 * All numeric values are strings on the wire.
 */
const TALLAWONG_P1_DETAIL = {
  tsn: "2155384",
  time: "785808515",
  spots: "123",
  zones: [
    {
      spots: "123",
      zone_id: "1",
      occupancy: {
        loop: "4786",
        total: "123",
        monthlies: null,
        open_gate: null,
        transients: null,
      },
      zone_name: "SYD396A Tallawong P1 Car Park",
      parent_zone_id: "0",
    },
  ],
  ParkID: "1",
  location: {
    suburb: "Tallawong",
    address: "Conferta Avenue",
    latitude: "-33.69304704",
    longitude: "150.9052577",
  },
  occupancy: {
    loop: "4786",
    total: "123",
    monthlies: null,
    open_gate: null,
    transients: null,
  },
  MessageDate: "2024-11-25T11:08:35",
  facility_id: "26",
  facility_name: "Park&Ride - Tallawong P1",
  tfnsw_facility_id: "2155384TPR001",
};

describe("nsw-au buildNswFacility", () => {
  it("parses the v2.3 sample-feed detail into a ParkingFacility", async () => {
    const { buildNswFacility } = await loadProvider();

    const facility = buildNswFacility(
      { facility_id: "26", facility_name: "Park&Ride - Tallawong P1" },
      TALLAWONG_P1_DETAIL,
    );

    expect(facility).not.toBeNull();
    if (!facility) return;

    expect(facility.id).toBe("nsw:26");
    expect(facility.name).toBe("Park&Ride - Tallawong P1");
    // detail.location overrides the static fallback
    expect(facility.coordinates[0]).toBeCloseTo(150.9052577, 6);
    expect(facility.coordinates[1]).toBeCloseTo(-33.69304704, 6);
    // capacity = Number(spots), freeSpaces = spots - total
    expect(facility.capacity).toBe(123);
    expect(facility.freeSpaces).toBe(0);
    expect(facility.hasRealtimeData).toBe(true);
    expect(facility.dataUpdatedAt).toBe("2024-11-25T11:08:35");
    expect(facility.realtimeDataUpdatedAt).toBe("2024-11-25T11:08:35");
    expect(facility.parkAndRide).toBe(true);
    expect(facility.fee).toBe("free");
    expect(facility.address).toBe("Conferta Avenue, Tallawong");
  });

  it("computes freeSpaces = spots - total when partially occupied", async () => {
    const { buildNswFacility } = await loadProvider();

    const facility = buildNswFacility(
      { facility_id: "26", facility_name: "Park&Ride - Tallawong P1" },
      {
        ...TALLAWONG_P1_DETAIL,
        spots: "200",
        occupancy: { ...TALLAWONG_P1_DETAIL.occupancy, total: "75" },
      },
    );

    expect(facility?.capacity).toBe(200);
    expect(facility?.freeSpaces).toBe(125);
  });

  it("falls back to KNOWN_FACILITIES coordinates and capacity when no detail is supplied", async () => {
    const { buildNswFacility } = await loadProvider();

    const facility = buildNswFacility({
      facility_id: "26",
      facility_name: "Park&Ride - Tallawong P1",
    });

    expect(facility).not.toBeNull();
    if (!facility) return;
    // TSN coordinates from documentation section 4 for ID 26
    expect(facility.coordinates[0]).toBeCloseTo(150.906022, 6);
    expect(facility.coordinates[1]).toBeCloseTo(-33.69163, 5);
    expect(facility.capacity).toBe(121);
    expect(facility.hasRealtimeData).toBe(false);
    expect(facility.freeSpaces).toBeUndefined();
  });

  it("returns null for an unknown facility with no detail", async () => {
    const { buildNswFacility } = await loadProvider();
    expect(buildNswFacility({ facility_id: "99999", facility_name: "Unknown" })).toBeNull();
  });
});

describe("nsw-au searchNswAu", () => {
  it("queries the list endpoint then a per-facility detail call", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === `${API_BASE}/carpark`) {
        return new Response(
          JSON.stringify([{ facility_id: "26", facility_name: "Park&Ride - Tallawong P1" }]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.startsWith(`${API_BASE}/carpark?facility=26`)) {
        return new Response(JSON.stringify(TALLAWONG_P1_DETAIL), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchNswAu, setNswTransportApiKey } = await loadProvider();
    setNswTransportApiKey("test-key");

    const results = await searchNswAu({
      south: -33.7,
      west: 150.9,
      north: -33.68,
      east: 150.91,
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("nsw:26");
    expect(results[0].capacity).toBe(123);
    expect(results[0].freeSpaces).toBe(0);
    expect(results[0].hasRealtimeData).toBe(true);
  });
});
