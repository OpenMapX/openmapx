import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { motisFetch, motisMode, uniqueModes } from "../motis.js";

describe("motisMode", () => {
  it.each([
    ["WALK", "walking"],
    ["TRAM", "tram"],
    ["SUBWAY", "subway"],
    ["FERRY", "ferry"],
    ["BUS", "bus"],
    ["RAIL", "rail"],
    ["HIGHSPEED_RAIL", "rail"],
    ["REGIONAL_RAIL", "rail"],
    ["SUBURBAN", "rail"],
    ["FUNICULAR", "funicular"],
    ["AERIAL_LIFT", "gondola"],
    ["MONORAIL", "monorail"],
    ["OTHER", "bus"],
  ] as const)("maps %s → %s", (input, expected) => {
    expect(motisMode(input)).toBe(expected);
  });

  it("maps unknown string → bus", () => {
    expect(motisMode("UNKNOWN_SOMETHING")).toBe("bus");
  });

  it("maps undefined → bus", () => {
    expect(motisMode(undefined)).toBe("bus");
  });
});

describe("uniqueModes", () => {
  it("deduplicates mapped modes", () => {
    expect(uniqueModes(["RAIL", "RAIL", "BUS"])).toEqual(["rail", "bus"]);
  });

  it("returns empty array for empty input", () => {
    expect(uniqueModes([])).toEqual([]);
  });
});

describe("motisFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on ok response", async () => {
    const mockData = { routes: [{ id: "1" }] };
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => mockData,
    } as Response);

    const result = await motisFetch<typeof mockData>("https://api.transitous.org", "/api/v1/plan", {
      fromLat: "52.52",
      fromLon: "13.405",
    });

    expect(result).toEqual(mockData);
  });

  it("returns null on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const result = await motisFetch("https://api.transitous.org", "/api/v1/plan");

    expect(result).toBeNull();
  });

  it("sets User-Agent header when provided in options", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    } as Response);

    await motisFetch(
      "https://api.transitous.org",
      "/api/v1/plan",
      {},
      {
        userAgent: "OpenMapX/1.0",
      },
    );

    const [, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("OpenMapX/1.0");
  });
});
