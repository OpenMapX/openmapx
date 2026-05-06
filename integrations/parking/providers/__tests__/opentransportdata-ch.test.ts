import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DATASET_PAGE_URL = "https://data.opentransportdata.swiss/en/dataset/bike-and-car-parking";
const DOWNLOAD_URL = "https://files.test/bike-and-car-parking.json";

const SWISS_PARKING_COLLECTION = {
  features: [
    {
      id: "bern-pr",
      geometry: {
        geometries: [{ type: "Point", coordinates: [7.4391, 46.9489] }],
      },
      properties: {
        address: {
          addressLine: "Bahnhofplatz 10",
          city: "Bern",
          postalCode: "3001",
        },
        additionalInformationForCustomers: "Covered parking",
        callToAction: {
          externalDesktop: {
            en: "https://parking.example/bern-pr",
          },
        },
        capacities: [
          { categoryType: "DEFAULT", total: 100 },
          { categoryType: "WITH_CHARGING_STATION", total: 8 },
          { categoryType: "DISABLED_PARKING_SPACE", total: 4 },
        ],
        currentEstimatedOccupancy: 0.25,
        displayName: "Bern Park+Rail",
        operationTime: {
          daysOfWeek: ["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
          operatingFrom: "00:00:00",
          operatingTo: "00:00:00",
        },
        operator: "SBB",
        parkingFacilityCategory: "CAR",
        parkingFacilityType: "PARK_AND_RAIL",
        pricingModel: {
          maximumDayPrice: 2400,
          monthlyTicketPrice: 12000,
          priceSegments: [{ startingFrom: 60, price: 200 }],
        },
        publicAccess: true,
      },
    },
    {
      id: "bern-bike",
      geometry: {
        geometries: [{ type: "Point", coordinates: [7.44, 46.95] }],
      },
      properties: {
        capacities: [{ categoryType: "DEFAULT", total: 24 }],
        displayName: "Bern Bike Parking",
        parkingFacilityCategory: "BIKE",
        parkingFacilityType: "BIKE_PARKING",
        publicAccess: true,
      },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function loadProvider() {
  vi.resetModules();
  return import("../opentransportdata-ch.js");
}

describe("opentransportdata-ch Swiss parking provider", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === DATASET_PAGE_URL) {
        return new Response(`<a href="${DOWNLOAD_URL}">latest JSON</a>`, { status: 200 });
      }
      if (url === DOWNLOAD_URL) {
        return new Response(JSON.stringify(SWISS_PARKING_COLLECTION), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);
  });

  it("maps Swiss parking facilities from the dataset page and JSON feed", async () => {
    const provider = await loadProvider();

    const results = await provider.searchOpenTransportDataChParking({
      east: 7.5,
      north: 47.0,
      south: 46.8,
      west: 7.3,
    });

    expect(results).toEqual([
      expect.objectContaining({
        access: "public",
        address: "Bahnhofplatz 10, 3001, Bern",
        capacity: 112,
        chargingSpaces: 8,
        disabledSpaces: 4,
        freeSpaces: 84,
        hasRealtimeData: true,
        id: "otdch-parking:bern-pr",
        name: "Bern Park+Rail",
        openingHours: "24/7",
        operator: "SBB",
        parkAndRide: true,
        sourceAttribution: expect.objectContaining({
          contributor: "OpenTransportData.swiss",
          license: "O-By 1.0",
        }),
        sourceName: "OpenTransportData.swiss",
        sources: ["opentransportdata-ch-parking"],
        tariffRows: [
          ["1 hour", "CHF 2.00"],
          ["Max day price", "CHF 24.00"],
          ["Monthly pass", "CHF 120.00"],
        ],
        url: "https://parking.example/bern-pr",
      }),
    ]);
  });

  it("filters out bike-only facilities from the mixed Swiss parking feed", async () => {
    const provider = await loadProvider();

    const results = await provider.searchOpenTransportDataChParking({
      east: 7.5,
      north: 47.0,
      south: 46.8,
      west: 7.3,
    });

    expect(results.map((facility) => facility.id)).toEqual(["otdch-parking:bern-pr"]);
  });

  it("returns a matching parking detail from the cached Swiss feed", async () => {
    const provider = await loadProvider();

    await provider.searchOpenTransportDataChParking({
      east: 7.5,
      north: 47.0,
      south: 46.8,
      west: 7.3,
    });

    const detail = await provider.fetchOpenTransportDataChParkingDetail("bern-pr");

    expect(detail).toEqual(
      expect.objectContaining({
        id: "otdch-parking:bern-pr",
        name: "Bern Park+Rail",
      }),
    );
  });
});
