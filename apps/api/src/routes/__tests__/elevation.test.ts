import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock elevation service

const mockGetElevation = vi.fn();

vi.mock("../../services/elevation.service.js", () => ({
  elevationService: { getElevation: mockGetElevation },
}));

// Mock cache

vi.mock("../../utils/cache.js", () => ({
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  hashKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  TTL: { elevation: 86400 },
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { elevationRoute } = await import("../elevation.js");
  app = Fastify({ logger: false });
  await app.register(elevationRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const VALID_COORDINATES: [number, number][] = [
  [13.37, 52.52],
  [13.38, 52.53],
  [13.39, 52.54],
];

const MOCK_ELEVATION_RESULT = {
  elevations: [34, 38, 42],
  totalAscent: 8,
  totalDescent: 0,
  minElevation: 34,
  maxElevation: 42,
};

// Tests

describe("POST /elevation", () => {
  it("returns 200 with elevation data for valid body", async () => {
    mockGetElevation.mockResolvedValue(MOCK_ELEVATION_RESULT);

    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: VALID_COORDINATES },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_ELEVATION_RESULT);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("returns 400 when coordinates is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when fewer than 2 coordinates", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: [[13.37, 52.52]] },
    });

    expect(res.statusCode).toBe(400);
  });

  it("passes routeDistance to the service when provided", async () => {
    mockGetElevation.mockResolvedValue(MOCK_ELEVATION_RESULT);

    await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: VALID_COORDINATES, routeDistance: 1500 },
    });

    expect(mockGetElevation).toHaveBeenCalledWith(VALID_COORDINATES, 1500);
  });

  it("passes undefined routeDistance when not provided", async () => {
    mockGetElevation.mockResolvedValue(MOCK_ELEVATION_RESULT);

    await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: VALID_COORDINATES },
    });

    expect(mockGetElevation).toHaveBeenCalledWith(VALID_COORDINATES, undefined);
  });

  it("returns 502 when elevation service returns null", async () => {
    mockGetElevation.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: VALID_COORDINATES },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("Elevation data unavailable");
  });

  it("returns 502 when elevation service throws", async () => {
    mockGetElevation.mockRejectedValue(new Error("Service error"));

    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: VALID_COORDINATES },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error).toBe("Elevation data unavailable");
  });

  it("sets Cache-Control: public, max-age=86400 on success", async () => {
    mockGetElevation.mockResolvedValue(MOCK_ELEVATION_RESULT);

    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: { coordinates: VALID_COORDINATES },
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("returns 400 for invalid coordinate format", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/elevation",
      payload: {
        coordinates: [
          ["a", "b"],
          [13.38, 52.53],
        ],
      },
    });

    expect(res.statusCode).toBe(400);
  });
});
