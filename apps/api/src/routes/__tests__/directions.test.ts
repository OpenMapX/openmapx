import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock OSRM service

const mockOsrmRoute = vi.fn();

vi.mock("@integrations/routing-osrm/provider.js", () => ({
  osrmService: { route: mockOsrmRoute },
}));

// Mock Valhalla service

const mockValhallaRoute = vi.fn();

vi.mock("@integrations/routing-valhalla/provider.js", () => ({
  valhallaService: { route: mockValhallaRoute },
}));

// Mock cache

vi.mock("../../utils/cache.js", () => ({
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  hashKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  round: vi.fn((n: number, d: number) => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }),
  TTL: { directions: 3600 },
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { directionsRoute } = await import("../directions.js");
  app = Fastify({ logger: false });
  await app.register(directionsRoute);
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
  originLng: "13.37",
  originLat: "52.52",
  destLng: "9.99",
  destLat: "53.55",
};

const MOCK_ROUTE_RESULT = {
  routes: [
    {
      distance: 28900,
      duration: 1800,
      geometry: {
        type: "LineString",
        coordinates: [
          [13.37, 52.52],
          [9.99, 53.55],
        ],
      },
      steps: [],
    },
  ],
};

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Tests

describe("GET /directions", () => {
  it("returns 200 with route data for all required params", async () => {
    mockOsrmRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(VALID_PARAMS)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_ROUTE_RESULT);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("calls osrmService.route for mode=driving (default)", async () => {
    mockOsrmRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs(VALID_PARAMS)}`,
    });

    expect(mockOsrmRoute).toHaveBeenCalledWith(
      [
        [13.37, 52.52],
        [9.99, 53.55],
      ],
      expect.objectContaining({
        avoidHighways: false,
        avoidTolls: false,
        avoidFerries: false,
        units: "metric",
      }),
    );
    expect(mockValhallaRoute).not.toHaveBeenCalled();
  });

  it("calls osrmService.route for explicit mode=driving", async () => {
    mockOsrmRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "driving" })}`,
    });

    expect(mockOsrmRoute).toHaveBeenCalled();
    expect(mockValhallaRoute).not.toHaveBeenCalled();
  });

  it("calls valhallaService.route for mode=walking", async () => {
    mockValhallaRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "walking" })}`,
    });

    expect(mockValhallaRoute).toHaveBeenCalledWith(
      [
        [13.37, 52.52],
        [9.99, 53.55],
      ],
      "walking",
      expect.objectContaining({ units: "metric" }),
      undefined,
    );
    expect(mockOsrmRoute).not.toHaveBeenCalled();
  });

  it("calls valhallaService.route for mode=cycling", async () => {
    mockValhallaRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "cycling" })}`,
    });

    expect(mockValhallaRoute).toHaveBeenCalledWith(
      [
        [13.37, 52.52],
        [9.99, 53.55],
      ],
      "cycling",
      expect.objectContaining({ units: "metric" }),
      undefined,
    );
    expect(mockOsrmRoute).not.toHaveBeenCalled();
  });

  it("returns 400 for mode=transit", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "transit" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Use /api/transit/plan for transit routing");
  });

  it("returns 400 for invalid mode", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "helicopter" })}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when originLng is missing", async () => {
    const { originLng, ...rest } = VALID_PARAMS;
    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(rest)}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when originLat is missing", async () => {
    const { originLat, ...rest } = VALID_PARAMS;
    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(rest)}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when destLng is missing", async () => {
    const { destLng, ...rest } = VALID_PARAMS;
    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(rest)}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when destLat is missing", async () => {
    const { destLat, ...rest } = VALID_PARAMS;
    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(rest)}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it("passes avoid options correctly", async () => {
    mockOsrmRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({
        ...VALID_PARAMS,
        avoidHighways: "true",
        avoidTolls: "true",
        avoidFerries: "true",
      })}`,
    });

    expect(mockOsrmRoute).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: true,
      }),
    );
  });

  it("passes lang parameter to valhalla", async () => {
    mockValhallaRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "walking", lang: "de" })}`,
    });

    expect(mockValhallaRoute).toHaveBeenCalledWith(
      expect.anything(),
      "walking",
      expect.anything(),
      "de",
    );
  });

  it("sets Cache-Control: public, max-age=3600", async () => {
    mockOsrmRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(VALID_PARAMS)}`,
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });
});
