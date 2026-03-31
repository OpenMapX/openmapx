import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock data source registry

const mockGetAll = vi.fn();
const mockGet = vi.fn();

vi.mock("../../services/data-sources/registry.js", () => ({
  dataSourceRegistry: {
    getAll: mockGetAll,
    get: mockGet,
  },
}));

import { ConfigurationError } from "@openmapx/core";

// Mock cache

vi.mock("../../utils/cache.js", () => ({
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  hashKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  round: vi.fn((n: number, d: number) => {
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }),
  TTL: {
    dataSources: { filters: 172800, search: 21600, detail: 21600 },
  },
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { dataSourcesRoute } = await import("../data-sources.js");
  app = Fastify({ logger: false });
  await app.register(dataSourcesRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const MOCK_PROVIDER = {
  id: "ev-charging",
  meta: { id: "ev-charging", name: "EV Charging", icon: "ev_station" },
  getFilters: vi.fn().mockResolvedValue([{ id: "power", label: "Power", type: "range" }]),
  search: vi.fn().mockResolvedValue([{ id: "item-1", lat: 52.52, lng: 13.405, name: "Charger A" }]),
  getDetail: vi.fn().mockResolvedValue({
    id: "item-1",
    lat: 52.52,
    lng: 13.405,
    name: "Charger A",
    address: "Berlin, Germany",
  }),
  searchCacheTtl: undefined,
  detailCacheTtl: undefined,
};

const VALID_BBOX = { south: "52.0", west: "13.0", north: "53.0", east: "14.0" };

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Tests

describe("GET /data-sources", () => {
  it("returns list of providers with filters", async () => {
    mockGetAll.mockReturnValue([MOCK_PROVIDER]);

    const res = await app.inject({ method: "GET", url: "/data-sources" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toEqual(
      expect.objectContaining({ id: "ev-charging", name: "EV Charging" }),
    );
  });

  it("returns empty sources when no providers registered", async () => {
    mockGetAll.mockReturnValue([]);

    const res = await app.inject({ method: "GET", url: "/data-sources" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sources).toEqual([]);
  });
});

describe("GET /data-sources/:id/search", () => {
  it("returns 200 with search results for valid bbox", async () => {
    mockGet.mockReturnValue(MOCK_PROVIDER);

    const res = await app.inject({
      method: "GET",
      url: `/data-sources/ev-charging/search?${qs(VALID_BBOX)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual([{ id: "item-1", lat: 52.52, lng: 13.405, name: "Charger A" }]);
  });

  it("returns 404 for unknown data source id", async () => {
    mockGet.mockReturnValue(undefined);

    const res = await app.inject({
      method: "GET",
      url: `/data-sources/unknown/search?${qs(VALID_BBOX)}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("Unknown data source");
  });

  it("returns 400 for invalid bbox coordinates", async () => {
    mockGet.mockReturnValue(MOCK_PROVIDER);

    const res = await app.inject({
      method: "GET",
      url: "/data-sources/ev-charging/search?south=abc&west=13.0&north=53.0&east=14.0",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid bbox coordinates");
  });

  it("returns 400 for invalid JSON filters", async () => {
    mockGet.mockReturnValue(MOCK_PROVIDER);

    const res = await app.inject({
      method: "GET",
      url: `/data-sources/ev-charging/search?${qs(VALID_BBOX)}&filters=not-json`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid filters JSON");
  });

  it("passes valid JSON filters to provider.search", async () => {
    const searchFn = vi.fn().mockResolvedValue([]);
    mockGet.mockReturnValue({ ...MOCK_PROVIDER, search: searchFn });

    const filters = encodeURIComponent(JSON.stringify({ power: 50 }));
    const res = await app.inject({
      method: "GET",
      url: `/data-sources/ev-charging/search?${qs(VALID_BBOX)}&filters=${filters}`,
    });

    expect(res.statusCode).toBe(200);
    expect(searchFn).toHaveBeenCalledWith(
      expect.objectContaining({ south: 52, west: 13, north: 53, east: 14 }),
      { power: 50 },
    );
  });

  it("returns 503 for ConfigurationError", async () => {
    const searchFn = vi
      .fn()
      .mockRejectedValue(new ConfigurationError("OPENCHARGEMAP_API_KEY is not configured"));
    mockGet.mockReturnValue({ ...MOCK_PROVIDER, search: searchFn });

    const res = await app.inject({
      method: "GET",
      url: `/data-sources/ev-charging/search?${qs(VALID_BBOX)}`,
    });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error).toBe("OPENCHARGEMAP_API_KEY is not configured");
  });

  it("sets Cache-Control header on success", async () => {
    mockGet.mockReturnValue(MOCK_PROVIDER);

    const res = await app.inject({
      method: "GET",
      url: `/data-sources/ev-charging/search?${qs(VALID_BBOX)}`,
    });

    expect(res.headers["cache-control"]).toMatch(/^public, max-age=\d+$/);
  });
});

describe("GET /data-sources/:id/detail/*", () => {
  it("returns 200 with detail data", async () => {
    mockGet.mockReturnValue(MOCK_PROVIDER);

    const res = await app.inject({
      method: "GET",
      url: "/data-sources/ev-charging/detail/item-1",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(expect.objectContaining({ id: "item-1", name: "Charger A" }));
  });

  it("returns 404 for unknown data source", async () => {
    mockGet.mockReturnValue(undefined);

    const res = await app.inject({
      method: "GET",
      url: "/data-sources/unknown/detail/item-1",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("Unknown data source");
  });

  it("handles IDs with slashes (wildcard param)", async () => {
    const detailFn = vi.fn().mockResolvedValue({ id: "tankerkoenig/abc-123" });
    mockGet.mockReturnValue({ ...MOCK_PROVIDER, getDetail: detailFn });

    const res = await app.inject({
      method: "GET",
      url: "/data-sources/ev-charging/detail/tankerkoenig/abc-123",
    });

    expect(res.statusCode).toBe(200);
    expect(detailFn).toHaveBeenCalledWith("tankerkoenig/abc-123");
  });

  it("returns 503 for ConfigurationError on detail", async () => {
    const detailFn = vi
      .fn()
      .mockRejectedValue(new ConfigurationError("OPENCHARGEMAP_API_KEY is not configured"));
    mockGet.mockReturnValue({ ...MOCK_PROVIDER, getDetail: detailFn });

    const res = await app.inject({
      method: "GET",
      url: "/data-sources/ev-charging/detail/item-1",
    });

    expect(res.statusCode).toBe(503);
  });

  it("sets Cache-Control header on detail success", async () => {
    mockGet.mockReturnValue(MOCK_PROVIDER);

    const res = await app.inject({
      method: "GET",
      url: "/data-sources/ev-charging/detail/item-1",
    });

    expect(res.headers["cache-control"]).toMatch(/^public, max-age=\d+$/);
  });
});
