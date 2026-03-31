import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock routing resolver

const mockGetRoute = vi.fn();

const mockProvider = {
  id: "mock-provider",
  supportedModes: ["driving", "walking", "cycling"],
  getRoute: mockGetRoute,
};

vi.mock("../../services/routing.resolver.js", () => ({
  getRoutingProvider: vi.fn(() => mockProvider),
  getOptimizeProvider: vi.fn(() => null),
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
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(VALID_PARAMS)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_ROUTE_RESULT);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("calls provider.getRoute for mode=driving (default)", async () => {
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs(VALID_PARAMS)}`,
    });

    expect(mockGetRoute).toHaveBeenCalledWith(
      [
        [13.37, 52.52],
        [9.99, 53.55],
      ],
      "driving",
      expect.objectContaining({
        avoidHighways: false,
        avoidTolls: false,
        avoidFerries: false,
        units: "metric",
      }),
    );
  });

  it("calls provider.getRoute for mode=walking", async () => {
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "walking" })}`,
    });

    expect(mockGetRoute).toHaveBeenCalledWith(
      [
        [13.37, 52.52],
        [9.99, 53.55],
      ],
      "walking",
      expect.objectContaining({ units: "metric" }),
    );
  });

  it("calls provider.getRoute for mode=cycling", async () => {
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "cycling" })}`,
    });

    expect(mockGetRoute).toHaveBeenCalledWith(
      [
        [13.37, 52.52],
        [9.99, 53.55],
      ],
      "cycling",
      expect.objectContaining({ units: "metric" }),
    );
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
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({
        ...VALID_PARAMS,
        avoidHighways: "true",
        avoidTolls: "true",
        avoidFerries: "true",
      })}`,
    });

    expect(mockGetRoute).toHaveBeenCalledWith(
      expect.anything(),
      "driving",
      expect.objectContaining({
        avoidHighways: true,
        avoidTolls: true,
        avoidFerries: true,
      }),
    );
  });

  it("passes lang in options", async () => {
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    await app.inject({
      method: "GET",
      url: `/directions?${qs({ ...VALID_PARAMS, mode: "walking", lang: "de" })}`,
    });

    expect(mockGetRoute).toHaveBeenCalledWith(
      expect.anything(),
      "walking",
      expect.objectContaining({ lang: "de" }),
    );
  });

  it("sets Cache-Control: public, max-age=3600", async () => {
    mockGetRoute.mockResolvedValue(MOCK_ROUTE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: `/directions?${qs(VALID_PARAMS)}`,
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });
});
