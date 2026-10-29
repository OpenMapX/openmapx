import { encodeGtfsRtFeed } from "@openmapx/mobility-formats";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSwissTransitClient, type SwissTransitClient } from "../client.js";
import { allowQuota, memoryCache, testHttp } from "./helpers.js";

let client: SwissTransitClient;

const OJP_ENDPOINT = "https://api.opentransportdata.swiss/ojp20";
const GTFS_SA_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-sa";
const GTFS_RT_ENDPOINT = "https://api.opentransportdata.swiss/la/gtfs-rt";
const SIRI_SX_ENDPOINT = "https://api.opentransportdata.swiss/la/siri-sx";
const FORMATION_ENDPOINT = "https://api.opentransportdata.swiss/formation";

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
  client = createSwissTransitClient({
    http: testHttp(),
    cache: memoryCache().cache,
    upstreamRuntime: allowQuota(),
    contributors: {},
    config: {
      apiKey: "test-key",
      formationEndpoint: FORMATION_ENDPOINT,
      gtfsRtEndpoint: GTFS_RT_ENDPOINT,
      gtfsSaEndpoint: GTFS_SA_ENDPOINT,
      ojpEndpoint: OJP_ENDPOINT,
      siriSxEndpoint: SIRI_SX_ENDPOINT,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Swiss transit client caching", () => {
  it("reuses shared cache entries for repeated OJP XML requests", async () => {
    await client.requestSwissOjp("<OJP>request</OJP>", {
      cacheNamespace: "test-ojp",
      cacheTtlSeconds: 60,
    });
    await client.requestSwissOjp("<OJP>request</OJP>", {
      cacheNamespace: "test-ojp",
      cacheTtlSeconds: 60,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses shared cache for GTFS-SA feed fetches", async () => {
    const first = await client.fetchSwissGtfsSaFeed();
    const second = await client.fetchSwissGtfsSaFeed();

    expect(first.entity?.[0]?.id).toBe("alert-1");
    expect(second.entity?.[0]?.id).toBe("alert-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses shared cache for GTFS-RT trip-update fetches", async () => {
    const first = await client.fetchSwissGtfsRtFeed();
    const second = await client.fetchSwissGtfsRtFeed();

    expect(first.entity?.[0]?.id).toBe("trip-update-1");
    expect(second.entity?.[0]?.id).toBe("trip-update-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cached SIRI-SX feed fetches", async () => {
    await client.fetchSwissSiriSxFeed("complete");
    await client.fetchSwissSiriSxFeed("complete");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses cached formation lookups including repeated client calls", async () => {
    const first = await client.fetchSwissFormationJourney<{
      trainMetaInformation?: { trainNumber?: string };
    }>({
      evu: "SBBP",
      operationDate: "2025-02-03",
      trainNumber: "419",
    });
    const second = await client.fetchSwissFormationJourney<{
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

describe("Swiss client generation and acquisition boundaries", () => {
  const request = { evu: "SBBP", operationDate: "2025-02-03", trainNumber: "419" };
  const make = (key = "A", extra: Partial<Parameters<typeof createSwissTransitClient>[0]> = {}) =>
    createSwissTransitClient({
      config: { apiKey: key },
      http: testHttp(),
      cache: memoryCache().cache,
      contributors: {},
      upstreamRuntime: allowQuota(),
      ...extra,
    });

  it("snapshots credentials and separates cached acquisitions by key and receipts", async () => {
    const shared = memoryCache();
    const config = { apiKey: "A" };
    const receipt = { sourceId: "opentransportdata-ch-formation", name: "Original" };
    const first = make("A", {
      config,
      cache: shared.cache,
      contributors: { [receipt.sourceId]: [receipt] },
    });
    config.apiKey = "B";
    receipt.name = "Changed";
    const second = make("B", { cache: shared.cache });
    const third = make("A", {
      cache: shared.cache,
      contributors: { [receipt.sourceId]: [receipt] },
    });
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      Response.json({ key: new Headers(init?.headers).get("Authorization") }),
    );
    expect(await first.fetchSwissFormationJourney(request)).toEqual({ key: "Bearer A" });
    expect(await second.fetchSwissFormationJourney(request)).toEqual({ key: "Bearer B" });
    expect(await third.fetchSwissFormationJourney(request)).toEqual({ key: "Bearer A" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect([...shared.store.keys()].join(" ")).not.toContain("Bearer");
    expect(
      [...shared.store.keys()].every(
        (key) => !key.includes("Original") && !key.includes("Changed"),
      ),
    ).toBe(true);
  });

  it.each(["missing", "denied", "failure", "unavailable"])(
    "makes no network request when quota is %s",
    async (kind) => {
      const runtime = allowQuota();
      runtime.consumeQuota = vi.fn(async () => {
        if (kind === "failure") throw new Error("Redis disconnected");
        return {
          allowed: kind === "unavailable",
          remaining: {},
          retryAt: null,
          ...(kind === "unavailable" ? { diagnostic: "store_unavailable" as const } : {}),
        };
      });
      const value = make("A", { upstreamRuntime: kind === "missing" ? undefined : runtime });
      await expect(value.fetchSwissGtfsRtFeed()).rejects.toThrow(/quota/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("charges each OJP fallback attempt and stops immediately on quota denial", async () => {
    const runtime = allowQuota();
    const consume = vi
      .fn()
      .mockResolvedValueOnce({ allowed: true, remaining: {}, retryAt: null })
      .mockResolvedValueOnce({ allowed: false, remaining: {}, retryAt: 10 });
    runtime.consumeQuota = consume;
    const value = make("A", { upstreamRuntime: runtime });
    fetchMock.mockResolvedValue(new Response("failure", { status: 503 }));
    await expect(value.requestSwissOjp("<OJP/>")).rejects.toThrow(/quota/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(consume).toHaveBeenCalledTimes(2);
    const second = make("A", { upstreamRuntime: runtime });
    await expect(second.fetchSwissGtfsRtFeed()).rejects.toThrow(/quota/);
    expect(consume.mock.calls[0]?.[0].bucket).toContain(":ojp:");
    expect(consume.mock.calls[2]?.[0].bucket).toContain(":gtfs-rt:");
  });

  it.each([401, 403, 404])("returns null for non-JSON formation status %s", async (status) => {
    fetchMock.mockResolvedValue(
      new Response("<html>unavailable</html>", {
        status,
        headers: { "content-type": "text/html" },
      }),
    );
    expect(await make().fetchSwissFormationJourney(request)).toBeNull();
  });

  it("surfaces genuine formation failures and malformed successful JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 500 }));
    await expect(make().fetchSwissFormationJourney(request)).rejects.toThrow(/500/);
    fetchMock.mockResolvedValueOnce(
      new Response("bad", { headers: { "content-type": "application/json" } }),
    );
    await expect(make().fetchSwissFormationJourney(request)).rejects.toThrow(SyntaxError);
  });

  it("does not republish an acquisition completed after cache invalidation", async () => {
    const shared = memoryCache();
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const value = make("A", { cache: shared.cache });
    const pending = value.fetchSwissFormationJourney(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    shared.invalidate();
    release(Response.json({ version: "old" }));
    expect(await pending).toEqual({ version: "old" });
    expect(shared.store.size).toBe(0);
    expect(await value.fetchSwissFormationJourney(request)).toEqual({
      trainMetaInformation: { trainNumber: "419" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rechecks source policy for cached values and on late completion", async () => {
    let allowed = true;
    const value = make("A", { isSourceAllowed: async () => allowed });
    await value.fetchSwissFormationJourney(request);
    allowed = false;
    await expect(value.fetchSwissFormationJourney(request)).rejects.toThrow(/policy/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps A's deferred response/configuration independent of B and aborts retirement", async () => {
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const first = make("A");
    const pending = first.fetchSwissFormationJourney(request);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const second = make("B");
    expect(await second.fetchSwissFormationJourney(request)).toEqual({
      trainMetaInformation: { trainNumber: "419" },
    });
    release(Response.json({ generation: "A" }));
    expect(await pending).toEqual({ generation: "A" });
    await first.dispose();
    await expect(first.fetchSwissFormationJourney(request)).rejects.toThrow(/retired/);
    expect(await second.fetchSwissFormationJourney(request)).toEqual({
      trainMetaInformation: { trainNumber: "419" },
    });
  });
});
