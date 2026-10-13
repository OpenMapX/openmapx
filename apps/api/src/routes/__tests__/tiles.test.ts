import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let app: FastifyInstance;

beforeAll(async () => {
  const { tilesRoute } = await import("../tiles.js");
  app = Fastify({ logger: false });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("Access-Control-Expose-Headers", "ETag, Content-Range");
  });
  await app.register(tilesRoute);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
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

describe("GET /tiles/cyclosm — empty-string env regression", () => {
  // Compose injects optional vars as "" via `${CYCLOSM_TILE_URL:-}`. A
  // nullish `??` kept that empty string, so the route built `fetch("")` →
  // ERR_INVALID_URL → 502 in production while working in dev (where the var is
  // genuinely undefined). The route must treat blank as unset.
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

describe("cycling tile content receipts", () => {
  const receipts = (value: unknown) => JSON.parse(decodeURIComponent(String(value)));
  it("pairs each primary/fallback body with its own supplier and mandatory OSM notice", async () => {
    vi.stubEnv("THUNDERFOREST_API_KEY", "fixture-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1])))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([2])));
    vi.stubGlobal("fetch", fetchMock);
    const primary = await app.inject({ method: "GET", url: "/tiles/cyclosm/3/4/2.png" });
    const fallback = await app.inject({ method: "GET", url: "/tiles/cyclosm/3/5/2.png" });
    expect(primary.rawPayload).toEqual(Buffer.from([1]));
    expect(fallback.rawPayload).toEqual(Buffer.from([2]));
    expect(receipts(primary.headers["x-openmapx-contributors"])).toEqual([
      expect.objectContaining({ sourceId: "thunderforest", name: "Maps © Thunderforest" }),
      expect.objectContaining({
        sourceId: "openstreetmap",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: {
                kind: "spdx",
                expression: "ODbL-1.0",
                url: "https://opendatacommons.org/licenses/odbl/",
              },
            },
          ],
        } as const,
      }),
    ]);
    expect(receipts(fallback.headers["x-openmapx-contributors"])).toEqual([
      expect.objectContaining({
        sourceId: "cyclosm",
        publisher: { name: "OpenStreetMap France", url: "https://openstreetmap.fr/" },
      }),
      expect.objectContaining({
        sourceId: "openstreetmap",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "data",
              subject: "Data",
              license: {
                kind: "spdx",
                expression: "ODbL-1.0",
                url: "https://opendatacommons.org/licenses/odbl/",
              },
            },
          ],
        } as const,
      }),
    ]);
    expect(primary.headers["cache-control"]).toContain("max-age=604800");
    expect(primary.headers["access-control-expose-headers"]).toContain("X-OpenMapX-Contributors");
    expect(primary.headers["access-control-expose-headers"]).toContain("ETag, Content-Range");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
