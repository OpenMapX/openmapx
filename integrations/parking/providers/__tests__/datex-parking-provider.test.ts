import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatexParkingProvider } from "../datex-parking-provider.js";

const TABLE_URL = "https://parking.example/static.xml";
const STATUS_URL = "https://parking.example/dynamic.xml";

const TABLE_XML = `
<d2LogicalModel>
  <payloadPublication>
    <parkingTable>
      <parkingRecord id="P/1">
        <parkingName>
          <values>
            <value lang="en">Central Parking</value>
          </values>
        </parkingName>
        <parkingLocation>
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>49.6116</latitude>
              <longitude>6.1319</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </parkingLocation>
        <groupOfParkingSpaces>
          <parkingNumberOfSpaces>100</parkingNumberOfSpaces>
        </groupOfParkingSpaces>
        <tariffsAndPayment>
          <freeOfCharge>false</freeOfCharge>
        </tariffsAndPayment>
      </parkingRecord>
      <parkingRecord id="P2">
        <parkingName>Out of box</parkingName>
        <parkingLocation>
          <pointByCoordinates>
            <pointCoordinates>
              <latitude>50.9</latitude>
              <longitude>8.2</longitude>
            </pointCoordinates>
          </pointByCoordinates>
        </parkingLocation>
      </parkingRecord>
    </parkingTable>
  </payloadPublication>
</d2LogicalModel>
`;

const STATUS_XML = `
<d2LogicalModel>
  <payloadPublication>
    <parkingRecordStatus>
      <parkingRecordReference id="P/1" />
      <parkingStatusOriginTime>2026-05-06T11:00:00.000Z</parkingStatusOriginTime>
      <parkingSiteStatus>full</parkingSiteStatus>
      <parkingOccupancy>
        <parkingNumberOfVacantSpaces>120</parkingNumberOfVacantSpaces>
      </parkingOccupancy>
    </parkingRecordStatus>
  </payloadPublication>
</d2LogicalModel>
`;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeProvider() {
  return createDatexParkingProvider({
    attribution: {
      contributor: "CITA",
      license: "CC0 1.0",
      url: "https://data.public.lu/",
    },
    coverage: { east: 6.6, north: 50.2, south: 49.4, west: 5.7 },
    sourceId: "test-datex",
    sourceName: "Test DATEX",
    sourceUrl: "https://parking.example/",
    statusUrl: STATUS_URL,
    tableUrl: TABLE_URL,
  });
}

describe("DATEX parking provider factory", () => {
  it("maps table and status XML into car parking facilities with provenance", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-06T12:00:00.000Z"));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === TABLE_URL) return new Response(TABLE_XML, { status: 200 });
      if (url === STATUS_URL) return new Response(STATUS_XML, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await makeProvider().search({
      east: 6.2,
      north: 49.7,
      south: 49.5,
      west: 6.0,
    });

    expect(results).toEqual([
      expect.objectContaining({
        capacity: 100,
        dataUpdatedAt: "2026-05-06T11:00:00.000Z",
        fee: "paid",
        freeSpaces: 100,
        hasRealtimeData: true,
        id: "test-datex:P%2F1",
        isStale: true,
        name: "Central Parking",
        qualityWarnings: [
          "Realtime free-space count exceeded capacity and was clamped.",
          "Realtime availability is older than 30 minutes.",
        ],
        sourceAttribution: expect.objectContaining({
          contributor: "CITA",
          license: "CC0 1.0",
        }),
        sourceName: "Test DATEX",
        sourceUid: "P/1",
        state: "open",
      }),
    ]);
  });

  it("fetches details by decoded source id from the cached feed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-06T11:05:00.000Z"));
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url === TABLE_URL) return new Response(TABLE_XML, { status: 200 });
      if (url === STATUS_URL) return new Response(STATUS_XML, { status: 200 });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = makeProvider();
    await provider.search({ east: 6.2, north: 49.7, south: 49.5, west: 6.0 });

    const detail = await provider.fetchDetail("P%2F1");

    expect(detail).toEqual(
      expect.objectContaining({
        id: "test-datex:P%2F1",
        sourceUid: "P/1",
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
