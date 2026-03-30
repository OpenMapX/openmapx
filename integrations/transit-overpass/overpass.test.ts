import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mockOk(data: unknown) {
  return { ok: true, json: async () => data } as Response;
}

function mockNotOk() {
  return { ok: false, status: 429 } as Response;
}

async function loadModule() {
  return import("@integrations/transit-overpass/provider.js");
}

describe("overpass provider", () => {
  describe("getStops", () => {
    it("returns stops with osm: prefix", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [
            {
              id: 12345,
              lat: 48.14,
              lon: 11.56,
              tags: { name: "Hauptbahnhof", train: "yes" },
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([11.5, 48.1, 11.6, 48.2]);

      expect(stops).toHaveLength(1);
      expect(stops[0].id).toBe("osm:12345");
      expect(stops[0].name).toBe("Hauptbahnhof");
      expect(stops[0].lat).toBe(48.14);
      expect(stops[0].lng).toBe(11.56);
      expect(stops[0].provider).toBe("overpass");
    });

    it("maps train tag to rail mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 1, lat: 0, lon: 0, tags: { name: "S1", train: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("rail");
    });

    it("maps subway tag to subway mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 2, lat: 0, lon: 0, tags: { name: "U1", subway: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("subway");
    });

    it("maps bus tag to bus mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 3, lat: 0, lon: 0, tags: { name: "Bus Stop", bus: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("bus");
    });

    it("maps aerialway=gondola to gondola mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 4, lat: 0, lon: 0, tags: { name: "Gondola", aerialway: "gondola" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("gondola");
    });

    it("maps aerialway=cable_car to cable_car mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [
            { id: 5, lat: 0, lon: 0, tags: { name: "Cable Car", aerialway: "cable_car" } },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("cable_car");
    });

    it("defaults to bus mode for unknown tags", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 6, lat: 0, lon: 0, tags: { name: "Unknown Stop" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toEqual(["bus"]);
    });

    it("maps multiple modes from combined tags", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [
            {
              id: 7,
              lat: 0,
              lon: 0,
              tags: { name: "Multi-Modal", train: "yes", bus: "yes", tram: "yes" },
            },
          ],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("rail");
      expect(stops[0].modes).toContain("bus");
      expect(stops[0].modes).toContain("tram");
    });

    it("uses POST to overpass-api.de", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({ elements: [] }));

      const { getStops } = await loadModule();
      await getStops([11.5, 48.1, 11.6, 48.2]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://overpass-api.de/api/interpreter");
      expect(init.method).toBe("POST");
      expect(init.headers).toEqual({
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "OpenMapX/1.0 (+https://openmapx.org)",
      });
      expect(init.body).toContain("data=");
    });

    it("returns empty array on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk());

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops).toEqual([]);
    });

    it("returns empty array on fetch error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("timeout"));

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops).toEqual([]);
    });

    it("uses name:en fallback when name is missing", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 8, lat: 0, lon: 0, tags: { "name:en": "English Name" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].name).toBe("English Name");
    });

    it("uses ref tag as platformCode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 9, lat: 0, lon: 0, tags: { name: "Platform Stop", ref: "3A" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].platformCode).toBe("3A");
    });

    it("maps railway=stop to rail mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 10, lat: 0, lon: 0, tags: { name: "Railway Stop", railway: "stop" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("rail");
    });

    it("maps light_rail=yes to rail mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 11, lat: 0, lon: 0, tags: { name: "Light Rail", light_rail: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("rail");
    });

    it("maps ferry=yes to ferry mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 12, lat: 0, lon: 0, tags: { name: "Ferry", ferry: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("ferry");
    });

    it("maps monorail=yes to monorail mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 13, lat: 0, lon: 0, tags: { name: "Monorail", monorail: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("monorail");
    });

    it("maps funicular=yes to funicular mode", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk({
          elements: [{ id: 14, lat: 0, lon: 0, tags: { name: "Funicular", funicular: "yes" } }],
        }),
      );

      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);

      expect(stops[0].modes).toContain("funicular");
    });
  });
});
