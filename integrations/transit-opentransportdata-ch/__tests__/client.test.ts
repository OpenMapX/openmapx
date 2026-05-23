import type { CacheClient } from "@openmapx/core";
import { encodeGtfsRtFeed } from "@openmapx/mobility-formats";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchSwissFormationJourney,
  fetchSwissGtfsRtFeed,
  fetchSwissGtfsSaFeed,
  fetchSwissSiriSxFeed,
  requestSwissOjp,
  setSwissTransitConfig,
} from "../client.js";

const OJP_ENDPOINT = "https://api.opentransportdata.swiss/ojp20";
const GTFS_SA_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-sa";
const GTFS_RT_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-rt";
const SIRI_SX_ENDPOINT = "https://api.opentransportdata.swiss/la/siri-sx";
const FORMATION_ENDPOINT = "https://api.opentransportdata.swiss/formation";

function createMemoryCache(): CacheClient {
  const store = new Map<string, unknown>();
  return {
    async del(key) {
      store.delete(key);
    },
    async get<T>(key: string) {
      return (store.get(key) as T | undefined) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
    },
    async withCache<T>(key: string, _ttlSeconds: number, fn: () => Promise<T>) {
      if (store.has(key)) {
        return store.get(key) as T;
      }
      const value = await fn();
      store.set(key, value);
      return value;
    },
    async hmget<T>(_key: string, fields: readonly string[]) {
      return fields.map(() => null as T | null);
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === OJP_ENDPOINT) {
      return new Response("<xml>cached</xml>", { status: 200 });
    }
    if (url === GTFS_SA_ENDPOINT) {
      return new Response(
        encodeGtfsRtFeed({
          header: { gtfsRealtimeVersion: "2.0", timestamp: 1_739_846_400 },
          entity: [{ id: "alert-1", alert: {} }],
        }),
        { status: 200 },
      );
    }
    if (url === GTFS_RT_ENDPOINT) {
      return new Response(
        encodeGtfsRtFeed({
          header: { gtfsRealtimeVersion: "2.0", timestamp: 1_739_846_400 },
          entity: [
            {
              id: "trip-update-1",
              tripUpdate: {
                trip: { tripId: "gtfs-trip-1" },
                stopTimeUpdate: [],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url === SIRI_SX_ENDPOINT) {
      return new Response("<Siri><ServiceDelivery /></Siri>", { status: 200 });
    }
    if (
      url ===
      `${FORMATION_ENDPOINT}/v2/formations_full?evu=SBBP&operationDate=2025-02-03&trainNumber=419`
    ) {
      return Response.json({ trainMetaInformation: { trainNumber: "419" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  setSwissTransitConfig({
    apiKey: "test-key",
    cache: createMemoryCache(),
    formationEndpoint: FORMATION_ENDPOINT,
    gtfsRtEndpoint: GTFS_RT_ENDPOINT,
    gtfsSaEndpoint: GTFS_SA_ENDPOINT,
    ojpEndpoint: OJP_ENDPOINT,
    siriSxEndpoint: SIRI_SX_ENDPOINT,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Swiss transit client caching", () => {
  it("reuses shared cache entries for repeated OJP XML requests", async () => {
    await requestSwissOjp("<OJP>request</OJP>", {
      cacheNamespace: "test-ojp",
      cacheTtlSeconds: 60,
    });
    await requestSwissOjp("<OJP>request</OJP>", {
      cacheNamespace: "test-ojp",
      cacheTtlSeconds: 60,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses shared and process-local cache for GTFS-SA feed fetches", async () => {
    const first = await fetchSwissGtfsSaFeed();
    const second = await fetchSwissGtfsSaFeed();

    expect(first.entity?.[0]?.id).toBe("alert-1");
    expect(second.entity?.[0]?.id).toBe("alert-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses shared and process-local cache for GTFS-RT trip-update fetches", async () => {
    const first = await fetchSwissGtfsRtFeed();
    const second = await fetchSwissGtfsRtFeed();

    expect(first.entity?.[0]?.id).toBe("trip-update-1");
    expect(second.entity?.[0]?.id).toBe("trip-update-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cached SIRI-SX feed fetches", async () => {
    await fetchSwissSiriSxFeed("complete");
    await fetchSwissSiriSxFeed("complete");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cached formation lookups including null-safe client caching", async () => {
    const first = await fetchSwissFormationJourney<{
      trainMetaInformation?: { trainNumber?: string };
    }>({
      evu: "SBBP",
      operationDate: "2025-02-03",
      trainNumber: "419",
    });
    const second = await fetchSwissFormationJourney<{
      trainMetaInformation?: { trainNumber?: string };
    }>({
      evu: "SBBP",
      operationDate: "2025-02-03",
      trainNumber: "419",
    });

    expect(first?.trainMetaInformation?.trainNumber).toBe("419");
    expect(second?.trainMetaInformation?.trainNumber).toBe("419");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
