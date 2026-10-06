import { afterEach, describe, expect, it, vi } from "vitest";
import { loadClientEnv } from "./serverClientEnv";

const originalEnv = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});
describe("server map bootstrap", () => {
  it("reads effective public configuration through the internal API without forwarding browser credentials", async () => {
    process.env.INTERNAL_API_URL = "http://app-api:3001/";
    process.env.NEXT_PUBLIC_TILES_URL = "";
    const fetcher = vi.fn(async () =>
      Response.json({
        hostedBasemapProvider: "auto",
        maptilerConfigured: true,
        selfHostedTilesUrl: "",
        selfHostedGlyphsUrl: "",
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    const env = await loadClientEnv();
    expect(env.basemapProvider).toBe("maptiler");
    expect(fetcher).toHaveBeenCalledWith(
      "http://app-api:3001/api/map-config",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(fetcher.mock.calls[0]?.[1]).not.toHaveProperty("headers");
  });
  it.each(["unavailable", "malformed"])(
    "keeps explicit local configuration when bootstrap is %s",
    async (kind) => {
      process.env.NEXT_PUBLIC_TILES_URL = "/tiles/data/custom.json";
      vi.stubGlobal("fetch", async () =>
        kind === "unavailable"
          ? new Response(null, { status: 503 })
          : Response.json({ maptilerApiKey: "secret" }),
      );
      expect((await loadClientEnv()).basemapProvider).toBe("selfhosted");
    },
  );
  it("keeps unknown self-hosted availability local if the API cannot be reached", async () => {
    process.env.NEXT_PUBLIC_TILES_URL = "";
    process.env.MAPTILER_KEY = "";
    process.env.BASEMAP_PROVIDER = "";
    vi.stubGlobal("fetch", async () => {
      throw new Error("timeout");
    });
    const env = await loadClientEnv();
    expect(env.basemapProvider).toBe("selfhosted");
    expect(env.tilesUrl).toContain("/tiles/data/openmapx.json");
  });
});
