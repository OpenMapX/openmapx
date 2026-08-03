import type { OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { resolveOfflinePackageStyle, validateOfflineStyleAssets } from "./packageStyle";

const packageId = `omp1-${"b".repeat(64)}`;
const manifest: OfflineMapPackageManifest = {
  schemaVersion: 1,
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
  style: {
    provider: "openmapx",
    version: "style-v1",
    variants: ["light", "dark"],
    assetBaseUrl: "/api/offline/packages/assets/openmapx/style-v1",
  },
  attribution: ["© OpenStreetMap contributors"],
};

function styleResponse(): Response {
  return new Response(
    JSON.stringify({
      version: 8,
      sources: { openmaptiles: { type: "vector", url: "mbtiles://{openmapx}" } },
      sprite: "sprite",
      glyphs: "{fontstack}/{range}.pbf",
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
    }),
    { headers: { "content-type": "application/json" } },
  );
}

describe("offline package styles", () => {
  it("pins both variants and rewrites only the vector source", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const input = args[0];
      const url = String(input);
      return url.includes("/style.json?") ? styleResponse() : new Response(new ArrayBuffer(1));
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await validateOfflineStyleAssets(manifest);
    expect((result.light.sources as Record<string, unknown>).openmaptiles).toBeDefined();
    expect(
      fetchMock.mock.calls.some((args) => String(args[0]).includes("offlineStyle=style-v1")),
    ).toBe(true);

    const style = await resolveOfflinePackageStyle(manifest, packageId, "dark");
    const source = (style.sources as Record<string, Record<string, unknown>>).openmaptiles;
    expect(source.tiles).toEqual([`pmtiles://offline/${packageId}/{z}/{x}/{y}`]);
    expect(source.url).toBeUndefined();
    expect(style.glyphs).toContain("offlineStyle=style-v1");
    expect(style.sprite).toBe(
      "/api/offline/packages/assets/openmapx/style-v1/styles/dark-matter/sprite",
    );
    vi.unstubAllGlobals();
  });

  it("adds a source and matching layers for every overview package", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        return url.includes("/style.json?") ? styleResponse() : new Response(new ArrayBuffer(1));
      }),
    );

    const secondPackageId = `omp1-${"c".repeat(64)}`;
    const style = await resolveOfflinePackageStyle(manifest, packageId, "light", [
      packageId,
      secondPackageId,
    ]);
    const sources = style.sources as Record<string, Record<string, unknown>>;
    const layers = style.layers as Array<Record<string, unknown>>;
    const overviewSource = sources[`openmaptiles-${secondPackageId}`];

    expect(overviewSource?.tiles).toEqual([`pmtiles://offline/${secondPackageId}/{z}/{x}/{y}`]);
    expect(overviewSource?.url).toBeUndefined();
    expect(layers.filter((layer) => layer.source === `openmaptiles-${secondPackageId}`)).toEqual([
      expect.objectContaining({ id: `water-${secondPackageId}` }),
    ]);

    vi.unstubAllGlobals();
  });

  it("fails before readiness when a required style asset is unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        const input = args[0];
        return String(input).includes("/style.json?")
          ? styleResponse()
          : new Response("missing", { status: 404 });
      }),
    );
    let error: unknown;
    try {
      await validateOfflineStyleAssets(manifest);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeDefined();
    expect(String((error as Error).message)).toContain("unavailable");
    vi.unstubAllGlobals();
  });

  it("allows the optional private-use glyph range to be absent", async () => {
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("/style.json?")) return styleResponse();
      if (url.includes("/64512-65023.pbf")) {
        return new Response("missing", { status: 404 });
      }
      return new Response(new ArrayBuffer(1));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await validateOfflineStyleAssets(manifest);
    expect(result.manifest).toBe(manifest);

    vi.unstubAllGlobals();
  });

  it("places sprite file extensions before the offline style query", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (...args: unknown[]) => {
        const url = String(args[0]);
        urls.push(url);
        return url.includes("/style.json?") ? styleResponse() : new Response(new ArrayBuffer(1));
      }),
    );

    await validateOfflineStyleAssets(manifest);

    expect(urls).toContain(
      "/api/offline/packages/assets/openmapx/style-v1/styles/osm-bright/sprite.json?offlineStyle=style-v1",
    );
    expect(urls).toContain(
      "/api/offline/packages/assets/openmapx/style-v1/styles/osm-bright/sprite.png?offlineStyle=style-v1",
    );
    expect(urls).toContain(
      "/api/offline/packages/assets/openmapx/style-v1/styles/osm-bright/sprite@2x.json?offlineStyle=style-v1",
    );
    expect(urls).toContain(
      "/api/offline/packages/assets/openmapx/style-v1/styles/osm-bright/sprite@2x.png?offlineStyle=style-v1",
    );
    vi.unstubAllGlobals();
  });
});
