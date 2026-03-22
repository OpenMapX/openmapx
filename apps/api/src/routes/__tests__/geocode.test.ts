import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock geocoding factory

const mockGeocode = vi.fn();
const mockReverseGeocode = vi.fn();

vi.mock("../../services/geocoding.factory.js", () => ({
  getGeocodingProvider: () => ({
    geocode: mockGeocode,
    reverseGeocode: mockReverseGeocode,
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
  TTL: {
    geocoding: { forward: 86400, reverse: 86400, autocomplete: 3600 },
  },
}));

// Mock query expansion

vi.mock("../../utils/query-expansion.js", () => ({
  expandSearchQuery: vi.fn((q: string) => q),
  fetchWithVariants: vi.fn((_q: string, fetcher: (v: string) => unknown) => fetcher(_q)),
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { geocodeRoute } = await import("../geocode.js");
  app = Fastify({ logger: false });
  await app.register(geocodeRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const MOCK_GEOCODE_RESULTS = [
  { id: "1", name: "Berlin", lat: 52.52, lng: 13.405 },
  { id: "2", name: "Berlin Mitte", lat: 52.525, lng: 13.4 },
];

const MOCK_REVERSE_RESULT = {
  id: "1",
  name: "Berlin",
  lat: 52.52,
  lng: 13.405,
  address: "Berlin, Germany",
};

// Forward geocoding tests

describe("GET /geocode", () => {
  it("returns 200 with geocode results", async () => {
    mockGeocode.mockResolvedValue(MOCK_GEOCODE_RESULTS);

    const res = await app.inject({ method: "GET", url: "/geocode?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_GEOCODE_RESULTS);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("returns 400 when q is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/geocode" });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when q is empty string", async () => {
    const res = await app.inject({ method: "GET", url: "/geocode?q=" });

    expect(res.statusCode).toBe(400);
  });

  it("returns empty array with no-cache on upstream error", async () => {
    mockGeocode.mockRejectedValue(new Error("Upstream timeout"));

    const res = await app.inject({ method: "GET", url: "/geocode?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("passes lang parameter through", async () => {
    mockGeocode.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/geocode?q=Berlin&lang=de" });

    expect(res.statusCode).toBe(200);
  });
});

// Reverse geocoding tests

describe("GET /geocode/reverse", () => {
  it("returns 200 with reverse geocode result", async () => {
    mockReverseGeocode.mockResolvedValue(MOCK_REVERSE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lat=52.52&lng=13.37",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_REVERSE_RESULT);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("returns 400 for invalid lat", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lat=abc&lng=13.37",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("lat and lng must be valid numbers");
  });

  it("returns 400 for invalid lng", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lat=52.52&lng=notanumber",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("lat and lng must be valid numbers");
  });

  it("returns 400 when lat is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lng=13.37",
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when lng is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lat=52.52",
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns null with no-cache on upstream error", async () => {
    mockReverseGeocode.mockRejectedValue(new Error("Upstream error"));

    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lat=52.52&lng=13.37",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toBeNull();
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("passes lang parameter through", async () => {
    mockReverseGeocode.mockResolvedValue(MOCK_REVERSE_RESULT);

    const res = await app.inject({
      method: "GET",
      url: "/geocode/reverse?lat=52.52&lng=13.37&lang=de",
    });

    expect(res.statusCode).toBe(200);
  });
});
