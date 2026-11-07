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

/** A real response, which the client reads as text before parsing it as JSON. */
function mockOk(data: unknown) {
  return new Response(JSON.stringify(data), { status: 200 });
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
      expect(stops[0].id).toBe("osm:node/12345");
      expect(stops[0].name).toBe("Hauptbahnhof");
      expect(stops[0].lat).toBe(48.14);
      expect(stops[0].lng).toBe(11.56);
      expect(stops[0].provider).toBe("overpass");
    });

    it.each([
      ["train", "rail", { train: "yes" }],
      ["subway", "subway", { subway: "yes" }],
      ["bus", "bus", { bus: "yes" }],
      ["aerialway gondola", "gondola", { aerialway: "gondola" }],
      ["aerialway cable_car", "cable_car", { aerialway: "cable_car" }],
      ["unknown", "bus", {}],
      ["railway stop", "rail", { railway: "stop" }],
      ["light rail", "rail", { light_rail: "yes" }],
      ["ferry", "ferry", { ferry: "yes" }],
      ["monorail", "monorail", { monorail: "yes" }],
      ["funicular", "funicular", { funicular: "yes" }],
    ] as const)("maps %s tags to %s mode", async (_label, mode, tags) => {
      mockFetch.mockResolvedValueOnce(
        mockOk({ elements: [{ id: 1, lat: 0, lon: 0, tags: { name: "Stop", ...tags } }] }),
      );
      const { getStops } = await loadModule();
      const stops = await getStops([0, 0, 1, 1]);
      expect(stops[0].modes).toEqual([mode]);
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
        "User-Agent": "Open-MapX/1.0",
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
  });
});

it("preserves the actual Overpass response supplier on converted transit stops", async () => {
  mockFetch.mockResolvedValueOnce(
    mockOk({ elements: [{ id: 1, lat: 50, lon: 8, tags: { name: "Stop" } }] }),
  );
  const { getStops } = await loadModule();
  const stops = await getStops([7, 49, 9, 51]);
  expect(stops[0].contributors?.map((receipt) => receipt.sourceId)).toContain("openstreetmap");
});
