import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let app: FastifyInstance;

beforeAll(async () => {
  const { maptilerRoute } = await import("../maptiler.js");
  app = Fastify({ logger: false });
  await app.register(maptilerRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /maptiler/*", () => {
  it("rewrites MapTiler style asset URLs to the API proxy", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    // The proxy base is taken from configuration (PUBLIC_BASE_URL / DOMAIN),
    // not from request headers — see `publicBaseUrl()` in maptiler.ts.
    vi.stubEnv("PUBLIC_BASE_URL", "https://api.example.test");
    const fetchMock = vi.fn(async () =>
      Response.json({
        version: 8,
        glyphs: "https://api.maptiler.com/fonts/Open Sans Regular/{range}.pbf?key=upstream-key",
        sprite: "https://api.maptiler.com/maps/bright-v2/sprite?key=upstream-key",
        sources: {
          openmaptiles: {
            type: "vector",
            url: "https://api.maptiler.com/tiles/v3/tiles.json?key=upstream-key",
          },
        },
        layers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
      headers: {
        host: "api.example.test",
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.maptiler.com/maps/bright-v2/style.json?key=test-key"),
      expect.any(Object),
    );
    expect(res.json()).toMatchObject({
      glyphs: "https://api.example.test/api/maptiler/fonts/Open%20Sans%20Regular/{range}.pbf",
      sprite: "https://api.example.test/api/maptiler/maps/bright-v2/sprite",
      sources: {
        openmaptiles: {
          url: "https://api.example.test/api/maptiler/tiles/v3/tiles.json",
        },
      },
    });
  });

  it("proxies binary tile assets without exposing the key to the client URL", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "image/jpeg" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/tiles/satellite-v2/4/8/5.jpg",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/jpeg");
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("https://api.maptiler.com/tiles/satellite-v2/4/8/5.jpg?key=test-key"),
      expect.any(Object),
    );
  });

  it("rejects unsupported paths", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn());

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/geocoding/berlin.json",
    });

    expect(res.statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 503 when no MapTiler key is configured", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
    });

    expect(res.statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores X-Forwarded-Host when rewriting style URLs (cache-poisoning guard)", async () => {
    vi.stubEnv("MAPTILER_KEY", "test-key");
    vi.stubEnv("PUBLIC_BASE_URL", "https://api.example.test");
    const fetchMock = vi.fn(async () =>
      Response.json({
        version: 8,
        glyphs: "https://api.maptiler.com/fonts/Open Sans Regular/{range}.pbf?key=upstream-key",
        sprite: "https://api.maptiler.com/maps/bright-v2/sprite?key=upstream-key",
        sources: {},
        layers: [],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({
      method: "GET",
      url: "/maptiler/maps/bright-v2/style.json",
      headers: {
        host: "api.example.test",
        // Attacker tries to make the rewritten URLs point at their domain.
        "x-forwarded-host": "evil.attacker.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { glyphs: string; sprite: string };
    expect(body.glyphs).toContain("https://api.example.test/");
    expect(body.sprite).toContain("https://api.example.test/");
    expect(body.glyphs).not.toContain("attacker");
    expect(body.sprite).not.toContain("attacker");
  });
});
