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
  TTL: { places: { detail: 86400 }, photos: 3600 },
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
  vi.useRealTimers();
  vi.clearAllMocks();
  mockFetchAggregate.mockReset().mockResolvedValue(null);
  mockSearchHeroPhotos.mockReset().mockResolvedValue([]);
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

describe("POST /places/card-enrichment", () => {
  const place = {
    id: "osm:way/20470246",
    name: "Aachener Dom",
    coordinates: [6.0839593, 50.7747522],
    photoTags: { wikimedia_commons: "File:Around_Aachener_Dom.JPG" },
  };

  it("validates a nonempty unique field subset and only runs requested fields", async () => {
    for (const fields of [[], ["photo", "photo"], ["other"], "photo"]) {
      const invalid = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: { places: [{ ...place, fields }] },
      });
      expect(invalid.statusCode).toBe(400);
    }
    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [{ ...place, fields: ["rating"] }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [{ id: place.id, outcomes: { rating: { status: "absent" } } }],
    });
    expect(mockSearchHeroPhotos).not.toHaveBeenCalled();
  });

  it("reports a transient photo failure without hiding a successful rating or caching absence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockSearchHeroPhotos.mockRejectedValueOnce(new Error("network unavailable"));
    mockFetchAggregate.mockResolvedValue({ stars: 4, count: 5, ratedCount: 5, source: "mangrove" });
    const request = {
      method: "POST" as const,
      url: "/places/card-enrichment",
      payload: { places: [place] },
    };
    const first = await app.inject(request);
    expect(first.json().results[0]).toEqual({
      id: place.id,
      rating: { stars: 4, count: 5, source: "mangrove" },
      outcomes: {
        photo: { status: "failed", retryAfterMs: expect.any(Number) },
        rating: { status: "available" },
      },
    });
    mockSearchHeroPhotos.mockResolvedValueOnce([
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Recovered.jpg",
        source: "wikimedia",
      },
    ]);
    const second = await app.inject(request);
    expect(second.json().results[0].outcomes.photo.status).toBe("failed");
    expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 2100);
    const third = await app.inject(request);
    expect(third.json().results[0].outcomes.photo).toEqual({ status: "available" });
  });

  it("honors provider Retry-After when a strict photo provider fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    mockSearchHeroPhotos.mockImplementationOnce(async (_tags, _providers, options) => {
      options.onError(Object.assign(new Error("busy"), { status: 429, retryAfterMs: 12000 }));
      return [];
    });
    const request = {
      method: "POST" as const,
      url: "/places/card-enrichment",
      payload: { places: [{ ...place, id: "osm:node/999900", fields: ["photo"] }] },
    };
    const response = await app.inject(request);
    expect(response.json().results[0].outcomes.photo).toEqual({
      status: "failed",
      retryAfterMs: 12000,
    });
    vi.setSystemTime(Date.now() + 9000);
    const early = await app.inject(request);
    expect(early.json().results[0].outcomes.photo).toEqual({
      status: "failed",
      retryAfterMs: 3000,
    });
    expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 3001);
    await app.inject(request);
    expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(2);
  });

  it("keeps a transient failure retryable when another photo source returns a permanent error", async () => {
    mockSearchHeroPhotos.mockImplementationOnce(async (_tags, _providers, options) => {
      options.onError(Object.assign(new Error("missing"), { status: 404 }));
      options.onError(Object.assign(new Error("upstream unavailable"), { status: 503 }));
      return [];
    });
    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [{ ...place, id: "osm:node/999901", fields: ["photo"] }] },
    });
    expect(response.json().results[0].outcomes.photo).toMatchObject({
      status: "failed",
      retryAfterMs: expect.any(Number),
    });
  });

  it("aborts timed-out rating work and does not launch overlapping legacy work", async () => {
    let aborted = false;
    mockFetchAggregate.mockImplementation(
      (_subject, _providers, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    );
    const payload = { places: [{ ...place, name: "Deadline fixture", fields: ["rating"] }] };
    const first = await app.inject({ method: "POST", url: "/places/card-enrichment", payload });
    expect(first.json().results[0].outcomes.rating).toMatchObject({
      status: "failed",
      retryAfterMs: expect.any(Number),
    });
    expect(aborted).toBe(true);
    expect(mockFetchAggregate).toHaveBeenCalledTimes(1);
  });

  it("returns a tagged photo with its credit and a qualifying provider-sourced rating", async () => {
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Around_Aachener_Dom.JPG",
      thumbnailUrl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Around_Aachener_Dom.JPG/800px.jpg",
      source: "wikimedia",
      author: "Draupnir3",
      license: "CC BY-SA 3.0",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Around_Aachener_Dom.JPG",
    };
    mockSearchHeroPhotos.mockResolvedValueOnce([photo]);
    mockFetchAggregate.mockResolvedValueOnce({
      stars: 4.25,
      count: 14,
      ratedCount: 12,
      source: "mangrove",
    });

    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [place] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        {
          id: place.id,
          photo,
          rating: { stars: 4.25, count: 12, source: "mangrove" },
          outcomes: { photo: { status: "available" }, rating: { status: "available" } },
        },
      ],
    });
  });

  it("never offers a camera still as a place photo while camera hosts are declared", async () => {
    const { setCameraMediaSources } = await import("../image-hosts.js");
    setCameraMediaSources([
      { sourceId: "fi-digitraffic-cameras", mediaHosts: ["weathercam.digitraffic.fi"] },
    ]);
    try {
      mockSearchHeroPhotos.mockResolvedValueOnce([
        {
          url: "https://weathercam.digitraffic.fi/C0150301.jpg",
          source: "wikimedia",
          author: "Fintraffic",
          license: "CC BY 4.0",
        },
      ]);

      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: { places: [{ ...place, id: "osm:node/999902", fields: ["photo"] }] },
      });

      expect(response.statusCode).toBe(200);
      const [result] = response.json().results;
      expect(result.photo).toBeUndefined();
      expect(result.outcomes.photo).toEqual({ status: "absent" });
    } finally {
      setCameraMediaSources([]);
    }
  });

  it("keeps a hero photo and rating when knowledge lookup fails", async () => {
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Dom.jpg",
      source: "wikimedia",
      author: "Aachen photographer",
    };
    mockSearchHeroPhotos.mockResolvedValueOnce([photo]);
    mockGetPlaceKnowledge.mockRejectedValueOnce(new Error("knowledge unavailable"));
    mockFetchAggregate.mockResolvedValueOnce({
      stars: 4,
      count: 6,
      ratedCount: 4,
      source: "mangrove",
    });

    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [{ ...place, photoTags: { ...place.photoTags, wikidata: "Q123" } }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0]).toEqual({
      id: place.id,
      photo,
      rating: { stars: 4, count: 4, source: "mangrove" },
      outcomes: { photo: { status: "available" }, rating: { status: "available" } },
    });
  });

  it("uses a place-level Wikidata knowledge photo when no hero tag returns one", async () => {
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Dom-P18.jpg",
      source: "wikidata",
      author: "Commons contributor",
      license: "CC BY-SA 4.0",
      pageUrl: "https://commons.wikimedia.org/wiki/File:Dom-P18.jpg",
    };
    mockSearchHeroPhotos.mockResolvedValueOnce([]);
    mockGetPlaceKnowledge.mockResolvedValueOnce({ photos: [photo] });
    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [{ ...place, photoTags: { wikidata: "Q5908" } }] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        {
          id: place.id,
          photo,
          outcomes: { photo: { status: "available" }, rating: { status: "absent" } },
        },
      ],
    });
  });

  it.each([
    { places: Array.from({ length: 9 }, (_, index) => ({ ...place, id: `osm:node/${index}` })) },
    { places: [place, place] },
    { places: [{ ...place, coordinates: [181, 50] }] },
    { places: [{ ...place, photoTags: { image: "javascript:alert(1)" } }] },
    { places: [{ ...place, photoTags: { image: "File:" } }] },
    { places: [{ ...place, photoTags: { ...place.photoTags, "image:2": "File:Other.jpg" } }] },
    { places: [{ ...place, photoTags: { wikipedia: "localhost/:Article" } }] },
    { places: [{ ...place, photoTags: { wikipedia: "de:" } }] },
    { places: [{ ...place, photoTags: { wikipedia: "Article" } }], lang: "localhost/" },
  ])("rejects oversized or invalid input before provider work: %j", async (payload) => {
    const response = await app.inject({ method: "POST", url: "/places/card-enrichment", payload });
    expect(response.statusCode).toBe(400);
    expect(mockSearchHeroPhotos).not.toHaveBeenCalled();
    expect(mockGetPlaceKnowledge).not.toHaveBeenCalled();
    expect(mockFetchAggregate).not.toHaveBeenCalled();
  });

  it("requires at least three rated reviews and a known rated sample size", async () => {
    mockFetchAggregate
      .mockResolvedValueOnce({ stars: 4, count: 3, ratedCount: 1, source: "mangrove" })
      .mockResolvedValueOnce({ stars: 4, count: 6, source: "other-provider" })
      .mockResolvedValueOnce({ stars: 4, count: 5, ratedCount: 3, source: "mangrove" });
    const requests = ["One", "Unknown", "Three"].map((name, index) =>
      app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: { places: [{ ...place, id: `osm:node/${index + 1}`, name, photoTags: {} }] },
      }),
    );
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.json().results[0])).toEqual([
      { id: "osm:node/1", outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
      { id: "osm:node/2", outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
      {
        id: "osm:node/3",
        rating: { stars: 4, count: 3, source: "mangrove" },
        outcomes: { photo: { status: "absent" }, rating: { status: "available" } },
      },
    ]);
  });

  it("omits unsupported images and unqualified ratings without placeholder fields", async () => {
    mockSearchHeroPhotos.mockResolvedValueOnce([
      { url: "https://evil.example/unsafe.jpg", source: "osm" },
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/De-Aachen.ogg",
        source: "wikimedia",
        pageUrl: "https://commons.wikimedia.org/wiki/File:De-Aachen.ogg",
      },
    ]);
    mockFetchAggregate.mockResolvedValueOnce({ stars: 4.5, count: 2, source: "mangrove" });

    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [place] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      results: [
        { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
      ],
    });
  });

  it("isolates cached photo results by every tag used for the lookup", async () => {
    const cache = new Map<string, Promise<unknown>>();
    mockWithCache.mockImplementation((key: string, _ttl: number, fn: () => unknown) => {
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(fn));
      return cache.get(key);
    });
    mockSearchHeroPhotos.mockImplementation(async (tags: Record<string, string>) => [
      {
        url:
          tags.image === "File:First.jpg"
            ? "https://upload.wikimedia.org/wikipedia/commons/a/aa/First.jpg"
            : "https://upload.wikimedia.org/wikipedia/commons/b/bb/Second.jpg",
        source: "osm",
      },
    ]);
    try {
      const first = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: { places: [{ ...place, photoTags: { image: "File:First.jpg" } }] },
      });
      const second = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: { places: [{ ...place, photoTags: { image: "File:Second.jpg" } }] },
      });
      expect(first.json().results[0].photo.url).toContain("First.jpg");
      expect(second.json().results[0].photo.url).toContain("Second.jpg");
      expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(2);
    } finally {
      mockWithCache.mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn());
    }
  });

  it("shares in-flight results for identical places and uses source-specific cache lifetimes", async () => {
    const cache = new Map<string, Promise<unknown>>();
    mockWithCache.mockImplementation((key: string, _ttl: number, fn: () => unknown) => {
      if (!cache.has(key)) cache.set(key, Promise.resolve().then(fn));
      return cache.get(key);
    });
    mockSearchHeroPhotos.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [];
    });
    try {
      const request = {
        method: "POST" as const,
        url: "/places/card-enrichment",
        payload: { places: [place] },
      };
      const [first, second] = await Promise.all([app.inject(request), app.inject(request)]);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(1);
      expect(mockFetchAggregate).toHaveBeenCalledTimes(1);
      expect(mockWithCache.mock.calls).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([expect.stringMatching(/^cache:card-photo:/), 3600]),
          expect.arrayContaining([expect.stringMatching(/^cache:card-rating:/), 600]),
        ]),
      );
    } finally {
      mockWithCache.mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn());
    }
  });

  it("caches empty photo and rating summaries across repeat requests", async () => {
    const cache = new Map<string, unknown>();
    mockWithCache.mockImplementation(async (key: string, _ttl: number, fn: () => unknown) => {
      const cached = cache.get(key);
      if (cached !== undefined && cached !== null) return cached;
      const value = await fn();
      cache.set(key, value);
      return value;
    });
    mockSearchHeroPhotos.mockResolvedValue([]);
    mockFetchAggregate.mockResolvedValue({ stars: 0, count: 0 });
    try {
      const request = {
        method: "POST" as const,
        url: "/places/card-enrichment",
        payload: { places: [place] },
      };
      const first = await app.inject(request);
      const second = await app.inject(request);
      expect(first.json()).toEqual({
        results: [
          { id: place.id, outcomes: { photo: { status: "absent" }, rating: { status: "absent" } } },
        ],
      });
      expect(second.json()).toEqual(first.json());
      expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(1);
      expect(mockFetchAggregate).toHaveBeenCalledTimes(1);
    } finally {
      mockWithCache.mockImplementation((_key: string, _ttl: number, fn: () => unknown) => fn());
    }
  });

  it("skips an invalid thumbnail and retains the next usable tagged photo", async () => {
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/b/bb/Good.jpg",
      source: "wikimedia",
      author: "Author",
    };
    mockSearchHeroPhotos.mockResolvedValueOnce([
      {
        url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Bad.jpg",
        thumbnailUrl: "https://evil.example/Bad.jpg",
        source: "wikimedia",
      },
      photo,
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/places/card-enrichment",
      payload: { places: [place] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().results[0].photo).toEqual(photo);
  });

  it("caps photo work at four jobs across simultaneous batches", async () => {
    let active = 0;
    let maximum = 0;
    mockSearchHeroPhotos.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return [];
    });
    const makeBatch = (start: number) => ({
      places: Array.from({ length: 8 }, (_, index) => ({
        ...place,
        id: `osm:node/${start + index}`,
      })),
    });
    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: "/places/card-enrichment", payload: makeBatch(100) }),
      app.inject({ method: "POST", url: "/places/card-enrichment", payload: makeBatch(200) }),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(maximum).toBeLessThanOrEqual(4);
    expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(16);
  });

  it("caps unfinished legacy rating work after deadlines", async () => {
    const pending: Array<() => void> = [];
    mockFetchAggregate.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve(null));
        }),
    );
    const payload = {
      places: Array.from({ length: 5 }, (_, index) => ({
        ...place,
        id: `osm:node/${880000 + index}`,
        name: `Unfinished ${index}`,
        fields: ["rating"],
      })),
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .results.every(
            (result: { outcomes: { rating: { status: string } } }) =>
              result.outcomes.rating.status === "failed",
          ),
      ).toBe(true);
      expect(mockFetchAggregate).toHaveBeenCalledTimes(4);
    } finally {
      for (const resolve of pending) resolve();
    }
  });

  it("retains a completed knowledge photo when a legacy hero provider misses the deadline", async () => {
    let finishHero!: (photos: unknown[]) => void;
    mockSearchHeroPhotos.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishHero = resolve;
        }),
    );
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Knowledge.jpg",
      source: "wikidata",
    };
    mockGetPlaceKnowledge.mockResolvedValue({ photos: [photo] });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: {
          places: [
            { ...place, id: "osm:node/880100", photoTags: { wikidata: "Q42" }, fields: ["photo"] },
          ],
        },
      });
      expect(response.json().results[0]).toMatchObject({
        photo,
        outcomes: { photo: { status: "available" } },
      });
    } finally {
      finishHero?.([]);
    }
  });

  it("retains an incremental hero photo while a sibling share preview hangs", async () => {
    let finishHero!: (photos: unknown[]) => void;
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Provider.jpg",
      source: "wikimedia",
    };
    mockSearchHeroPhotos.mockImplementation((_tags, _providers, options) => {
      options.onPhotos([photo]);
      return new Promise((resolve) => {
        finishHero = resolve;
      });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: { places: [{ ...place, id: "osm:node/880101", fields: ["photo"] }] },
      });
      expect(response.json().results[0]).toMatchObject({
        photo,
        outcomes: { photo: { status: "available" } },
      });
    } finally {
      finishHero?.([]);
    }
  });

  it("retains a completed knowledge source photo when another source stalls", async () => {
    let finishKnowledge!: (value: unknown) => void;
    const photo = {
      url: "https://upload.wikimedia.org/wikipedia/commons/a/aa/Knowledge-progress.jpg",
      source: "wikidata",
    };
    mockGetPlaceKnowledge.mockImplementation((_place, _lang, options) => {
      options.onPhotos([photo]);
      return new Promise((resolve) => {
        finishKnowledge = resolve;
      });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: {
          places: [
            { ...place, id: "osm:node/880102", photoTags: { wikidata: "Q42" }, fields: ["photo"] },
          ],
        },
      });
      expect(response.json().results[0]).toMatchObject({
        photo,
        outcomes: { photo: { status: "available" } },
      });
    } finally {
      finishKnowledge?.({ photos: [] });
    }
  });

  it("preserves a known Retry-After when a sibling photo source misses the deadline", async () => {
    let finishKnowledge!: (value: unknown) => void;
    mockGetPlaceKnowledge.mockImplementation((_place, _lang, options) => {
      options.onError(Object.assign(new Error("busy"), { status: 429, retryAfterMs: 60000 }));
      return new Promise((resolve) => {
        finishKnowledge = resolve;
      });
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload: {
          places: [
            { ...place, id: "osm:node/880103", photoTags: { wikidata: "Q42" }, fields: ["photo"] },
          ],
        },
      });
      expect(response.json().results[0].outcomes.photo).toEqual({
        status: "failed",
        retryAfterMs: 60000,
      });
    } finally {
      finishKnowledge?.({ photos: [] });
    }
  });

  it("caps unfinished legacy photo work after deadlines", async () => {
    const pending: Array<() => void> = [];
    mockSearchHeroPhotos.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve([]));
        }),
    );
    const payload = {
      places: Array.from({ length: 5 }, (_, index) => ({
        ...place,
        id: `osm:node/${881000 + index}`,
        fields: ["photo"],
      })),
    };
    try {
      const response = await app.inject({
        method: "POST",
        url: "/places/card-enrichment",
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(
        response
          .json()
          .results.every(
            (result: { outcomes: { photo: { status: string } } }) =>
              result.outcomes.photo.status === "failed",
          ),
      ).toBe(true);
      expect(mockSearchHeroPhotos).toHaveBeenCalledTimes(4);
    } finally {
      for (const resolve of pending) resolve();
    }
  });
});

function qs(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Tests

describe("GET /places/:id", () => {
  it("recomputes a reused cached schedule and keeps only its field check date", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cached = {
      ...MOCK_PLACE,
      openingHours: "Mo-Su 10:00-18:00",
      openingHoursInfo: { status: { isOpen: true }, isAlwaysOpen: false, weekBitmap: "" },
      osmTags: {
        ...MOCK_PLACE.osmTags,
        "source:opening_hours": "survey",
        "check_date:opening_hours": "2026-09-01",
      },
      provenance: [{ sourceId: "overture", dataset: "Overture", updatedAt: "2026-09-25" }],
    };
    mockWithCache.mockResolvedValueOnce(cached).mockResolvedValueOnce(cached);
    const url = `/places/${encodeURIComponent("osm:node/12345")}`;
    vi.setSystemTime(new Date("2026-09-26T15:59:00Z")); // Berlin 17:59
    const before = await app.inject({ method: "GET", url });
    expect(before.json().openingHoursInfo.status.isOpen).toBe(true);
    vi.setSystemTime(new Date("2026-09-26T16:01:00Z")); // Berlin 18:01
    const after = await app.inject({ method: "GET", url });
    expect(after.json().openingHoursInfo.status.isOpen).toBe(false);
    expect(after.json().openingHoursSource).toEqual({ name: "survey", checkedAt: "2026-09-01" });
    expect(cached.openingHoursInfo.status.isOpen).toBe(true);
    expect(after.headers["cache-control"]).toBe("no-store");
  });
  it("removes a cached Commons audio icon while retaining real photo credits", async () => {
    const realPhoto = {
      url: "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/be/Aachen.jpg/800px-Aachen.jpg",
      source: "wikimedia",
      author: "CEphoto, Uwe Aranas",
      license: "CC BY-SA 3.0",
    };
    mockWithCache.mockResolvedValueOnce({
      ...MOCK_PLACE,
      photos: [
        {
          url: "https://commons.wikimedia.org/w/resources/assets/file-type-icons/fileicon-ogg.png",
          source: "wikimedia",
          pageUrl: "https://commons.wikimedia.org/wiki/File:De-Aachen.ogg",
        },
        realPhoto,
      ],
    });

    const res = await app.inject({ method: "GET", url: "/places/osm%3Anode%2F12345" });

    expect(res.statusCode).toBe(200);
    expect(res.json().photos).toEqual([realPhoto]);
  });
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
    expect(res.headers["cache-control"]).toBe("no-store");
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

  it("hands a resolver an id with a literal % exactly as the client sent it", async () => {
    const fuelResolver = vi.fn().mockResolvedValue({
      id: "fuel:50%off a%20b",
      primaryScheme: "fuel",
      ids: { fuel: "50%off a%20b" },
      name: "Shell",
      address: "Some Street 1, Berlin",
      coordinates: [13.37, 52.52] as [number, number],
    });
    registerPlaceResolver("fuel", fuelResolver);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("fuel:50%off a%20b")}?${qs({ lat: "52.52", lng: "13.37" })}`,
    });

    expect(res.statusCode, res.body).toBe(200);
    expect(fuelResolver).toHaveBeenCalledWith(
      "50%off a%20b",
      expect.objectContaining({ lat: 52.52, lng: 13.37 }),
    );
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
    const warn = vi.spyOn(app.log, "warn");

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("scooter-sharing:fixture-private-share-id")}?${qs({
        lat: "50.7764",
        lng: "6.0889",
        name: "Dott E-Scooter",
      })}`,
    });

    expect(res.statusCode).toBe(404);
    expect(mockLookupByNameAndCoords).not.toHaveBeenCalled();
    expect(mockLookupByCoords).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { scheme: "scooter-sharing" },
      "places: integration scheme has no resolver; refusing coord-fallback",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("fixture-private-share-id");

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

  it("prevents HTTP reuse of a calculated hours verdict", async () => {
    mockLookupByOsmRef.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    const res = await app.inject({
      method: "GET",
      url: `/places/${encodeURIComponent("osm:node/12345")}`,
    });

    expect(res.headers["cache-control"]).toBe("no-store");
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

  it("uses different cache keys for the same opaque id at different coordinates", async () => {
    mockLookupByNameAndCoords.mockResolvedValue(MOCK_PLACE);
    mockGetPlaceKnowledge.mockResolvedValue({ externalIds: {} });
    mockBuildReviewLinks.mockReturnValue([]);

    await app.inject({
      method: "GET",
      url: `/places/custom-1?${qs({ lat: "52.5", lng: "13.4", name: "Moving Place" })}`,
    });
    await app.inject({
      method: "GET",
      url: `/places/custom-1?${qs({ lat: "52.6", lng: "13.5", name: "Moving Place" })}`,
    });

    expect(mockWithCache.mock.calls[0]?.[0]).not.toBe(mockWithCache.mock.calls[1]?.[0]);
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

  it("starts boundary, photos, and reviews while place knowledge is still pending", async () => {
    const adminPlace = {
      ...MOCK_PLACE,
      ids: { osm: "relation/62422" },
      osmTags: { boundary: "administrative", name: "Berlin" },
    };
    const heroPhoto = { url: "https://example.org/hero.jpg", source: "osm" };
    const knowledgePhoto = { url: "https://example.org/knowledge.jpg", source: "wikidata" };
    mockLookupByOsmRef.mockResolvedValue(adminPlace);
    let releaseKnowledge!: (value: unknown) => void;
    mockGetPlaceKnowledge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseKnowledge = resolve;
        }),
    );
    mockFetchOsmBoundary.mockResolvedValue({ boundary: null, boundingBox: null });
    mockSearchHeroPhotos.mockResolvedValue([heroPhoto]);
    mockFetchAggregate.mockResolvedValue({ stars: 4.5, count: 10, ratingCount: 10 });
    mockBuildReviewLinks.mockReturnValue([]);
    const request = app
      .inject({
        method: "GET",
        url: `/places/${encodeURIComponent("osm:node/12345")}`,
      })
      .then((response) => response);

    try {
      await vi.waitFor(() => expect(mockGetPlaceKnowledge).toHaveBeenCalledTimes(1));
      expect(mockFetchOsmBoundary).toHaveBeenCalledWith("relation/62422", undefined);
      expect(mockSearchHeroPhotos).toHaveBeenCalledWith(adminPlace.osmTags, []);
      expect(mockFetchAggregate).toHaveBeenCalled();
    } finally {
      releaseKnowledge({
        externalIds: { gers: "test-gers" },
        description: "Knowledge description",
        photos: [knowledgePhoto],
      });
      await request;
    }
    const response = await request;
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: adminPlace.name,
      ids: { osm: "relation/62422", gers: "test-gers" },
      description: "Knowledge description",
      photos: [heroPhoto, knowledgePhoto],
    });
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
