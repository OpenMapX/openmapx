import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock geocoding factory

const mockAutocomplete = vi.fn();

vi.mock("../../services/geocoding.factory.js", () => ({
  getGeocodingProvider: () => ({
    autocomplete: mockAutocomplete,
  }),
}));

// Mock cache — including MemCache class used with `new MemCache()`

const mockMemGet = vi.fn();
const mockMemSet = vi.fn();
const mockWithCache = vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn());
const mockCacheGet = vi.fn();

class MockMemCache {
  get = mockMemGet;
  set = mockMemSet;
}

vi.mock("../../utils/cache.js", () => ({
  withCache: mockWithCache,
  cacheGet: mockCacheGet,
  hashKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  MemCache: MockMemCache,
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
  const { autocompleteRoute } = await import("../autocomplete.js");
  app = Fastify({ logger: false });
  await app.register(autocompleteRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const MOCK_AUTOCOMPLETE_RESULTS = [
  { id: "1", name: "Berlin", lat: 52.52, lng: 13.405 },
  { id: "2", name: "Berlin Mitte", lat: 52.525, lng: 13.4 },
];

// Tests

describe("GET /autocomplete", () => {
  it("returns 200 with autocomplete results", async () => {
    mockMemGet.mockReturnValue(null);
    mockAutocomplete.mockResolvedValue(MOCK_AUTOCOMPLETE_RESULTS);

    const res = await app.inject({ method: "GET", url: "/autocomplete?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_AUTOCOMPLETE_RESULTS);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("returns 400 when q is missing", async () => {
    const res = await app.inject({ method: "GET", url: "/autocomplete" });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when q is empty string", async () => {
    const res = await app.inject({ method: "GET", url: "/autocomplete?q=" });

    expect(res.statusCode).toBe(400);
  });

  it("returns L1 cached data when fresh hit exists", async () => {
    mockMemGet.mockReturnValue({ data: MOCK_AUTOCOMPLETE_RESULTS, stale: false });

    const res = await app.inject({ method: "GET", url: "/autocomplete?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_AUTOCOMPLETE_RESULTS);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    // Upstream should NOT have been called
    expect(mockAutocomplete).not.toHaveBeenCalled();
    expect(mockWithCache).not.toHaveBeenCalled();
  });

  it("returns stale L1 data and triggers background refresh", async () => {
    mockMemGet.mockReturnValue({ data: MOCK_AUTOCOMPLETE_RESULTS, stale: true });
    mockAutocomplete.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/autocomplete?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_AUTOCOMPLETE_RESULTS);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    // Background refresh was triggered (withCache called in void)
    expect(mockWithCache).toHaveBeenCalled();
  });

  it("serves stale Redis data with max-age=60 when upstream fails", async () => {
    mockMemGet.mockReturnValue(null);
    mockWithCache.mockRejectedValue(new Error("Upstream timeout"));
    mockCacheGet.mockResolvedValue(MOCK_AUTOCOMPLETE_RESULTS);

    const res = await app.inject({ method: "GET", url: "/autocomplete?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_AUTOCOMPLETE_RESULTS);
    expect(res.headers["cache-control"]).toBe("public, max-age=60");
  });

  it("returns empty array with no-cache when upstream fails and no stale data", async () => {
    mockMemGet.mockReturnValue(null);
    mockWithCache.mockRejectedValue(new Error("Upstream timeout"));
    mockCacheGet.mockResolvedValue(null);

    const res = await app.inject({ method: "GET", url: "/autocomplete?q=Berlin" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([]);
    expect(res.headers["cache-control"]).toBe("no-cache");
  });

  it("sets Cache-Control: public, max-age=3600 on success", async () => {
    mockMemGet.mockReturnValue(null);
    mockWithCache.mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn());
    mockAutocomplete.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url: "/autocomplete?q=test" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("populates memCache after successful upstream fetch", async () => {
    mockMemGet.mockReturnValue(null);
    mockWithCache.mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn());
    mockAutocomplete.mockResolvedValue(MOCK_AUTOCOMPLETE_RESULTS);

    await app.inject({ method: "GET", url: "/autocomplete?q=Berlin" });

    expect(mockMemSet).toHaveBeenCalled();
  });
});
