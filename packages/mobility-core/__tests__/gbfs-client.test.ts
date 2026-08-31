import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGbfsSystem } from "../src/gbfs-client.js";
import type { MobilityHttpRequestOptions, MobilityHttpTransport } from "../src/json-transport.js";

function discovery(feedUrl: string) {
  return {
    version: "2.3",
    data: { en: { feeds: [{ name: "station_information", url: feedUrl }] } },
  };
}

function stationInformation() {
  return {
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
  };
}

function createTransport(fetchJson = vi.fn()): MobilityHttpTransport {
  return {
    userAgent: "OpenMapX/test",
    fetchJson: fetchJson as MobilityHttpTransport["fetchJson"],
    fetchText: vi.fn(),
    hostMatchesAllowlist: (hostname, pattern) =>
      pattern.startsWith("*.")
        ? hostname.endsWith(pattern.slice(1)) && hostname !== pattern.slice(2)
        : hostname === pattern,
    privateFeedHostAllowlist: () => [],
  };
}

function requestOptions(call: unknown[] | undefined): MobilityHttpRequestOptions {
  return (call?.[1] ?? {}) as MobilityHttpRequestOptions;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("fetchGbfsSystem", () => {
  it("sends credentials to a sub-feed on the discovery host", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://feed.test/station_information.json"))
      .mockResolvedValueOnce(stationInformation());
    const transport = createTransport(fetchJson);

    await fetchGbfsSystem(
      "https://feed.test/gbfs.json",
      { Authorization: "Bearer test-token" },
      { transport },
    );

    const subFeedCall = fetchJson.mock.calls.find(([url]) =>
      String(url).includes("station_information.json"),
    );
    expect(requestOptions(subFeedCall).headers?.Authorization).toBe("Bearer test-token");
  });

  it("does not send credentials to a sub-feed on another host", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://evil.test/station_information.json"))
      .mockResolvedValueOnce(stationInformation());
    const transport = createTransport(fetchJson);

    await fetchGbfsSystem(
      "https://feed.test/gbfs.json",
      { Authorization: "Bearer test-token" },
      { transport },
    );

    const discoveryCall = fetchJson.mock.calls.find(([url]) => String(url).includes("gbfs.json"));
    const subFeedCall = fetchJson.mock.calls.find(([url]) => String(url).includes("evil.test"));
    expect(requestOptions(discoveryCall).headers?.Authorization).toBe("Bearer test-token");
    expect(requestOptions(subFeedCall).headers?.Authorization).toBeUndefined();
  });

  it("resolves relative sub-feed URLs against the discovery URL", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(discovery("station_information.json"))
      .mockResolvedValueOnce(stationInformation());
    const transport = createTransport(fetchJson);

    await fetchGbfsSystem("https://feed.test/v3/gbfs.json", undefined, { transport });

    expect(fetchJson.mock.calls.map(([url]) => String(url))).toContain(
      "https://feed.test/v3/station_information.json",
    );
  });

  it("skips a sub-feed rejected by the bounded transport", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://private.test/station_information.json"))
      .mockRejectedValueOnce(new Error("private target"));
    const transport = createTransport(fetchJson);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await fetchGbfsSystem("https://feed.test/gbfs.json", undefined, { transport });

    expect(result?.stations).toEqual([]);
  });

  it("gates credentials on the discovery request with credentialHosts", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://other.test/station_information.json"))
      .mockResolvedValueOnce(stationInformation());
    const transport = createTransport(fetchJson);

    await fetchGbfsSystem(
      "https://other.test/gbfs.json",
      { Authorization: "Bearer test-token" },
      { credentialHosts: ["allowed.test"], transport },
    );

    expect(requestOptions(fetchJson.mock.calls[0]).headers?.Authorization).toBeUndefined();
  });

  it("passes the per-feed byte ceiling to the bounded transport", async () => {
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(discovery("https://feed.test/station_information.json"))
      .mockRejectedValueOnce(new Error("response too large"));
    const transport = createTransport(fetchJson);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await fetchGbfsSystem("https://feed.test/gbfs.json", undefined, { transport });

    const subFeedCall = fetchJson.mock.calls.find(([url]) =>
      String(url).includes("station_information.json"),
    );
    expect(requestOptions(subFeedCall).maxBytes).toBe(32 * 1024 * 1024);
    expect(result?.stations).toEqual([]);
  });
});
