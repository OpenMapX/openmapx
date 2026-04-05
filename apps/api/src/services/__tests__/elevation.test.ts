import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@openmapx/core", () => ({
  encodePolyline: vi.fn(() => "encoded_string"),
}));

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

function mockNotOk(status = 500) {
  return { ok: false, status } as Response;
}

function makeCoords(count: number): [number, number][] {
  const coords: [number, number][] = [];
  for (let i = 0; i < count; i++) {
    coords.push([13.388 + i * 0.001, 52.517 + i * 0.001]);
  }
  return coords;
}

function makeHeightResponse(pairs: [number, number][]) {
  return { range_height: pairs };
}

const sampleCoords: [number, number][] = [
  [13.388, 52.517],
  [13.392, 52.521],
  [13.397, 52.529],
];

const sampleRangeHeight: [number, number][] = [
  [0, 34.5],
  [50, 36.2],
  [100, 38.1],
  [150, 37.0],
];

describe("elevationService", () => {
  describe("getElevation()", () => {
    it("returns points and interval from /height response", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 5000);

      expect(result).not.toBeNull();
      expect(result?.points).toHaveLength(4);
      expect(result?.interval).toBe(50); // 5km < 100km → 50m resample
    });

    it("maps each range_height pair to {distance, elevation}", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 5000);

      expect(result?.points[0].distance).toBe(0);
      expect(result?.points[0].elevation).toBe(34.5);
      expect(result?.points[1].distance).toBe(50);
      expect(result?.points[1].elevation).toBe(36.2);
      expect(result?.points[2].distance).toBe(100);
      expect(result?.points[2].elevation).toBe(38.1);
      expect(result?.points[3].distance).toBe(150);
      expect(result?.points[3].elevation).toBe(37.0);
    });

    it("simplifies to max 500 points when input exceeds 500", async () => {
      const largeCoords = makeCoords(600);
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { encodePolyline } = await import("@openmapx/core");
      const encodeMock = encodePolyline as ReturnType<typeof vi.fn>;
      const callsBefore = encodeMock.mock.calls.length;

      const { elevationService } = await import("../elevation.service.js");
      await elevationService.getElevation(largeCoords, 10000);

      // encodePolyline should have been called with at most 500 points
      const callArgs = encodeMock.mock.calls[callsBefore][0] as [number, number][];
      expect(callArgs).toHaveLength(500);
    });

    it("passes through coordinates unchanged when ≤500 points", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { encodePolyline } = await import("@openmapx/core");
      const encodeMock = encodePolyline as ReturnType<typeof vi.fn>;
      const callsBefore = encodeMock.mock.calls.length;

      const { elevationService } = await import("../elevation.service.js");
      await elevationService.getElevation(sampleCoords, 5000);

      const callArgs = encodeMock.mock.calls[callsBefore][0] as [number, number][];
      expect(callArgs).toHaveLength(3);
    });

    it("uses resample distance 50m for routes < 100km", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 50_000);

      expect(result?.interval).toBe(50);
    });

    it("uses resample distance 100m for routes 100-500km", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 200_000); // 200km

      expect(result?.interval).toBe(100);
    });

    it("uses resample distance 200m for routes ≥500km", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 600_000); // 600km

      expect(result?.interval).toBe(200);
    });

    it("defaults to 50m resample when routeDistance is 0", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 0);

      // routeLengthKm = 0/1000 = 0, then `|| 50` → 50km < 100 → resample 50
      expect(result?.interval).toBe(50);
    });

    it("defaults to 50m resample when routeDistance is undefined", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords);

      // routeDistanceMetres undefined → 0 / 1000 = 0, `|| 50` → 50km < 100 → resample 50
      expect(result?.interval).toBe(50);
    });

    it("returns null on HTTP error", async () => {
      mockFetch.mockResolvedValueOnce(mockNotOk(500));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 5000);

      expect(result).toBeNull();
    });

    it("returns null when range_height is empty", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse([])));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 5000);

      expect(result).toBeNull();
    });

    it("returns null when range_height is missing", async () => {
      mockFetch.mockResolvedValueOnce(mockOk({}));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 5000);

      expect(result).toBeNull();
    });

    it("returns null when fetch throws", async () => {
      mockFetch.mockRejectedValueOnce(new Error("network failure"));

      const { elevationService } = await import("../elevation.service.js");
      const result = await elevationService.getElevation(sampleCoords, 5000);

      expect(result).toBeNull();
    });

    it("sends POST to VALHALLA_URL/height with correct body", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { elevationService } = await import("../elevation.service.js");
      await elevationService.getElevation(sampleCoords, 5000);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain("/height");

      const options = mockFetch.mock.calls[0][1] as RequestInit;
      expect(options.method).toBe("POST");

      const body = JSON.parse(options.body as string);
      expect(body.encoded_polyline).toBe("encoded_string");
      expect(body.range).toBe(true);
      expect(body.resample_distance).toBe(50);
      expect(body.height_precision).toBe(1);
      expect(body.shape_format).toBe("polyline6");
    });

    it("passes precision 6 to encodePolyline", async () => {
      mockFetch.mockResolvedValueOnce(mockOk(makeHeightResponse(sampleRangeHeight)));

      const { encodePolyline } = await import("@openmapx/core");
      const { elevationService } = await import("../elevation.service.js");
      await elevationService.getElevation(sampleCoords, 5000);

      expect(encodePolyline).toHaveBeenCalledWith(sampleCoords, 6);
    });
  });
});
