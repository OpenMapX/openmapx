import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));
vi.mock("@openmapx/core/utils/safe-download", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core/utils/safe-download")>();
  return {
    ...actual,
    safeFetchJson: <T>(url: string, options = {}) =>
      actual.safeFetchJson<T>(url, { ...options, fetchImplementation: globalThis.fetch }),
  };
});

import { lookup as dnsLookup } from "node:dns/promises";
import { fetchGbfsSystem } from "../src/gbfs-client.js";

const lookupMock = dnsLookup as unknown as ReturnType<typeof vi.fn>;
const PUBLIC = [{ address: "93.184.216.34", family: 4 }];

afterEach(() => {
  lookupMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeResponse(opts: {
  status?: number;
  headers?: Record<string, string>;
  bodyText?: string;
}): Response {
  const status = opts.status ?? 200;
  return {
    status,
    ok: status >= 200 && status < 300,
    url: "",
    headers: new Headers(opts.headers ?? {}),
    body: new Response(opts.bodyText ?? "{}").body,
  } as unknown as Response;
}

function discovery(feedUrl: string): Response {
  return makeResponse({
    bodyText: JSON.stringify({
      version: "2.3",
      data: { en: { feeds: [{ name: "station_information", url: feedUrl }] } },
    }),
  });
}

function stationInformation(): Response {
  return makeResponse({
    bodyText: JSON.stringify({
      data: {
        stations: [
          {
            station_id: "station-1",
            name: "Station 1",
            lat: 52.5,
            lon: 13.4,
          },
        ],
      },
    }),
  });
}

function publicDns(): void {
  lookupMock.mockResolvedValue(PUBLIC);
}

describe("fetchGbfsSystem", () => {
  it("sends credentials to a sub-feed on the discovery host", async () => {
    publicDns();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(discovery("https://feed.test/station_information.json"));
    fetchMock.mockResolvedValueOnce(stationInformation());
    vi.stubGlobal("fetch", fetchMock);

    await fetchGbfsSystem("https://feed.test/gbfs.json", {
      Authorization: "Bearer test-token",
    });

    const subFeedCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes("station_information.json"),
    );
    expect(subFeedCall).toBeDefined();
    expect(new Headers(subFeedCall?.[1]?.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("does not send credentials to a sub-feed on another host", async () => {
    publicDns();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(discovery("https://evil.test/station_information.json"));
    fetchMock.mockResolvedValueOnce(stationInformation());
    vi.stubGlobal("fetch", fetchMock);

    await fetchGbfsSystem("https://feed.test/gbfs.json", {
      Authorization: "Bearer test-token",
    });

    const discoveryCall = fetchMock.mock.calls.find(([url]) => String(url).includes("gbfs.json"));
    const subFeedCall = fetchMock.mock.calls.find(([url]) => String(url).includes("evil.test"));
    expect(new Headers(discoveryCall?.[1]?.headers).get("Authorization")).toBe("Bearer test-token");
    expect(new Headers(subFeedCall?.[1]?.headers).get("Authorization")).toBeNull();
  });

  it("resolves relative sub-feed URLs against the discovery URL", async () => {
    publicDns();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(discovery("station_information.json"));
    fetchMock.mockResolvedValueOnce(stationInformation());
    vi.stubGlobal("fetch", fetchMock);

    await fetchGbfsSystem("https://feed.test/v3/gbfs.json");

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toContain(
      "https://feed.test/v3/station_information.json",
    );
  });

  it("skips a sub-feed that resolves to a private address without throwing", async () => {
    lookupMock.mockImplementation(async (hostname: string) =>
      hostname === "private.test" ? [{ address: "127.0.0.1", family: 4 }] : PUBLIC,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://private.test/station_information.json"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGbfsSystem("https://feed.test/gbfs.json");

    expect(result).toBeDefined();
    expect(result?.stations).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gates credentials on the discovery request with credentialHosts", async () => {
    publicDns();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://other.test/station_information.json"));
    vi.stubGlobal("fetch", fetchMock);

    await fetchGbfsSystem(
      "https://other.test/gbfs.json",
      { Authorization: "Bearer test-token" },
      { credentialHosts: ["allowed.test"] },
    );

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBeNull();
  });

  it("drops a feed whose declared Content-Length exceeds the cap", async () => {
    publicDns();
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(discovery("https://feed.test/station_information.json"));
    fetchMock.mockResolvedValueOnce(
      makeResponse({ headers: { "content-length": "999999999" }, bodyText: "{}" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGbfsSystem("https://feed.test/gbfs.json");

    expect(result).toBeDefined();
    expect(result?.stations).toEqual([]);
  });
});
