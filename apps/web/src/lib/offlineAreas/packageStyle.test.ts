import type { OfflineMapPackageManifest } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hasOfflineGlyphAssets,
  resolveOfflinePackageStyle,
  validateOfflineStyleAssets,
} from "./packageStyle";

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
  it("validates the configured online styles and pins only package fonts", async () => {
    const cache = memoryCache();
    vi.stubGlobal("caches", { open: async () => cache });
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("/catalog.json")) {
        return Response.json({ Metropolis: ["0-255", "1024-1279", "19968-20223"] });
      }
      return new Response(new ArrayBuffer(1));
    });
    vi.stubGlobal("fetch", fetchMock);

    const configured = styles();
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
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/19968-20223.pbf"))).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some((args) => String(args[0]).includes("/256-511.pbf"))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some((args) => String(args[0]) === "/styles/sprite.json")).toBe(
      true,
    );
    expect(fetchMock.mock.calls.some((args) => String(args[0]) === "/styles/sprite.png")).toBe(
      true,
    );
  });

  it("rewrites the configured online style for one or more offline packages", () => {
    const configured = onlineStyle();
    const style = resolveOfflinePackageStyle(configured, [{ packageId, manifest }]);
    const source = (style.sources as Record<string, Record<string, unknown>>).openmaptiles;

    expect(source.tiles).toEqual([`pmtiles://offline/${packageId}/{z}/{x}/{y}`]);
    expect(source.url).toBeUndefined();
    expect(style.glyphs).toContain("offlineGlyphs=glyphs-v1");
    expect(style.sprite).toBe("/styles/sprite");
    expect(style.layers).toEqual(configured.layers);
  });

  it("uses one vector source and one layer set for every overview package", () => {
    const secondPackageId = `omp2-${"c".repeat(64)}`;
    const secondManifest = {
      ...manifest,
      packageId: secondPackageId,
      archive: {
        ...manifest.archive,
        url: `/api/offline/packages/${secondPackageId}/archive`,
      },
    };
    const style = resolveOfflinePackageStyle(onlineStyle(), [
      { packageId, manifest },
      { packageId: secondPackageId, manifest: secondManifest },
    ]);
    const sources = style.sources as Record<string, Record<string, unknown>>;
    const layers = style.layers as Array<Record<string, unknown>>;

    expect(sources.openmaptiles.tiles).toEqual([
      `pmtiles://offline/${packageId},${secondPackageId}/{z}/{x}/{y}`,
    ]);
    expect(sources.openmaptiles.url).toBeUndefined();
    expect(layers).toEqual(onlineStyle().layers);
  });

  it("advertises only the maximum zoom shared by every package", () => {
    const lowerZoomPackageId = `omp2-${"e".repeat(64)}`;
    const lowerZoomManifest: OfflineMapPackageManifest = {
      ...manifest,
      packageId: lowerZoomPackageId,
      coverage: { ...manifest.coverage, maxZoom: 12 },
      archive: {
        ...manifest.archive,
        url: `/api/offline/packages/${lowerZoomPackageId}/archive`,
      },
    };

    const style = resolveOfflinePackageStyle(onlineStyle(), [
      { packageId, manifest },
      { packageId: lowerZoomPackageId, manifest: lowerZoomManifest },
    ]);
    const source = (style.sources as Record<string, Record<string, unknown>>).openmaptiles;

    expect(source.maxzoom).toBe(12);
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
