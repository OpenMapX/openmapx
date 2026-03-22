import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock isochrone factory

const mockIsochrone = vi.fn();

vi.mock("../../services/isochrone/factory.js", () => ({
  getIsochroneProvider: () => ({
    isochrone: mockIsochrone,
  }),
}));

// Mock cache

vi.mock("../../utils/cache.js", () => ({
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  hashKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  round: vi.fn((n: number, d: number) => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }),
  TTL: { isochrone: 3600 },
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { isochroneRoute } = await import("../isochrone.js");
  app = Fastify({ logger: false });
  await app.register(isochroneRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const VALID_PARAMS = {
  lat: "52.52",
  lng: "13.37",
  mode: "driving",
  contours: "5,10,15",
};

const MOCK_ISOCHRONE_RESULT = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { contour: 5 },
      geometry: { type: "Polygon", coordinates: [[[13.37, 52.52]]] },
    },
  ],
};

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Tests

describe("GET /isochrone", () => {
  it("returns 200 with isochrone data for all valid params", async () => {
    mockIsochrone.mockResolvedValue(MOCK_ISOCHRONE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs(VALID_PARAMS)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_ISOCHRONE_RESULT);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("passes sorted contour minutes to provider", async () => {
    mockIsochrone.mockResolvedValue(MOCK_ISOCHRONE_RESULT);

    await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, contours: "15,5,10" })}`,
    });

    expect(mockIsochrone).toHaveBeenCalledWith([13.37, 52.52], "driving", [5, 10, 15]);
  });

  it("returns 400 for invalid lat", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, lat: "abc" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("lat and lng must be valid numbers");
  });

  it("returns 400 for invalid lng", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, lng: "xyz" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("lat and lng must be valid numbers");
  });

  it("returns 400 for invalid mode", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, mode: "flying" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toContain("Invalid mode");
  });

  it("returns 400 when no positive contours provided", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, contours: "0,-5,abc" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("contours must contain at least one positive number");
  });

  it("returns 400 when more than 4 contours", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, contours: "5,10,15,20,25" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Maximum 4 contours per request");
  });

  it("returns 502 with no-cache on upstream error", async () => {
    mockIsochrone.mockRejectedValue(new Error("Valhalla timeout"));

    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs(VALID_PARAMS)}`,
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("Isochrone service unavailable");
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("sets Cache-Control: public, max-age=3600 on success", async () => {
    mockIsochrone.mockResolvedValue(MOCK_ISOCHRONE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs(VALID_PARAMS)}`,
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("accepts walking mode", async () => {
    mockIsochrone.mockResolvedValue(MOCK_ISOCHRONE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, mode: "walking" })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockIsochrone).toHaveBeenCalledWith(expect.anything(), "walking", expect.anything());
  });

  it("accepts cycling mode", async () => {
    mockIsochrone.mockResolvedValue(MOCK_ISOCHRONE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, mode: "cycling" })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockIsochrone).toHaveBeenCalledWith(expect.anything(), "cycling", expect.anything());
  });

  it("returns 400 when required params are missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/isochrone?lat=52.52",
    });

    expect(res.statusCode).toBe(400);
  });

  it("filters out non-positive contour values", async () => {
    mockIsochrone.mockResolvedValue(MOCK_ISOCHRONE_RESULT);

    await app.inject({
      method: "GET",
      url: `/isochrone?${qs({ ...VALID_PARAMS, contours: "5,-3,10,0" })}`,
    });

    expect(mockIsochrone).toHaveBeenCalledWith(expect.anything(), expect.anything(), [5, 10]);
  });
});
