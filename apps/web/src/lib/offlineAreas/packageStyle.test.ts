import type { OfflineMapPackageManifest } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasOfflineGlyphAssets,
  resolveOfflinePackageStyle,
  validateOfflineStyleAssets,
} from "./packageStyle";

/** The resolved style's openmaptiles source; a style without one fails the test. */
function vectorSource(style: Record<string, unknown>): Record<string, unknown> {
  const source = (style.sources as Record<string, Record<string, unknown>>).openmaptiles;
  if (!source) throw new Error("The resolved style has no openmaptiles source");
  return source;
}

const packageId = `omp2-${"b".repeat(64)}`;
const manifest: OfflineMapPackageManifest = {
  schemaVersion: 2,
  packageId,
  requestKey: "fixture",
  dataset: {
    id: "openmapx",
    version: "dataset-v1",
    generatedAt: "2026-08-03T00:00:00.000Z",
    sourceMaxZoom: 14,
    tileSchema: "openmaptiles",
  },
  coverage: { bbox: { west: 0, south: 0, east: 1, north: 1 }, minZoom: 1, maxZoom: 14 },
  archive: {
    url: `/api/offline/packages/${packageId}/archive`,
    contentType: "application/vnd.pmtiles",
    byteLength: 3,
    sha256: "a".repeat(64),
    etag: `sha256-${"a".repeat(64)}`,
  },
  glyphs: {
    version: "glyphs-v1",
    urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
  },
  attribution: ["© OpenStreetMap contributors"],
};

afterEach(() => vi.unstubAllGlobals());

function memoryCache(): Cache {
  const entries = new Map<string, Response>();
  return {
    async delete(input: RequestInfo | URL) {
      return entries.delete(String(input));
    },
    async match(input: RequestInfo | URL) {
      return entries.get(String(input))?.clone();
    },
    async put(input: RequestInfo | URL, response: Response) {
      entries.set(String(input), response.clone());
    },
  } as unknown as Cache;
}

function onlineStyle(): Record<string, unknown> {
  return {
    version: 8,
    sources: { openmaptiles: { type: "vector", url: "configured-tilejson" } },
    sprite: "/styles/sprite",
    glyphs: "/api/maptiler/fonts/{fontstack}/{range}.pbf",
    layers: [
      {
        id: "water",
        source: "openmaptiles",
        "source-layer": "water",
        type: "fill",
        layout: { "text-font": ["Metropolis"] },
      },
      { id: "background", type: "background" },
    ],
  };
}

function styles(): { light: Record<string, unknown>; dark: Record<string, unknown> } {
  return { light: onlineStyle(), dark: onlineStyle() };
}

describe("offline package styles", () => {
  it("validates the configured online styles, pins package fonts and skips locally drawn ranges", async () => {
    const cache = memoryCache();
    vi.stubGlobal("caches", { open: async () => cache });
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("/catalog.json")) {
        return Response.json({
          Metropolis: ["0-255", "1024-1279", "1536-1791", "19968-20223", "2304-2559"],
        });
      }
      return new Response(new ArrayBuffer(1));
    });
    vi.stubGlobal("fetch", fetchMock);

    const configured = styles();
    configured.light["font-faces"] = {
      Metropolis: [
        {
          url: "https://maps.example/fonts/scripts/NotoSansTifinagh-Regular.woff2",
          "unicode-range": ["U+2D30-2D7F"],
        },
      ],
    };
    expect(await hasOfflineGlyphAssets(manifest)).toBe(false);
    await validateOfflineStyleAssets(manifest, configured, {
      apiBaseUrl: "https://api.example.test/",
    });
    expect(await hasOfflineGlyphAssets(manifest)).toBe(true);
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/style.json"))).toBe(
      false,
    );
    expect(
      fetchMock.mock.calls.some((args) =>
        String(args[0]).startsWith(
          "https://api.example.test/api/offline/packages/glyphs/glyphs-v1/",
        ),
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/1536-1791.pbf"))).toBe(
      true,
    );
    // CJK and complex-shaping ranges are rasterized locally by MapLibre and skipped offline.
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/19968-20223.pbf"))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/2304-2559.pbf"))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/256-511.pbf"))).toBe(
      false,
    );
    expect(
      fetchMock.mock.calls.some(
        (args) =>
          String(args[0]) ===
          "https://maps.example/fonts/scripts/NotoSansTifinagh-Regular.woff2?offlineGlyphs=glyphs-v1",
      ),
    ).toBe(true);
    expect(fetchMock.mock.calls.some((args) => String(args[0]) === "/styles/sprite.json")).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some((args) => String(args[0]) === "/styles/sprite.png")).toBe(
      true,
    );
  });

  it("rewrites the configured online style for one or more offline packages", () => {
    const configured: Record<string, unknown> = {
      ...onlineStyle(),
      "font-faces": {
        Metropolis: [
          {
            url: "https://maps.example/fonts/scripts/NotoSansTifinagh-Regular.woff2",
            "unicode-range": ["U+2D30-2D7F"],
          },
        ],
      },
    };
    const style = resolveOfflinePackageStyle(configured, [{ packageId, manifest }]);
    const source = vectorSource(style);

    expect(source.tiles).toEqual([`pmtiles://offline/${packageId}/{z}/{x}/{y}`]);
    expect(source.url).toBeUndefined();
    expect(style.glyphs).toContain("offlineGlyphs=glyphs-v1");
    expect(style["font-faces"]).toEqual({
      Metropolis: [
        {
          url: "https://maps.example/fonts/scripts/NotoSansTifinagh-Regular.woff2?offlineGlyphs=glyphs-v1",
          "unicode-range": ["U+2D30-2D7F"],
        },
      ],
    });
    expect(style.sprite).toBe("/styles/sprite");
    expect(style.layers).toEqual(configured.layers);
  });

  it("uses one vector source and one layer set for every overview package", () => {
    const secondPackageId = `omp2-${"c".repeat(64)}`;
    const secondManifest = {
      ...manifest,
      packageId: secondPackageId,
      coverage: { ...manifest.coverage, maxZoom: 12 },
      archive: {
        ...manifest.archive,
        url: `/api/offline/packages/${secondPackageId}/archive`,
      },
    };
    const style = resolveOfflinePackageStyle(onlineStyle(), [
      { packageId, manifest },
      { packageId: secondPackageId, manifest: secondManifest },
    ]);
    const source = vectorSource(style);
    const layers = style.layers as Array<Record<string, unknown>>;

    expect(source.tiles).toEqual([`pmtiles://offline/${packageId},${secondPackageId}/{z}/{x}/{y}`]);
    expect(source.url).toBeUndefined();
    expect(source.maxzoom).toBe(12);
    expect(layers).toEqual(onlineStyle().layers);
  });

  it("resolves package glyphs through the runtime API origin", () => {
    const style = resolveOfflinePackageStyle(onlineStyle(), [{ packageId, manifest }], {
      apiBaseUrl: "https://api.example.test/",
    });

    expect(style.glyphs).toBe(
      "https://api.example.test/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf?offlineGlyphs=glyphs-v1",
    );
  });

  it("refuses readiness when Cache Storage cannot durably retain glyphs", async () => {
    vi.stubGlobal("caches", undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let error: unknown;
    try {
      await validateOfflineStyleAssets(manifest, styles());
    } catch (reason) {
      error = reason;
    }
    expect(String((error as Error).message).toLowerCase()).toContain("cache storage");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails before readiness when a required package font is unavailable", async () => {
    const cache = memoryCache();
    vi.stubGlobal("caches", { open: async () => cache });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        if (url.includes("/catalog.json")) return Response.json({ Metropolis: ["0-255"] });
        return url.includes("/0-255.pbf")
          ? new Response("missing", { status: 404 })
          : new Response(new ArrayBuffer(1));
      }),
    );

    let error: unknown;
    try {
      await validateOfflineStyleAssets(manifest, styles());
    } catch (reason) {
      error = reason;
    }
    expect(String((error as Error).message)).toContain("unavailable");
  });
});
