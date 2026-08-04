import { registerPlaceResolver } from "@openmapx/place-ids";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Mock nominatim lookup service

const mockLookupByOsmRef = vi.fn();
const mockLookupByCoords = vi.fn();
const mockLookupByNameAndCoords = vi.fn();
const mockLookupByOsmFilters = vi.fn();
const mockLookupAddressByCoords = vi.fn();
const mockFetchOsmBoundary = vi.fn();

vi.mock("../../../../../integrations/geocoding/place-lookup.js", () => ({
  lookupByOsmRef: mockLookupByOsmRef,
  lookupByCoords: mockLookupByCoords,
  lookupByNameAndCoords: mockLookupByNameAndCoords,
  lookupByOsmFilters: mockLookupByOsmFilters,
  lookupAddressByCoords: mockLookupAddressByCoords,
  fetchOsmBoundary: mockFetchOsmBoundary,
}));

// Mock knowledge service

const mockGetPlaceKnowledge = vi.fn();

vi.mock("../../services/knowledge/index.js", () => ({
  getPlaceKnowledge: mockGetPlaceKnowledge,
}));

// Mock photo service

const mockSearchHeroPhotos = vi.fn().mockResolvedValue([]);

vi.mock("@integrations/photos/orchestrator", () => ({
  getPhotoProviders: vi.fn().mockReturnValue([]),
  searchHeroPhotos: mockSearchHeroPhotos,
  deduplicatePhotos: vi.fn((photos: unknown[]) => photos),
}));

// Mock reviews orchestrator — `fetchAggregate` would otherwise hit the
// real Mangrove service via safeAggregate on every `/places/:id` call.
const mockFetchAggregate = vi.fn().mockResolvedValue(null);

vi.mock("@integrations/reviews/orchestrator", () => ({
  getReviewProviders: vi.fn().mockReturnValue([]),
  fetchAggregate: mockFetchAggregate,
}));

const mockIsIntegrationScheme = vi.fn().mockReturnValue(false);
const mockIsEnabledIntegrationScheme = vi.fn().mockReturnValue(false);
vi.mock("../../integration-host.js", () => ({
  getAllIntegrations: vi.fn().mockReturnValue([]),
  isIntegrationScheme: (scheme: string) => mockIsIntegrationScheme(scheme),
  isEnabledIntegrationScheme: (scheme: string) => mockIsEnabledIntegrationScheme(scheme),
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

const mockWithCache = vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn());
const mockHashKey = vi.fn((prefix: string, data: unknown) => `${prefix}:${JSON.stringify(data)}`);
vi.mock("../../utils/cache.js", () => ({
  hashKey: mockHashKey,
  withCache: mockWithCache,
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

  it("gap-fills address, email, brand, and social contacts from Overture knowledge", async () => {
    mockLookupByOsmRef.mockResolvedValue({
      ...MOCK_PLACE,
      address: "",
      provenance: [{ sourceId: "overpass", dataset: "OpenStreetMap" }],
    });
    mockGetPlaceKnowledge.mockResolvedValue({
      address: "Friedrichstraße 1, 10117 Berlin",
      city: "Berlin",
      countryCode: "de",
      email: "hello@example.test",
      socials: ["https://instagram.com/example"],
      brand: { name: "Example Brand", wikidata: "Q1" },
      provenance: [
        { sourceId: "overture", dataset: "Overture Maps", release: "2026-07-22.0" },
        { sourceId: "foursquare", dataset: "Foursquare", recordId: "fsq-1" },
      ],
    });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.address).toBe("Friedrichstraße 1, 10117 Berlin");
    expect(body.city).toBe("Berlin");
    expect(body.countryCode).toBe("de");
    expect(body.email).toBe("hello@example.test");
    expect(body.osmTags.email).toBe("hello@example.test");
    expect(body.osmTags["contact:instagram"]).toBe("https://instagram.com/example");
    expect(body.osmTags.brand).toBe("Example Brand");
    expect(body.osmTags["brand:wikidata"]).toBe("Q1");
    expect(body.provenance).toEqual([
      { sourceId: "overpass", dataset: "OpenStreetMap" },
      { sourceId: "overture", dataset: "Overture Maps", release: "2026-07-22.0" },
      { sourceId: "foursquare", dataset: "Foursquare", recordId: "fsq-1" },
    ]);
  });

  it("folds safe OSM Tripadvisor contact tags into external ids", async () => {
    mockLookupByOsmRef.mockResolvedValue({
      ...MOCK_PLACE,
      osmTags: {
        ...MOCK_PLACE.osmTags,
        "contact:tripadvisor": "Attraction_Review-g187323-d207840-Reviews.html",
      },
    });
    mockGetPlaceKnowledge.mockResolvedValue({
      externalIds: { tripadvisor: "https://tripadvisor.com.evil.example/fake" },
      photos: [],
    });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ids.tripadvisor).toBe("Attraction_Review-g187323-d207840-Reviews.html");
  });

  it("folds only safe linkable external ids from knowledge providers", async () => {
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({
      externalIds: {
        yelp: "cafe-central-vienna",
        google_maps: "not-a-cid",
        foursquare: "4b0588d7f964a52007a722e3",
        instagram: "@openmapx.project",
        facebook: "https://facebook.com.evil.example/openmapx",
      },
      photos: [],
    });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ids).toEqual(
      expect.objectContaining({
        yelp: "cafe-central-vienna",
        foursquare: "4b0588d7f964a52007a722e3",
        instagram: "@openmapx.project",
      }),
    );
    expect(body.ids.googleMaps).toBeUndefined();
    expect(body.ids.facebook).toBeUndefined();
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

  it("returns 404 for an enabled integration scheme whose resolver didn't register", async () => {
    // Mirrors the failure mode that produced the original leak: a data-
    // source integration (here scooter-sharing) is installed and enabled —
    // `isEnabledIntegrationScheme` returns true — but its `setup()` threw at
    // boot, so no resolver was registered. Without this gate the route would
    // fall through to lookupByCoords and substitute the nearest OSM POI's
    // tags onto the scooter.
    mockIsEnabledIntegrationScheme.mockImplementation((scheme) => scheme === "scooter-sharing");

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("scooter-sharing:dott-123")}?${qs({
        lat: "50.7764",
        lng: "6.0889",
        name: "Dott E-Scooter",
      })}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mockLookupByNameAndCoords).not.toHaveBeenCalled();
    expect(mockLookupByCoords).not.toHaveBeenCalled();

    mockIsEnabledIntegrationScheme.mockReturnValue(false);
  });

  it("coord-falls-back for a config-disabled integration scheme with lat/lng/name", async () => {
    // A config-disabled integration's scheme should NOT 404 — the request
    // should reach the coord-fallback so a shared link degrades gracefully.
    // `isEnabledIntegrationScheme` returns false (config-disabled); no resolver is registered.
    mockIsEnabledIntegrationScheme.mockReturnValue(false);
    mockLookupByNameAndCoords.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("overture:some-gers-id")}?${qs({
        lat: "52.52",
        lng: "13.37",
        name: "Some Place",
      })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByNameAndCoords).toHaveBeenCalled();
  });

  it("returns 404 for an enabled integration scheme with no resolver (no coords supplied)", async () => {
    // When no lat/lng are provided AND the scheme belongs to an enabled
    // integration whose resolver never registered, the route must 404.
    mockIsEnabledIntegrationScheme.mockImplementation((scheme) => scheme === "scooter-sharing");

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("scooter-sharing:dott-456")}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mockLookupByNameAndCoords).not.toHaveBeenCalled();
    expect(mockLookupByCoords).not.toHaveBeenCalled();

    mockIsEnabledIntegrationScheme.mockReturnValue(false);
  });

  it("allows coord-fallback for a non-integration freeform scheme (stylePoi)", async () => {
    // `stylePoi` is emitted by the web client when the user clicks a basemap
    // POI symbol. It corresponds to no integration manifest, so the route
    // should let the name+coord lookup run as today — that's how we get the
    // OSM POI's full enrichment when the user genuinely asked for it.
    mockLookupByNameAndCoords.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("stylePoi:abc")}?${qs({
        lat: "52.52",
        lng: "13.37",
        name: "Some POI",
      })}`,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupByNameAndCoords).toHaveBeenCalled();
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

  it("does not collide when a colon-bearing lang shifts the cache-key separator", async () => {
    mockLookupByNameAndCoords.mockResolvedValue({ ...MOCK_PLACE, id: "osm:attacker" });
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const attacker = await app.inject({
      method: "GET",
      url: "/places/osm?lang=node%2F123:en&lat=52.52&lng=13.37&name=Attacker%20Place",
    });
    const victim = await app.inject({
      method: "GET",
      url: "/places/osm%3Anode%2F123?lang=en",
    });

    expect(attacker.statusCode).toBe(200);
    expect(victim.statusCode).toBe(200);
    expect(mockWithCache.mock.calls[0]?.[0]).not.toBe(mockWithCache.mock.calls[1]?.[0]);
    expect(victim.json()).toMatchObject({ id: MOCK_PLACE.id });
    expect(mockLookupByOsmRef).toHaveBeenCalledWith("node", "123", "osm:node/123", "en");
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

  it("runs boundary, photo, and review calls in parallel within enrichPlace", async () => {
    // Place with boundary=administrative so all three downstream paths are active.
    const adminPlace = {
      ...MOCK_PLACE,
      ids: { osm: "relation/62422" },
      osmTags: { boundary: "administrative", name: "Berlin" },
    };
    mockLookupByOsmRef.mockResolvedValue(adminPlace);
    mockGetPlaceKnowledge.mockResolvedValue({
      externalIds: {},
      photos: [],
    });
    mockBuildReviewLinks.mockReturnValue([]);

    const startTimes: Record<string, number> = {};

    // Stagger resolution: boundary=30ms, photos=20ms, reviews=10ms.
    // If run sequentially the total would be ≥60ms; the start-time spread
    // tells us they actually overlap without relying on wall-clock duration.
    mockFetchOsmBoundary.mockImplementation(() => {
      startTimes.boundary = Date.now();
      return new Promise((resolve) =>
        setTimeout(() => resolve({ boundary: null, boundingBox: null }), 30),
      );
    });
    mockSearchHeroPhotos.mockImplementation(() => {
      startTimes.photos = Date.now();
      return new Promise((resolve) => setTimeout(() => resolve([]), 20));
    });
    mockFetchAggregate.mockImplementation(() => {
      startTimes.reviews = Date.now();
      return new Promise((resolve) => setTimeout(() => resolve(null), 10));
    });

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Response shape is unchanged.
    expect(body).toMatchObject({ id: "osm:node/12345", name: adminPlace.name });

    // All three mocks must have been called.
    expect(mockFetchOsmBoundary).toHaveBeenCalled();
    expect(mockSearchHeroPhotos).toHaveBeenCalled();
    expect(mockFetchAggregate).toHaveBeenCalled();

    // All three must have started before the shortest one (10ms) resolved.
    // Parallel: all starts occur before any resolution — spread is near zero.
    // Sequential: starts would be separated by at least one delay (≥10ms).
    const spread =
      Math.max(startTimes.boundary, startTimes.photos, startTimes.reviews) -
      Math.min(startTimes.boundary, startTimes.photos, startTimes.reviews);
    expect(spread).toBeLessThan(10);
  });
});

describe("socialContactTag", () => {
  it("maps known social hosts to their OSM contact tag", async () => {
    const { socialContactTag } = await import("../places.js");
    expect(socialContactTag("https://www.facebook.com/1967663743283516")).toBe("contact:facebook");
    expect(socialContactTag("https://instagram.com/openmapx")).toBe("contact:instagram");
    expect(socialContactTag("https://x.com/openmapx")).toBe("contact:twitter");
    expect(socialContactTag("https://www.linkedin.com/company/x")).toBe("contact:linkedin");
  });

  it("returns null for unsupported or unparseable hosts", async () => {
    const { socialContactTag } = await import("../places.js");
    expect(socialContactTag("https://example.com/x")).toBeNull();
    expect(socialContactTag("not a url")).toBeNull();
  });
});

describe("pickMoreSpecificWebsite", () => {
  it("prefers the deeper-path URL (specific outlet over brand homepage)", async () => {
    const { pickMoreSpecificWebsite } = await import("../places.js");
    expect(
      pickMoreSpecificWebsite(
        "http://www.shell.de/",
        "https://find.shell.com/de/fuel/10024555-neuss-bergheimer-str-415",
      ),
    ).toBe("https://find.shell.com/de/fuel/10024555-neuss-bergheimer-str-415");
  });

  it("keeps the present one when only one is set, and OSM on ties", async () => {
    const { pickMoreSpecificWebsite } = await import("../places.js");
    expect(pickMoreSpecificWebsite("https://a.de/", undefined)).toBe("https://a.de/");
    expect(pickMoreSpecificWebsite(undefined, "https://b.de/x")).toBe("https://b.de/x");
    expect(pickMoreSpecificWebsite("https://a.de/menu", "https://b.de/info")).toBe(
      "https://a.de/menu",
    );
  });

  it("never lets an aggregator host displace an OSM-curated URL", async () => {
    const { pickMoreSpecificWebsite } = await import("../places.js");
    expect(
      pickMoreSpecificWebsite("https://restaurant-mueller.de/", "https://www.lieferando.de/x/y/z"),
    ).toBe("https://restaurant-mueller.de/");
  });
});
