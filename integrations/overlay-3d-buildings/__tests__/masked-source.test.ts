import { fromVectorTileJs, GeoJSONWrapper } from "@maplibre/vt-pbf";
import type { BuildingReplacement } from "@openmapx/core";
import { AJAXError } from "maplibre-gl";
import { describe, expect, it, vi } from "vitest";
import { createMaskProtocolHandler, isMaskable, type LiveBuildingSource } from "../masked-source";

const BASE = "https://maps.example/";

function source(overrides: Partial<LiveBuildingSource> = {}): LiveBuildingSource {
  return {
    sourceId: "openmaptiles",
    sourceLayer: "building",
    templates: ["https://tiles.example/{z}/{x}/{y}.pbf"],
    maxzoom: 14,
    ...overrides,
  };
}

function buildingTile(): Uint8Array<ArrayBuffer> {
  const layer = new GeoJSONWrapper(
    [
      {
        id: 22,
        type: 3,
        tags: { render_height: 10 },
        geometry: [
          [
            [100, 100],
            [200, 100],
            [200, 200],
            [100, 200],
            [100, 100],
          ],
        ],
      },
    ],
    { version: 2, extent: 4096 },
  );
  layer.name = "building";
  return new Uint8Array(fromVectorTileJs({ layers: { building: layer } }));
}

describe("isMaskable", () => {
  it("is true only for http(s) templates after resolving against the base URI", () => {
    expect(isMaskable(source(), BASE)).toBe(true);
    expect(isMaskable(source({ templates: ["/tiles/{z}/{x}/{y}.pbf"] }), BASE)).toBe(true);
    expect(isMaskable(source({ templates: ["pmtiles://archive/{z}/{x}/{y}"] }), BASE)).toBe(false);
    expect(
      isMaskable(source({ templates: ["https://a/{z}/{x}/{y}", "offline://b/{z}/{x}/{y}"] }), BASE),
    ).toBe(false);
  });

  it("is false while the source has only a TileJSON url", () => {
    expect(isMaskable(null, BASE)).toBe(false);
    expect(isMaskable(source({ templates: [] }), BASE)).toBe(false);
  });
});

describe("createMaskProtocolHandler", () => {
  const params = (url: string) =>
    ({ url }) as Parameters<ReturnType<typeof createMaskProtocolHandler>>[0];

  it("returns original bytes without replacements and rewritten bytes with one", async () => {
    const bytes = buildingTile();
    const fetchImpl = vi.fn(
      async () => new Response(bytes, { status: 200, headers: { "cache-control": "max-age=60" } }),
    );
    let replacements: BuildingReplacement[] = [];
    const handler = createMaskProtocolHandler(
      () => ({ source: source(), replacements }),
      fetchImpl as unknown as typeof fetch,
    );
    const untouched = await handler(
      params("openmapx-buildings://14/8192/5461"),
      new AbortController(),
    );
    expect(new Uint8Array(untouched.data as ArrayBuffer)).toEqual(bytes);
    expect(untouched.cacheControl).toBe("max-age=60");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://tiles.example/14/8192/5461.pbf",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    replacements = [{ id: "r", featureIds: [22], bbox: [-0.01, 85.0, 0.03, 85.06] }];
    const rewritten = await handler(
      params("openmapx-buildings://14/8192/0"),
      new AbortController(),
    );
    expect(new Uint8Array(rewritten.data as ArrayBuffer)).not.toEqual(bytes);
  });

  it("converts y for tms sources", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(buildingTile(), { status: 200 }),
    );
    const handler = createMaskProtocolHandler(
      () => ({ source: source({ scheme: "tms" }), replacements: [] }),
      fetchImpl as unknown as typeof fetch,
    );
    await handler(params("openmapx-buildings://2/1/0"), new AbortController());
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://tiles.example/2/1/3.pbf");
  });

  it("protocol throws a 404 AJAXError for a missing tile", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const handler = createMaskProtocolHandler(
      () => ({ source: source(), replacements: [] }),
      fetchImpl as unknown as typeof fetch,
    );
    const error = await handler(params("openmapx-buildings://14/1/1"), new AbortController()).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AJAXError);
    expect((error as AJAXError).status).toBe(404);
  });

  it("reuses the raw tile for repeated requests", async () => {
    const fetchImpl = vi.fn(async () => new Response(buildingTile(), { status: 200 }));
    const handler = createMaskProtocolHandler(
      () => ({ source: source(), replacements: [] }),
      fetchImpl as unknown as typeof fetch,
    );
    await handler(params("openmapx-buildings://14/3/3"), new AbortController());
    await handler(params("openmapx-buildings://14/3/3"), new AbortController());
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
