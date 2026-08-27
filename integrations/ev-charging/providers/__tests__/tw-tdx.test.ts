import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTwTdxChargingDetail, searchTwTdxCharging, setTwTdxCredentials } from "../tw-tdx.js";

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL("./fixtures/tw-tdx.json", import.meta.url)), "utf-8"),
);

const TOKEN_URL =
  "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API_BASE = "https://tdx.transportdata.tw/api/basic";

// Tight around the Taipei City Hall fixture station only — the Beitou
// fixture station (same city, different coordinates) sits well outside it.
const SEARCH_BBOX = { south: 25.03, west: 121.55, north: 25.05, east: 121.58 };

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
}

function stubTaipeiFetch() {
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (url === TOKEN_URL) {
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>)["Content-Type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("client_credentials");
      expect(body.get("client_id")).toBe("test-client-id");
      expect(body.get("client_secret")).toBe("test-client-secret");
      return Promise.resolve(jsonResponse({ access_token: "test-token", expires_in: 86400 }));
    }
    if (url.startsWith(`${API_BASE}/v1/EV/Station/City/Taipei`)) {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      return Promise.resolve(jsonResponse({ Stations: fixture.stations }));
    }
    if (url.startsWith(`${API_BASE}/v1/EV/ConnectorLiveStatus/City/Taipei`)) {
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      return Promise.resolve(jsonResponse({ LiveStatuses: fixture.liveStatuses }));
    }
    // The Taipei approx-bbox sits entirely inside the NewTaipei approx-bbox
    // (New Taipei geographically surrounds Taipei), so any bbox touching
    // Taipei also fans out to a NewTaipei query — respond with no stations
    // rather than treating that as an error.
    if (url.startsWith(`${API_BASE}/v1/EV/Station/City/`)) {
      return Promise.resolve(jsonResponse({ Stations: [] }));
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

afterEach(() => {
  setTwTdxCredentials(undefined, undefined);
  vi.unstubAllGlobals();
});

describe("searchTwTdxCharging", () => {
  it("returns [] without configured credentials, without calling fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchTwTdxCharging(SEARCH_BBOX);

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns [] for a bbox outside Taiwan, without calling fetch", async () => {
    setTwTdxCredentials("test-client-id", "test-client-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchTwTdxCharging({ south: 48, west: 2, north: 49, east: 3 });

    expect(result).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches a token, queries Station + ConnectorLiveStatus for the overlapping city, maps stations, and filters by bbox", async () => {
    setTwTdxCredentials("test-client-id", "test-client-secret");
    const fetchMock = stubTaipeiFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchTwTdxCharging(SEARCH_BBOX);

    expect(result).toHaveLength(1);
    const station = result[0];
    expect(station.id).toBe("tw-tdx:Taipei:TPE-0001");
    expect(station.sources).toEqual(["tw-tdx"]);
    expect(station.coordinates).toEqual([121.5637, 25.0375]);
    expect(station.name).toBe("Taipei City Hall EV Charging Station");
    expect(station.address).toMatchObject({
      line1: "市府路1號",
      town: "信義區",
      state: "臺北市",
      country: "Taiwan",
    });
    // Station.ChargingRate is a free-text description in this dataset (no
    // numeric price field), so it maps to usageCost rather than a
    // structured tariff.
    expect(station.usageCost).toBe("詳見營運業者官網公告費率");
    expect(station.notes).toEqual(["Parking: 首小時免費，超過每小時新臺幣40元"]);
    expect(station.tariffs).toBeUndefined();
    expect(station.isLive).toBe(true);
    expect(station.availability).toMatchObject({ available: 2, total: 3 });
    expect(station.updatedAt).toBe("2026-07-29T01:10:00+08:00");
    expect(station.connectors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "Type 2", currentType: "AC", quantity: 2 }),
        // `normalizeConnectorType` (shared util) collapses CCS1/CCS2 into "CCS".
        expect.objectContaining({ type: "CCS", currentType: "DC", quantity: 1 }),
      ]),
    );
    // The Beitou fixture station is outside SEARCH_BBOX and must be dropped.
    expect(result.find((s) => s.id.includes("TPE-0002"))).toBeUndefined();

    // Taipei's approx-bbox sits inside NewTaipei's, so this bbox fans out to
    // both cities: one token call, Taipei Station + ConnectorLiveStatus, and
    // a NewTaipei Station call that comes back empty (no ConnectorLiveStatus
    // follow-up once a city's station list is empty).
    const calledUrls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(calledUrls.filter((url) => url === TOKEN_URL)).toHaveLength(1);
    expect(calledUrls.filter((url) => url.includes("/Station/City/Taipei"))).toHaveLength(1);
    expect(
      calledUrls.filter((url) => url.includes("/ConnectorLiveStatus/City/Taipei")),
    ).toHaveLength(1);
    expect(calledUrls.filter((url) => url.includes("/Station/City/NewTaipei"))).toHaveLength(1);
    expect(
      calledUrls.filter((url) => url.includes("/ConnectorLiveStatus/City/NewTaipei")),
    ).toHaveLength(0);
  });

  it("caches the access token across searches instead of re-requesting it", async () => {
    setTwTdxCredentials("test-client-id", "test-client-secret");
    const fetchMock = stubTaipeiFetch();
    vi.stubGlobal("fetch", fetchMock);

    await searchTwTdxCharging(SEARCH_BBOX);
    await searchTwTdxCharging(SEARCH_BBOX);

    const tokenCalls = fetchMock.mock.calls.filter(([url]) => url === TOKEN_URL);
    expect(tokenCalls).toHaveLength(1);
  });
});

describe("fetchTwTdxChargingDetail", () => {
  it("returns null without configured credentials", async () => {
    const result = await fetchTwTdxChargingDetail("tw-tdx:Taipei:TPE-0001");
    expect(result).toBeNull();
  });

  it("returns null for a malformed itemId", async () => {
    setTwTdxCredentials("test-client-id", "test-client-secret");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTwTdxChargingDetail("tw-tdx:not-a-valid-id");

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("looks up the station by city + StationID and merges live status", async () => {
    setTwTdxCredentials("test-client-id", "test-client-secret");
    const fetchMock = stubTaipeiFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchTwTdxChargingDetail("tw-tdx:Taipei:TPE-0001");

    expect(result?.id).toBe("tw-tdx:Taipei:TPE-0001");
    expect(result?.availability).toMatchObject({ available: 2, total: 3 });
  });
});
