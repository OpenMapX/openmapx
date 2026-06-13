import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let app: FastifyInstance;

beforeAll(async () => {
  const { tilesRoute } = await import("../tiles.js");
  app = Fastify({ logger: false });
  await app.register(tilesRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function pngResponseMock() {
  return vi.fn(
    async (..._args: unknown[]) =>
      new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
  );
}

describe("GET /tiles/terrain — empty-string env regression", () => {
  // Compose injects optional vars as "" via `${OPENTOPOMAP_TILE_URL:-}`. A
  // nullish `??` kept that empty string, so the route built `fetch("")` →
  // ERR_INVALID_URL → 502 in production while working in dev (where the var is
  // genuinely undefined). The route must treat blank as unset.
  it("falls back to the default OpenTopoMap URL when OPENTOPOMAP_TILE_URL is empty", async () => {
    vi.stubEnv("OPENTOPOMAP_TILE_URL", "");
    const fetchMock = pngResponseMock();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/tiles/terrain/3/4/2.png" });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tile.opentopomap.org/3/4/2.png",
      expect.any(Object),
    );
  });

  it("honours a configured OPENTOPOMAP_TILE_URL override", async () => {
    vi.stubEnv("OPENTOPOMAP_TILE_URL", "https://topo.example.test/{z}/{x}/{y}.png");
    const fetchMock = pngResponseMock();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/tiles/terrain/5/1/2.png" });

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://topo.example.test/5/1/2.png",
      expect.any(Object),
    );
  });
});

describe("GET /tiles/cyclosm — empty-string env regression", () => {
  it("falls back to the default CyclOSM URL when CYCLOSM_TILE_URL is empty", async () => {
    vi.stubEnv("THUNDERFOREST_API_KEY", undefined);
    vi.stubEnv("CYCLOSM_TILE_URL", "");
    const fetchMock = pngResponseMock();
    vi.stubGlobal("fetch", fetchMock);

    const res = await app.inject({ method: "GET", url: "/tiles/cyclosm/3/4/2.png" });

    expect(res.statusCode).toBe(200);
    // Subdomain rotates across {a,b,c}; assert the non-template part resolved.
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toMatch(
      /^https:\/\/[abc]\.tile-cyclosm\.openstreetmap\.fr\/cyclosm\/3\/4\/2\.png$/,
    );
  });
});
