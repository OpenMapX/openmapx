import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock photos service

const mockSearchPhotos = vi.fn();

vi.mock("../../services/photos/index.js", () => ({
  searchPhotos: mockSearchPhotos,
}));

// Mock nominatim lookup service

const mockLookupByOsmRef = vi.fn();
const mockLookupByNameAndCoords = vi.fn();

vi.mock("../../services/nominatim-lookup.service.js", () => ({
  lookupByOsmRef: mockLookupByOsmRef,
  lookupByNameAndCoords: mockLookupByNameAndCoords,
}));

// Mock cache

vi.mock("../../utils/cache.js", () => ({
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  TTL: { photos: 3600 },
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { photosRoute } = await import("../photos.js");
  app = Fastify({ logger: false });
  await app.register(photosRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const MOCK_PHOTOS = [
  { url: "https://example.com/photo1.jpg", attribution: "CC-BY", source: "wikimedia" },
  { url: "https://example.com/photo2.jpg", attribution: "CC-BY", source: "mapillary" },
];

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Tests

describe("GET /photos", () => {
  it("returns 200 with photos array", async () => {
    mockSearchPhotos.mockResolvedValue(MOCK_PHOTOS);

    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ photos: MOCK_PHOTOS });
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
  });

  it("returns 400 for invalid coordinates", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "abc", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid coordinates");
  });

  it("returns 400 for lat out of range (>90)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "91", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Coordinates out of range");
  });

  it("returns 400 for lat out of range (<-90)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "-91", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Coordinates out of range");
  });

  it("returns 400 for lng out of range (>180)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "181" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Coordinates out of range");
  });

  it("returns 400 for lng out of range (<-180)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "-181" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Coordinates out of range");
  });

  it("clamps limit to 50", async () => {
    mockSearchPhotos.mockResolvedValue([]);

    await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "13.37", limit: "100" })}`,
    });

    expect(mockSearchPhotos).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
  });

  it("defaults limit to 20", async () => {
    mockSearchPhotos.mockResolvedValue([]);

    await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(mockSearchPhotos).toHaveBeenCalledWith(expect.objectContaining({ limit: 20 }));
  });

  it("calls lookupByOsmRef when placeId has OSM format", async () => {
    mockSearchPhotos.mockResolvedValue([]);
    mockLookupByOsmRef.mockResolvedValue({ osmTags: { tourism: "museum" } });

    await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "13.37", placeId: "node/12345" })}`,
    });

    expect(mockLookupByOsmRef).toHaveBeenCalledWith("node", "12345", "node/12345");
    expect(mockSearchPhotos).toHaveBeenCalledWith(
      expect.objectContaining({ osmTags: { tourism: "museum" } }),
    );
  });

  it("calls lookupByNameAndCoords when placeId and name are provided (non-OSM)", async () => {
    mockSearchPhotos.mockResolvedValue([]);
    mockLookupByNameAndCoords.mockResolvedValue({ osmTags: { amenity: "restaurant" } });

    await app.inject({
      method: "GET",
      url: `/photos?${qs({
        lat: "52.52",
        lng: "13.37",
        placeId: "custom-123",
        name: "My Place",
      })}`,
    });

    expect(mockLookupByNameAndCoords).toHaveBeenCalledWith("My Place", 52.52, 13.37, "custom-123");
  });

  it("still returns photos when tag resolution fails", async () => {
    mockSearchPhotos.mockResolvedValue(MOCK_PHOTOS);
    mockLookupByOsmRef.mockRejectedValue(new Error("Nominatim error"));

    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "13.37", placeId: "node/12345" })}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.photos).toEqual(MOCK_PHOTOS);
    // osmTags should be undefined when resolution fails
    expect(mockSearchPhotos).toHaveBeenCalledWith(expect.objectContaining({ osmTags: undefined }));
  });

  it("returns 500 when searchPhotos throws", async () => {
    mockSearchPhotos.mockRejectedValue(new Error("Service down"));

    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("Photo search failed");
  });

  it("returns 400 when lat is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when lng is missing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/photos?${qs({ lat: "52.52" })}`,
    });

    expect(res.statusCode).toBe(400);
  });
});
