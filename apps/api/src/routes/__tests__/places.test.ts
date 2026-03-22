import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock nominatim lookup service

const mockLookupByOsmRef = vi.fn();
const mockLookupByCoords = vi.fn();
const mockLookupByNameAndCoords = vi.fn();

vi.mock("../../services/nominatim-lookup.service.js", () => ({
  lookupByOsmRef: mockLookupByOsmRef,
  lookupByCoords: mockLookupByCoords,
  lookupByNameAndCoords: mockLookupByNameAndCoords,
}));

// Mock enrichment service

const mockEnrichPlace = vi.fn();

vi.mock("../../services/enrichment/index.js", () => ({
  enrichPlace: mockEnrichPlace,
}));

// Mock DB RIS service

const mockLookupDbStation = vi.fn();

vi.mock("../../services/db-ris/index.js", () => ({
  lookupDbStation: mockLookupDbStation,
}));

// Mock review links

const mockBuildReviewLinks = vi.fn();

vi.mock("../../services/review-links.js", () => ({
  buildReviewLinks: mockBuildReviewLinks,
}));

// Mock cache

vi.mock("../../utils/cache.js", () => ({
  withCache: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn()),
  TTL: { places: { detail: 86400 } },
}));

// App setup

let app: FastifyInstance;

beforeAll(async () => {
  const { placesRoute } = await import("../places.js");
  app = Fastify({ logger: false });
  await app.register(placesRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.clearAllMocks();
});

// Fixtures

const MOCK_PLACE = {
  id: "node/12345",
  name: "Brandenburg Gate",
  lat: 52.5163,
  lng: 13.3777,
  osmTags: { tourism: "attraction", name: "Brandenburger Tor" },
};

const MOCK_ENRICHMENT = {
  description: "Famous landmark in Berlin",
  wikipediaUrl: "https://en.wikipedia.org/wiki/Brandenburg_Gate",
  photos: [],
  externalIds: { wikidata: "Q82425" },
};

const MOCK_REVIEW_LINKS = [{ platform: "google", url: "https://google.com/maps/place/..." }];

const MOCK_DB_STATION = {
  id: "db-8011160",
  name: "Berlin Hbf",
  lat: 52.525,
  lng: 13.369,
};

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Tests

describe("GET /places", () => {
  it("returns 200 with not-yet-implemented message", async () => {
    const res = await app.inject({ method: "GET", url: "/places" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ data: [], message: "Not yet implemented" });
  });
});

describe("GET /places/:id", () => {
  it("returns enriched place for OSM ref (node/12345)", async () => {
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockEnrichPlace.mockResolvedValue(MOCK_ENRICHMENT);
    mockBuildReviewLinks.mockReturnValue(MOCK_REVIEW_LINKS);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("node/12345")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(
      expect.objectContaining({
        id: "node/12345",
        name: "Brandenburg Gate",
        description: "Famous landmark in Berlin",
        reviewLinks: MOCK_REVIEW_LINKS,
      }),
    );
    expect(mockLookupByOsmRef).toHaveBeenCalledWith("node", "12345", "node/12345", undefined);
    expect(mockEnrichPlace).toHaveBeenCalledWith(MOCK_PLACE, undefined);
    expect(mockBuildReviewLinks).toHaveBeenCalledWith(MOCK_PLACE, { wikidata: "Q82425" });
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("looks up DB station for db- prefix", async () => {
    mockLookupDbStation.mockResolvedValue(MOCK_DB_STATION);

    const res = await app.inject({
      method: "GET",
      url: "/places/db-8011160",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(MOCK_DB_STATION);
    expect(mockLookupDbStation).toHaveBeenCalledWith("8011160", undefined);
  });

  it("returns 400 for db- prefix with non-numeric EVA number", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places/db-abc",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Invalid EVA number");
  });

  it("returns 400 for non-OSM ID missing lat/lng/name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places/custom-123",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Non-OSM place ID requires lat, lng, and name query parameters");
  });

  it("returns 400 when name is missing for non-OSM ID", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Non-OSM place ID requires lat, lng, and name query parameters");
  });

  it("prefers lookupByCoords for ds- prefix IDs", async () => {
    const coordPlace = { ...MOCK_PLACE, id: "ds-fuel-123" };
    mockLookupByCoords.mockResolvedValue(coordPlace);
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/ds-fuel-123?${qs({ lat: "52.52", lng: "13.37", name: "Shell Station" })}`,
    });

    expect(res.statusCode).toBe(200);
    // lookupByCoords should be called first for ds- prefix
    expect(mockLookupByCoords).toHaveBeenCalledWith(52.52, 13.37, "ds-fuel-123", undefined);
    // lookupByNameAndCoords should NOT have been called since coords returned a result
    expect(mockLookupByNameAndCoords).not.toHaveBeenCalled();
  });

  it("falls back to lookupByNameAndCoords for ds- prefix when coords returns null", async () => {
    mockLookupByCoords.mockResolvedValue(null);
    mockLookupByNameAndCoords.mockResolvedValue(MOCK_PLACE);
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/ds-fuel-123?${qs({ lat: "52.52", lng: "13.37", name: "Shell Station" })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByCoords).toHaveBeenCalled();
    expect(mockLookupByNameAndCoords).toHaveBeenCalled();
  });

  it("prefers lookupByNameAndCoords for non-ds prefix IDs", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(MOCK_PLACE);
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37", name: "Some Place" })}`,
    });

    expect(res.statusCode).toBe(200);
    // lookupByNameAndCoords should be called first for non-ds prefix
    expect(mockLookupByNameAndCoords).toHaveBeenCalledWith(
      "Some Place",
      52.52,
      13.37,
      "custom-123",
      undefined,
    );
    // lookupByCoords should NOT have been called since name+coords returned a result
    expect(mockLookupByCoords).not.toHaveBeenCalled();
  });

  it("falls back to lookupByCoords for non-ds prefix when name+coords returns null", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(null);
    mockLookupByCoords.mockResolvedValue(MOCK_PLACE);
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37", name: "Some Place" })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByNameAndCoords).toHaveBeenCalled();
    expect(mockLookupByCoords).toHaveBeenCalled();
  });

  it("returns 404 when neither lookup returns a result", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(null);
    mockLookupByCoords.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37", name: "Nonexistent" })}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toContain("No OSM match found");
  });

  it("sets Cache-Control: public, max-age=86400 on success", async () => {
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("node/12345")}`,
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("does not set Cache-Control on 400 error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places/db-abc",
    });

    expect(res.statusCode).toBe(400);
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("does not set Cache-Control on 404 error", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(null);
    mockLookupByCoords.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37", name: "Nonexistent" })}`,
    });

    expect(res.statusCode).toBe(404);
    expect(res.headers["cache-control"]).toBeUndefined();
  });

  it("passes lang parameter through to services", async () => {
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("node/12345")}?lang=de`,
    });

    expect(mockLookupByOsmRef).toHaveBeenCalledWith("node", "12345", "node/12345", "de");
    expect(mockEnrichPlace).toHaveBeenCalledWith(MOCK_PLACE, "de");
  });

  it("handles way/ and relation/ OSM refs", async () => {
    mockLookupByOsmRef.mockResolvedValue({ ...MOCK_PLACE, id: "way/67890" });
    mockEnrichPlace.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("way/67890")}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByOsmRef).toHaveBeenCalledWith("way", "67890", "way/67890", undefined);
  });

  it("returns 500 with generic message on unexpected error", async () => {
    mockLookupByOsmRef.mockRejectedValue(new Error("Unexpected failure"));

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("node/12345")}`,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("Internal server error");
  });
});
