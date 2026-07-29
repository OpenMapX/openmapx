import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchSgLtaDatamallChargingDetail,
  searchSgLtaDatamallCharging,
  setSgLtaDatamallApiKey,
} from "../sg-ltadatamall.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/sg-ltadatamall.json", import.meta.url)),
  "utf-8",
);
const stations = JSON.parse(fixture);

const SEARCH_BBOX = { south: 1.28, west: 103.84, north: 1.3, east: 103.86 };
const BATCH_LINK = "https://dm-batch-bucket.s3.ap-southeast-1.amazonaws.com/EVBatch.json";

afterEach(() => {
  setSgLtaDatamallApiKey(undefined);
  vi.unstubAllGlobals();
});

describe("searchSgLtaDatamallCharging", () => {
  it("returns [] without a configured API key, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSgLtaDatamallCharging(SEARCH_BBOX);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] for a bbox outside Singapore, without calling fetch", async () => {
    setSgLtaDatamallApiKey("test-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSgLtaDatamallCharging({
      south: 48,
      west: 2,
      north: 49,
      east: 3,
    });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("follows the EVCBatch link, downloads the file, maps stations, and filters by bbox", async () => {
    setSgLtaDatamallApiKey("test-key");
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === "https://datamall2.mytransport.sg/ltaodataservice/EVCBatch") {
        expect((init?.headers as Record<string, string>).AccountKey).toBe("test-key");
        return Promise.resolve(new Response(JSON.stringify({ value: [{ Link: BATCH_LINK }] })));
      }
      if (url === BATCH_LINK) {
        return Promise.resolve(new Response(fixture));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchSgLtaDatamallCharging(SEARCH_BBOX);

    expect(result).toHaveLength(1);
    const station = result[0];
    expect(station.id).toBe("sg-ltadatamall:851959123456");
    expect(station.sources).toEqual(["sg-ltadatamall"]);
    expect(station.coordinates).toEqual([103.851959, 1.29027]);
    expect(station.name).toBe("123 Road A");
    expect(station.address).toMatchObject({ postcode: "123456", country: "Singapore" });
    expect(station.operator).toMatchObject({ name: "EVCO A" });
    expect(station.status).toBe("operational");
    expect(station.isLive).toBe(true);
    expect(station.availability).toMatchObject({ available: 1, total: 1 });
    expect(station.usageCost).toBe("0.7/kWh");
    expect(station.connectors).toEqual([
      expect.objectContaining({ type: "Type 2", currentType: "AC", powerKw: 7.4, quantity: 1 }),
    ]);
    // The second fixture station (real coordinates, but outside this search
    // bbox) is excluded.
    expect(result.find((s) => s.id.includes("750000654321"))).toBeUndefined();
  });
});

describe("fetchSgLtaDatamallChargingDetail", () => {
  it("returns null without a configured API key", async () => {
    const result = await fetchSgLtaDatamallChargingDetail("sg-ltadatamall:851959123456");
    expect(result).toBeNull();
  });

  it("derives the postal code from the locationId and maps the matched station", async () => {
    setSgLtaDatamallApiKey("test-key");
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      expect(url).toBe(
        "https://datamall2.mytransport.sg/ltaodataservice/EVChargingPoints?PostalCode=123456",
      );
      expect((init?.headers as Record<string, string>).AccountKey).toBe("test-key");
      return Promise.resolve(new Response(JSON.stringify({ value: stations })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchSgLtaDatamallChargingDetail("sg-ltadatamall:851959123456");

    expect(result?.id).toBe("sg-ltadatamall:851959123456");
    expect(result?.address?.postcode).toBe("123456");
  });
});
