import { registerPlaceResolver } from "@openmapx/core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock nominatim lookup service

const mockLookupByOsmRef = vi.fn();
const mockLookupByCoords = vi.fn();
const mockLookupByNameAndCoords = vi.fn();
const mockLookupByOsmFilters = vi.fn();
const mockLookupAddressByCoords = vi.fn();

vi.mock("../../../../../integrations/geocoding/place-lookup.js", () => ({
  lookupByOsmRef: mockLookupByOsmRef,
  lookupByCoords: mockLookupByCoords,
  lookupByNameAndCoords: mockLookupByNameAndCoords,
  lookupByOsmFilters: mockLookupByOsmFilters,
  lookupAddressByCoords: mockLookupAddressByCoords,
}));

// Mock knowledge service

const mockGetPlaceKnowledge = vi.fn();

vi.mock("../../services/knowledge/index.js", () => ({
  getPlaceKnowledge: mockGetPlaceKnowledge,
}));

// Mock photo service

vi.mock("../../../../../integrations/photos/orchestrator.js", () => ({
  searchHeroPhotos: vi.fn().mockResolvedValue([]),
  deduplicatePhotos: vi.fn((photos: unknown[]) => photos),
}));

// Mock reviews orchestrator — `fetchAggregate` would otherwise hit the
// real Mangrove service via safeAggregate on every `/places/:id` call.
vi.mock("../../../../../integrations/reviews/orchestrator.js", () => ({
  fetchAggregate: vi.fn().mockResolvedValue(null),
}));

// Mock DB RIS service

const mockLookupDbStation = vi.fn();

vi.mock("@integrations/geocoding-db-ris/provider.js", () => ({
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
  // Register the built-in scheme resolvers the route depends on. In the
  // running server these register themselves from each integration's
  // setup() during initIntegrations; the test boots the route in
  // isolation, so we wire them directly here.
  registerPlaceResolver("osm", async (value, ctx) => {
    const match = value.match(/^(node|way|relation)\/(\d+)/);
    if (!match) return null;
    const [, osmType, osmId] = match;
    return mockLookupByOsmRef(osmType, osmId, `osm:${value}`, ctx.lang);
  });
  registerPlaceResolver("eva", async (value, ctx) => {
    if (!/^\d+$/.test(value)) return null;
    return mockLookupDbStation(value, ctx.lang);
  });

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
  id: "osm:node/12345",
  primaryScheme: "osm",
  ids: { osm: "node/12345" },
  name: "Brandenburg Gate",
  address: "Pariser Platz, Berlin",
  lat: 52.5163,
  lng: 13.3777,
  coordinates: [13.3777, 52.5163] as [number, number],
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
  id: "eva:8011160",
  primaryScheme: "eva",
  ids: { eva: "8011160" },
  name: "Berlin Hbf",
  address: "Berlin Hbf",
  coordinates: [13.369, 52.525] as [number, number],
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
  it("returns place with knowledge data for OSM ref", async () => {
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue(MOCK_ENRICHMENT);
    mockBuildReviewLinks.mockReturnValue(MOCK_REVIEW_LINKS);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(
      expect.objectContaining({
        id: "osm:node/12345",
        name: "Brandenburg Gate",
        description: "Famous landmark in Berlin",
        reviewLinks: MOCK_REVIEW_LINKS,
      }),
    );
    expect(mockLookupByOsmRef).toHaveBeenCalledWith("node", "12345", "osm:node/12345", undefined);
    expect(mockGetPlaceKnowledge).toHaveBeenCalledWith(MOCK_PLACE, undefined);
    expect(mockBuildReviewLinks).toHaveBeenCalledWith(
      expect.objectContaining({ id: "osm:node/12345" }),
    );
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("looks up DB station for eva: scheme", async () => {
    mockLookupDbStation.mockResolvedValue(MOCK_DB_STATION);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("eva:8011160")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(expect.objectContaining({ id: "eva:8011160", name: "Berlin Hbf" }));
    expect(mockLookupDbStation).toHaveBeenCalledWith("8011160", undefined);
  });

  it("returns 404 for eva: scheme with non-numeric EVA number", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("eva:abc")}`,
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toContain("No match for eva:abc");
  });

  it("returns 400 for opaque ID missing lat/lng/name", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places/custom-123",
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Non-resolvable place ID requires lat and lng query parameters");
  });

  it("returns 400 when name is missing for opaque ID", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("Non-resolvable place ID requires lat, lng, and name query parameters");
  });

  it("dispatches to a registered resolver for per-provider data-source schemes", async () => {
    // A data-source integration registers a resolver under its provider id
    // (e.g. "fuel") so `/places/fuel:...` routes straight to that resolver.
    const fuelResolver = vi.fn().mockResolvedValue({
      id: "fuel:shell-123",
      primaryScheme: "fuel",
      ids: { fuel: "shell-123" },
      name: "Shell",
      address: "Some Street 1, Berlin",
      coordinates: [13.37, 52.52] as [number, number],
    });
    registerPlaceResolver("fuel", fuelResolver);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("fuel:shell-123")}?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(fuelResolver).toHaveBeenCalledWith(
      "shell-123",
      expect.objectContaining({ lat: 52.52, lng: 13.37 }),
    );
    expect(mockLookupByNameAndCoords).not.toHaveBeenCalled();
    expect(mockLookupByCoords).not.toHaveBeenCalled();
  });

  it("prefers lookupByNameAndCoords for non-scheme opaque ids", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/custom-123?${qs({ lat: "52.52", lng: "13.37", name: "Some Place" })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByNameAndCoords).toHaveBeenCalledWith(
      "Some Place",
      52.52,
      13.37,
      "custom-123",
      undefined,
    );
    expect(mockLookupByCoords).not.toHaveBeenCalled();
  });

  it("falls back to lookupByCoords for non-ds prefix when name+coords returns null", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(null);
    mockLookupByCoords.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
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
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("does not set Cache-Control on 400 error", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/places/custom-123",
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
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}?lang=de`,
    });

    expect(mockLookupByOsmRef).toHaveBeenCalledWith("node", "12345", "osm:node/12345", "de");
    expect(mockGetPlaceKnowledge).toHaveBeenCalledWith(MOCK_PLACE, "de");
  });

  it("handles way/ and relation/ OSM refs", async () => {
    mockLookupByOsmRef.mockResolvedValue({ ...MOCK_PLACE, id: "osm:way/67890" });
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:way/67890")}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByOsmRef).toHaveBeenCalledWith("way", "67890", "osm:way/67890", undefined);
  });

  it("returns 500 with generic message on unexpected error", async () => {
    mockLookupByOsmRef.mockRejectedValue(new Error("Unexpected failure"));

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("Internal server error");
  });
});
