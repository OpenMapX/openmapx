import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let app: FastifyInstance;

beforeAll(async () => {
  const { mapterhornRoute } = await import("../mapterhorn.js");
  app = Fastify({ logger: false });
  await app.register(mapterhornRoute);
  await app.ready();
});
afterAll(async () => app.close());
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Mapterhorn DEM proxy", () => {
  it("serves local TileJSON with proxied tile URLs and attribution", async () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://api.example.test");
    const res = await app.inject({ method: "GET", url: "/mapterhorn/tiles.json" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      encoding: "terrarium",
      tileSize: 512,
      tiles: ["https://api.example.test/api/mapterhorn/{z}/{x}/{y}.webp"],
    });
    expect(JSON.stringify(res.json())).toContain("mapterhorn.com/attribution");
  });

  it("fetches only fixed Mapterhorn tile coordinates and returns WebP", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
          headers: { "content-type": "image/webp" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = await app.inject({ method: "GET", url: "/mapterhorn/2/1/1.webp" });
    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://tiles.mapterhorn.com/2/1/1.webp");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { "User-Agent": expect.any(String) },
    });
    expect(res.headers["content-type"]).toContain("image/webp");
  });

  it("rejects oversized or mislabeled upstream tiles", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/webp", "content-length": "2097153" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect((await app.inject({ method: "GET", url: "/mapterhorn/2/1/1.webp" })).statusCode).toBe(
      502,
    );

    fetchMock.mockResolvedValueOnce(
      new Response("not a tile", { headers: { "content-type": "text/html" } }),
    );
    expect((await app.inject({ method: "GET", url: "/mapterhorn/2/1/1.webp" })).statusCode).toBe(
      502,
    );

    fetchMock.mockResolvedValueOnce(
      new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
        headers: { "content-type": "image/webp", "content-length": "1" },
      }),
    );
    expect((await app.inject({ method: "GET", url: "/mapterhorn/2/1/1.webp" })).statusCode).toBe(
      502,
    );
  });

  it.each(["/mapterhorn/18/1/1.webp", "/mapterhorn/2/4/1.webp", "/mapterhorn/2/1/1.png"])(
    "rejects invalid path %s before fetching",
    async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});
