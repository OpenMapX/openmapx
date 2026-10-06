import type { MapConfig } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildClientEnv } from "@/integration-api/runtime/env";
import { baseMapVectorCredits, loadOpenMapXStyle } from "./map";

const config: MapConfig = {
  hostedBasemapProvider: "openfreemap" as const,
  maptilerConfigured: true,
  selfHostedTilesUrl: "",
  selfHostedGlyphsUrl: "",
};
const originalEnv = { ...process.env };
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...originalEnv };
});

describe("hosted vector assets", () => {
  it.each(["light", "dark"] as const)(
    "loads the owned %s style with keyless OpenFreeMap tiles and glyphs",
    async (variant) => {
      process.env.NEXT_PUBLIC_TILES_URL = "";
      process.env.NEXT_PUBLIC_MAP_STYLE_URL = "";
      vi.stubGlobal("fetch", async () =>
        Response.json({ version: 8, sources: { openmaptiles: { type: "vector" } }, layers: [] }),
      );
      const env = buildClientEnv(config);
      const style = await loadOpenMapXStyle(env, variant);
      expect(style.sources).toEqual({
        openmaptiles: {
          type: "vector",
          url: "https://tiles.openfreemap.org/planet",
          attribution: "",
        },
      });
      expect(style.glyphs).toBe("https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf");
      expect(style.sprite).toContain("/styles/sprite");
      expect(baseMapVectorCredits(env).map((credit) => credit.sourceId)).toEqual([
        "openstreetmap",
        "openmaptiles",
        "openfreemap",
      ]);
    },
  );

  it("keeps explicit local tiles and glyphs and omits hosted credits", async () => {
    process.env.NEXT_PUBLIC_TILES_URL = "https://local.test/data/openmapx.json";
    process.env.NEXT_PUBLIC_MAP_STYLE_URL = "https://local.test/";
    vi.stubGlobal("fetch", async () => Response.json({ sources: { openmaptiles: {} } }));
    const env = buildClientEnv(config);
    const style = await loadOpenMapXStyle(env);
    expect(style.sources).toMatchObject({
      openmaptiles: { url: "https://local.test/data/openmapx.json" },
    });
    expect(style.glyphs).toBe("https://local.test/fonts/{fontstack}/{range}.pbf");
    expect(baseMapVectorCredits(env).map((credit) => credit.sourceId)).toEqual([
      "openstreetmap",
      "openmaptiles",
    ]);
  });
});
