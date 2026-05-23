import { afterEach, describe, expect, it, vi } from "vitest";

const STATIC_API = "https://www.netraveldata.co.uk/api/v2/carpark/static";
const DYNAMIC_API = "https://www.netraveldata.co.uk/api/v2/carpark/dynamic";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadProvider() {
  vi.resetModules();
  return import("../utmc-newcastle.js");
}

/**
 * Fixtures lifted from sections 5.4 and 6.4 of the Tyne and Wear Open Data
 * Services Platform API Specification (Mott MacDonald, October 2019).
 */
const STATIC_CP1 = {
  systemCodeNumber: "CP1",
  definitions: [
    {
      shortDescription: "Town Centre",
      longDescription: "Car park in Newcastle Town Centre",
      point: {
        easting: 999999,
        northing: 199999,
        latitude: 54.9755208253257,
        longitude: -1.62522866852692,
      },
      lastUpdated: "2012-01-13T12:19:32.419+0000",
    },
  ],
  configurations: [
    {
      capacity: 200,
      configurationDate: "2012-01-13T12:19:32.419+0000",
    },
  ],
};

const DYNAMIC_CP1 = {
  systemCodeNumber: "CP1",
  dynamics: [
    {
      occupancy: 142,
      stateDescription: "SPACES" as const,
      lastUpdated: "2012-01-13T12:19:32.419+0000",
    },
  ],
};

describe("utmc-newcastle staticToFacility", () => {
  it("parses static + dynamic v2 sample records into a ParkingFacility", async () => {
    const { staticToFacility } = await loadProvider();

    const facility = staticToFacility(STATIC_CP1, DYNAMIC_CP1);

    expect(facility).not.toBeNull();
    if (!facility) return;
    expect(facility.id).toBe("utmc:CP1");
    expect(facility.name).toBe("Town Centre");
    // [lng, lat]
    expect(facility.coordinates[0]).toBeCloseTo(-1.62522866852692, 10);
    expect(facility.coordinates[1]).toBeCloseTo(54.9755208253257, 10);
    expect(facility.capacity).toBe(200);
    expect(facility.freeSpaces).toBe(58);
    expect(facility.hasRealtimeData).toBe(true);
    expect(facility.state).toBe("open");
    expect(facility.address).toBe("Car park in Newcastle Town Centre");
    expect(facility.dataUpdatedAt).toBe("2012-01-13T12:19:32.419+0000");
    expect(facility.staticDataUpdatedAt).toBe("2012-01-13T12:19:32.419+0000");
    expect(facility.realtimeDataUpdatedAt).toBe("2012-01-13T12:19:32.419+0000");
  });

  it("marks CLOSED state and skips realtime when dynamics array is empty", async () => {
    const { staticToFacility } = await loadProvider();

    const closed = staticToFacility(STATIC_CP1, {
      systemCodeNumber: "CP1",
      dynamics: [
        { occupancy: 0, stateDescription: "CLOSED", lastUpdated: "2012-01-13T12:19:32.419+0000" },
      ],
    });
    expect(closed?.state).toBe("closed");

    const noDynamic = staticToFacility(STATIC_CP1, { systemCodeNumber: "CP1", dynamics: [] });
    expect(noDynamic?.hasRealtimeData).toBe(false);
    expect(noDynamic?.state).toBe("unknown");
    expect(noDynamic?.freeSpaces).toBeUndefined();
  });

  it("returns null when the static definitions array is empty", async () => {
    const { staticToFacility } = await loadProvider();
    expect(
      staticToFacility({ systemCodeNumber: "CPX", definitions: [], configurations: [] }),
    ).toBeNull();
  });
});

describe("utmc-newcastle searchUtmcNewcastle", () => {
  it("hits the v2 endpoints and joins static + dynamic feeds by systemCodeNumber", async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === STATIC_API) {
        return new Response(JSON.stringify([STATIC_CP1]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === DYNAMIC_API) {
        return new Response(JSON.stringify([DYNAMIC_CP1]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { searchUtmcNewcastle, setUtmcCredentials } = await loadProvider();
    setUtmcCredentials({ username: "u", password: "p" });

    const results = await searchUtmcNewcastle({
      south: 54.85,
      west: -1.8,
      north: 55.1,
      east: -1.4,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(STATIC_API, expect.anything());
    expect(fetchMock).toHaveBeenCalledWith(DYNAMIC_API, expect.anything());
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("utmc:CP1");
    expect(results[0].capacity).toBe(200);
    expect(results[0].freeSpaces).toBe(58);
    expect(results[0].state).toBe("open");
  });
});
