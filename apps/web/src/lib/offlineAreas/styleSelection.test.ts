import type { OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import { isConfiguredOnlineStyleReachable, selectOnlineFirstOpenMapXStyle } from "./styleSelection";

const packageId = `omp2-${"d".repeat(64)}`;
const manifest: OfflineMapPackageManifest = {
  schemaVersion: 2,
  packageId,
  requestKey: "style-selection",
  dataset: {
    id: "openmapx",
    version: "dataset-v1",
    generatedAt: "2026-08-04T00:00:00.000Z",
    sourceMaxZoom: 14,
    tileSchema: "openmaptiles",
  },
  coverage: { bbox: { west: 0, south: 0, east: 1, north: 1 }, minZoom: 0, maxZoom: 14 },
  archive: {
    url: `/api/offline/packages/${packageId}/archive`,
    contentType: "application/vnd.pmtiles",
    byteLength: 1,
    sha256: "a".repeat(64),
    etag: `sha256-${"a".repeat(64)}`,
  },
  glyphs: {
    version: "glyphs-v1",
    urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
  },
  attribution: ["© OpenStreetMap contributors"],
};
const packages = [{ packageId, manifest }];

function configuredStyle(): Record<string, unknown> {
  return {
    version: 8,
    sources: {
      openmaptiles: {
        type: "vector",
        url: "/api/maptiler/tiles/v3-openmaptiles/tiles.json?language=en",
      },
    },
    glyphs: "/api/maptiler/fonts/{fontstack}/{range}.pbf",
    sprite: "/styles/sprite",
    layers: [{ id: "water", type: "fill", source: "openmaptiles" }],
  };
}

describe("online-first OpenMapX style selection", () => {
  it("keeps the configured online style when its vector source is reachable", async () => {
    const style = configuredStyle();
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return true;
    };

    const selected = await selectOnlineFirstOpenMapXStyle(style, packages, {
      online: true,
      probe,
    });

    expect(selected).toEqual({ offline: false, style });
    expect(probeCalls).toBe(1);
  });

  it("uses installed packages immediately when the browser reports offline", async () => {
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return true;
    };

    const selected = await selectOnlineFirstOpenMapXStyle(configuredStyle(), packages, {
      online: false,
      probe,
    });

    expect(selected.offline).toBe(true);
    expect(probeCalls).toBe(0);
  });

  it("falls back when the source is unreachable despite navigator being online", async () => {
    const selected = await selectOnlineFirstOpenMapXStyle(configuredStyle(), packages, {
      online: true,
      probe: async () => false,
    });

    expect(selected.offline).toBe(true);
    expect(
      (selected.style.sources as Record<string, Record<string, unknown>>).openmaptiles.tiles,
    ).toEqual([`pmtiles://offline/${packageId}/{z}/{x}/{y}`]);
  });

  it("does not probe or alter online behavior when no local package is ready", async () => {
    const style = configuredStyle();
    let probeCalls = 0;
    const probe = async () => {
      probeCalls += 1;
      return true;
    };

    const selected = await selectOnlineFirstOpenMapXStyle(style, [], {
      online: false,
      probe,
    });

    expect(selected).toEqual({ offline: false, style });
    expect(probeCalls).toBe(0);
  });

  it("marks the TileJSON request, bypasses caches, and aborts a bounded probe", async () => {
    vi.useFakeTimers();
    let requestUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    const fetcher = (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = input;
      requestInit = init;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    };

    const result = isConfiguredOnlineStyleReachable(configuredStyle(), {
      fetcher,
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(await result).toBe(false);
    expect(new URL(String(requestUrl)).searchParams.get("openmapxReachability")).toBe("1");
    expect(new URL(String(requestUrl)).searchParams.get("language")).toBe("en");
    expect(requestInit?.cache).toBe("no-store");
    expect(requestInit?.signal?.aborted).toBe(true);
    vi.useRealTimers();
  });
});
