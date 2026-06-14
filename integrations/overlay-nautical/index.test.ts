import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchJson, loadStations, findNearestStation } = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  loadStations: vi.fn(),
  findNearestStation: vi.fn(),
}));

vi.mock("@openmapx/core", async (importActual) => {
  const actual = await importActual<typeof import("@openmapx/core")>();
  return { ...actual, fetchJson };
});

vi.mock("@openmapx/noaa-coops-data", () => ({
  loadStations,
  findNearestStation,
}));

import {
  createMockIntegrationContext,
  type MockIntegrationContext,
} from "@openmapx/integration-framework/testing";
import { parseHarbourJsonp, setup } from "./index.js";

function mockOkText(text: string) {
  return { ok: true, status: 200, text: async () => text } as Response;
}

describe("parseHarbourJsonp", () => {
  it("parses putHarbourMarker lines into [lng,lat] Point features with category->type", () => {
    const jsonp = [
      "putHarbourMarker(101, 9.95, 53.55, 'Hamburg', 'https://wiki/Hamburg', 1);",
      "putHarbourMarker(102, 2.35, 48.85, 'Paris Marina', '', 4);",
    ].join("\n");

    const features = parseHarbourJsonp(jsonp);

    expect(features).toHaveLength(2);
    // Geometry is [lng, lat]; the JSONP arg order is (id, lng, lat, ...).
    expect(features[0].geometry.coordinates).toEqual([9.95, 53.55]);
    expect(features[0].properties).toMatchObject({
      id: 101,
      name: "Hamburg",
      lng: 9.95,
      lat: 53.55,
      category: 1,
      type: "port",
      wikiUrl: "https://wiki/Hamburg",
    });
    expect(features[1].properties).toMatchObject({ category: 4, type: "marina" });
    // Empty wikiUrl becomes undefined.
    expect(features[1].properties.wikiUrl).toBeUndefined();
  });

  it("falls back to 'harbour' type for unknown categories and a synthetic name", () => {
    const features = parseHarbourJsonp("putHarbourMarker(7, 1.0, 2.0, '', '', 9);");
    expect(features[0].properties.type).toBe("harbour");
    expect(features[0].properties.name).toBe("Harbour 7");
  });

  it("ignores malformed lines", () => {
    expect(parseHarbourJsonp("not jsonp at all")).toEqual([]);
  });
});

describe("nautical routes", () => {
  let ctx: MockIntegrationContext;
  let mockFetch: ReturnType<typeof vi.fn>;

  function getRoute(path: string) {
    const route = ctx.registered.routes.find((r) => r.path === path);
    if (!route) throw new Error(`route ${path} not registered`);
    return route.handler;
  }

  function makeReply() {
    const result: { status: number; body: unknown } = { status: 200, body: undefined };
    const reply = {
      send: (data: unknown) => {
        result.body = data;
      },
      status: (code: number) => {
        result.status = code;
        return {
          send: (data: unknown) => {
            result.body = data;
          },
        };
      },
      header: () => {},
      type: () => {},
    };
    return { reply, result };
  }

  beforeEach(() => {
    fetchJson.mockReset();
    loadStations.mockReset();
    findNearestStation.mockReset();
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    ctx = createMockIntegrationContext();
    setup(ctx);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("/harbors", () => {
    it("fetches JSONP and returns a GeoJSON FeatureCollection", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOkText("putHarbourMarker(101, 9.95, 53.55, 'Hamburg', '', 1);"),
      );

      const { reply, result } = makeReply();
      await getRoute("/harbors")(
        {
          query: { south: "53", north: "54", west: "9", east: "10", zoom: "10" },
          params: {},
          body: undefined,
        },
        reply,
      );

      const body = result.body as {
        type: string;
        features: Array<{ geometry: { coordinates: number[] } }>;
      };
      expect(body.type).toBe("FeatureCollection");
      expect(body.features[0].geometry.coordinates).toEqual([9.95, 53.55]);
    });

    it("rejects an inverted bbox (south > north) with 400", async () => {
      const { reply, result } = makeReply();
      await getRoute("/harbors")(
        { query: { south: "60", north: "50", west: "9", east: "10" }, params: {}, body: undefined },
        reply,
      );
      expect(result.status).toBe(400);
    });
  });

  describe("/stations", () => {
    it("assembles merged GeoJSON with [lng,lat] order, primaryType ranking and capability flags", async () => {
      // NOAA loader returns a tide+water station; non-NOAA loaders return nothing.
      loadStations.mockResolvedValue([
        {
          id: "8443970",
          name: "Boston",
          lat: 42.3539,
          lng: -71.0503,
          types: ["tide-predictions", "water-level"],
        },
        {
          id: "cur1",
          name: "Current Station",
          lat: 42.0,
          lng: -71.0,
          types: ["currents"],
        },
      ]);
      // Non-NOAA networks all return empty (fetchJson) — kartverket uses raw fetch (stub 503).
      fetchJson.mockResolvedValue(null);
      mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

      const { reply, result } = makeReply();
      await getRoute("/stations")(
        {
          query: { west: "-72", south: "41", east: "-70", north: "43" },
          params: {},
          body: undefined,
        },
        reply,
      );

      const body = result.body as {
        type: string;
        features: Array<{
          geometry: { type: string; coordinates: [number, number] };
          properties: Record<string, unknown>;
        }>;
      };
      expect(body.type).toBe("FeatureCollection");
      const boston = body.features.find((f) => f.properties.id === "8443970");
      expect(boston).toBeDefined();
      // [lng, lat] order.
      expect(boston?.geometry.coordinates).toEqual([-71.0503, 42.3539]);
      expect(boston?.properties).toMatchObject({
        network: "noaa",
        name: "Boston",
        country: "US",
        // tide-predictions outranks water-level -> primaryType + rank 0.
        primaryType: "tide-predictions",
        hasTide: true,
        hasWaterLevel: true,
        hasCurrents: false,
        rank: 0,
      });

      const current = body.features.find((f) => f.properties.id === "cur1");
      expect(current?.properties).toMatchObject({
        primaryType: "currents",
        hasCurrents: true,
        rank: 2,
      });
    });

    it("rejects an out-of-range latitude with 400", async () => {
      const { reply, result } = makeReply();
      await getRoute("/stations")(
        {
          query: { west: "-72", south: "-100", east: "-70", north: "43" },
          params: {},
          body: undefined,
        },
        reply,
      );
      expect(result.status).toBe(400);
    });

    it("applies the type filter so only matching-capability stations render", async () => {
      loadStations.mockResolvedValue([
        { id: "tide-only", name: "T", lat: 42.0, lng: -71.0, types: ["tide-predictions"] },
        { id: "wl-only", name: "W", lat: 42.1, lng: -71.1, types: ["water-level"] },
      ]);
      fetchJson.mockResolvedValue(null);
      mockFetch.mockResolvedValue({ ok: false, status: 503 } as Response);

      const { reply, result } = makeReply();
      await getRoute("/stations")(
        {
          query: { west: "-72", south: "41", east: "-70", north: "43", types: "tide-predictions" },
          params: {},
          body: undefined,
        },
        reply,
      );

      const body = result.body as { features: Array<{ properties: { id: string } }> };
      expect(body.features.map((f) => f.properties.id)).toEqual(["tide-only"]);
    });
  });
});
