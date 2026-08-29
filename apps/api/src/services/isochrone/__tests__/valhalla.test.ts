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

function mockNotOk(status = 500, bodyText = "server error") {
  return {
    ok: false,
    status,
    text: async () => bodyText,
  } as unknown as Response;
}

function makePolygonFeature(contour: number, metric = "time") {
  return {
    type: "Feature" as const,
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [13.3, 52.5],
          [13.4, 52.5],
          [13.4, 52.6],
          [13.3, 52.6],
          [13.3, 52.5],
        ],
      ],
    },
    properties: {
      metric,
      contour,
      color: "#ff0000",
      opacity: 0.33,
    },
  };
}

function makeMultiPolygonFeature(contour: number, metric = "time") {
  return {
    type: "Feature" as const,
    geometry: {
      type: "MultiPolygon" as const,
      coordinates: [
        [
          [
            [13.3, 52.5],
            [13.35, 52.5],
            [13.35, 52.55],
            [13.3, 52.55],
            [13.3, 52.5],
          ],
        ],
        [
          [
            [13.4, 52.5],
            [13.45, 52.5],
            [13.45, 52.55],
            [13.4, 52.55],
            [13.4, 52.5],
          ],
        ],
      ],
    },
    properties: {
      metric,
      contour,
      color: "#00ff00",
      opacity: 0.33,
    },
  };
}

function makeIsochroneResponse(features: unknown[]) {
  return {
    type: "FeatureCollection",
    features,
  };
}

const origin: [number, number] = [13.388, 52.517];

describe("valhallaIsochroneProvider", () => {
  it("attributes the actual self-hosted or Stadia endpoint", async () => {
    const { valhallaIsochroneAttributions } = await import("../valhalla.js");

    expect(
      valhallaIsochroneAttributions("http://valhalla.internal:8002").map(
        ({ sourceId }) => sourceId,
      ),
    ).toEqual(["valhalla", "openstreetmap"]);
    expect(
      valhallaIsochroneAttributions("https://api.stadiamaps.com").map(({ sourceId }) => sourceId),
    ).toEqual(["stadia-maps", "openstreetmap"]);
  });

  describe("isochrone()", () => {
    it("returns empty contours without API call when contourMinutes is empty", async () => {
      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      const result = await valhallaIsochroneProvider.isochrone(origin, "driving", []);

      expect(result.origin).toEqual(origin);
      expect(result.mode).toBe("driving");
      expect(result.contours).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("throws when more than 4 contours requested", async () => {
      const { valhallaIsochroneProvider } = await import("../valhalla.js");

      await expect(
        valhallaIsochroneProvider.isochrone(origin, "driving", [5, 10, 15, 20, 25]),
      ).rejects.toThrow("Valhalla supports a maximum of 4 contours per request");
    });

    it("uses costing 'auto' for driving", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [10]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing).toBe("auto");
    });

    it("uses costing 'pedestrian' for walking", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "walking", [10]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing).toBe("pedestrian");
    });

    it("uses costing 'bicycle' for cycling", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "cycling", [10]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.costing).toBe("bicycle");
    });

    it("sets generalize to 50 for ≤15 min contours", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [5, 10, 15]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.generalize).toBe(50);
    });

    it("sets generalize to 100 for ≤30 min contours", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(25)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [25]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.generalize).toBe(100);
    });

    it("sets generalize to 200 for >30 min contours", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(60)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [60]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.generalize).toBe(200);
    });

    it("sorts contours by time ascending in output", async () => {
      const features = [makePolygonFeature(30), makePolygonFeature(10), makePolygonFeature(20)];
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse(features)));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      const result = await valhallaIsochroneProvider.isochrone(origin, "driving", [30, 10, 20]);

      expect(result.contours).toHaveLength(3);
      expect(result.contours[0].time).toBe(10);
      expect(result.contours[1].time).toBe(20);
      expect(result.contours[2].time).toBe(30);
    });

    it("sorts contour minutes ascending in request body", async () => {
      mockFetch.mockResolvedValueOnce(
        mockOk(
          makeIsochroneResponse([
            makePolygonFeature(5),
            makePolygonFeature(15),
            makePolygonFeature(10),
          ]),
        ),
      );

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [15, 5, 10]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.contours).toEqual([{ time: 5 }, { time: 10 }, { time: 15 }]);
    });

    it("filters features by metric === 'time' (ignores distance features)", async () => {
      const features = [
        makePolygonFeature(10, "time"),
        makePolygonFeature(5, "distance"),
        makePolygonFeature(20, "time"),
      ];
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse(features)));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      const result = await valhallaIsochroneProvider.isochrone(origin, "driving", [10, 20]);

      expect(result.contours).toHaveLength(2);
      expect(result.contours[0].time).toBe(10);
      expect(result.contours[1].time).toBe(20);
    });

    it("handles Polygon geometry type", async () => {
      const feature = makePolygonFeature(15);
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([feature])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      const result = await valhallaIsochroneProvider.isochrone(origin, "driving", [15]);

      expect(result.contours[0].geometry.type).toBe("Polygon");
      expect(result.contours[0].geometry.coordinates).toEqual(feature.geometry.coordinates);
    });

    it("handles MultiPolygon geometry type", async () => {
      const feature = makeMultiPolygonFeature(20);
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([feature])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      const result = await valhallaIsochroneProvider.isochrone(origin, "driving", [20]);

      expect(result.contours[0].geometry.type).toBe("MultiPolygon");
      expect(result.contours[0].geometry.coordinates).toEqual(feature.geometry.coordinates);
    });

    it("throws with status and body text on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(422, "Invalid costing options"));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");

      await expect(valhallaIsochroneProvider.isochrone(origin, "driving", [10])).rejects.toThrow(
        "Valhalla isochrone error 422: Invalid costing options",
      );
    });

    it("sends POST to VALHALLA_URL/isochrone", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [10]);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/isochrone");

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      expect(options.method).toBe("POST");
      expect((options.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    });

    it("appends api_key to the URL when VALHALLA_API_KEY is set", async () => {
      const prev = process.env.VALHALLA_API_KEY;
      process.env.VALHALLA_API_KEY = "test-stadia-key";
      try {
        mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));
        const { valhallaIsochroneProvider } = await import("../valhalla.js");
        await valhallaIsochroneProvider.isochrone(origin, "driving", [10]);
        const url = mockFetch.mock.calls[0][0] as string;
        expect(url).toContain("/isochrone?api_key=test-stadia-key");
      } finally {
        if (prev === undefined) delete process.env.VALHALLA_API_KEY;
        else process.env.VALHALLA_API_KEY = prev;
      }
    });

    it("includes polygons=true and denoise=1 in request body", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [10]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.polygons).toBe(true);
      expect(body.denoise).toBe(1);
    });

    it("sets location with lon/lat from origin", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      await valhallaIsochroneProvider.isochrone(origin, "driving", [10]);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
      expect(body.locations).toEqual([{ lon: 13.388, lat: 52.517 }]);
    });

    it("returns origin and mode in result", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeIsochroneResponse([makePolygonFeature(10)])));

      const { valhallaIsochroneProvider } = await import("../valhalla.js");
      const result = await valhallaIsochroneProvider.isochrone(origin, "walking", [10]);

      expect(result.origin).toEqual(origin);
      expect(result.mode).toBe("walking");
    });

    it("handles error in res.text() gracefully during error path", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => {
          throw new Error("text read failed");
        },
      } as unknown as Response);

      const { valhallaIsochroneProvider } = await import("../valhalla.js");

      await expect(valhallaIsochroneProvider.isochrone(origin, "driving", [10])).rejects.toThrow(
        "Valhalla isochrone error 500: ",
      );
    });
  });
});
