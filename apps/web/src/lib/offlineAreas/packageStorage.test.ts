import type { OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { MemoryOfflinePackageStorage } from "./packageStorage";

const packageId = `omp2-${"a".repeat(64)}`;
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

describe("MemoryOfflinePackageStorage", () => {
  it("keeps a partial archive inaccessible until finalization", async () => {
    const storage = new MemoryOfflinePackageStorage();
    await storage.put({
      id: packageId,
      name: "Fixture",
      manifest,
      status: "downloading",
      bytesReceived: 3,
      bytesTotal: 3,
      verifiedPrefixBytes: 3,
      createdAt: 1,
      updatedAt: 1,
    });
    const partial = await storage.openPartial(packageId);
    await partial.append(new TextEncoder().encode("abc"));
    await partial.close();
    let error: unknown;
    try {
      await storage.openReady(packageId);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeDefined();
    expect(String((error as Error).message)).toContain("not ready");
    await storage.finalize(packageId);
    const ready = await storage.openReady(packageId);
    expect(new TextDecoder().decode(await ready.read(0, 3))).toBe("abc");
  });

  it("deletes metadata and both archive states", async () => {
    const storage = new MemoryOfflinePackageStorage();
    await storage.put({
      id: packageId,
      name: "Fixture",
      manifest,
      status: "paused",
      bytesReceived: 0,
      bytesTotal: 3,
      verifiedPrefixBytes: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    const partial = await storage.openPartial(packageId);
    await partial.append(new Uint8Array([1]));
    await partial.close();
    await storage.delete(packageId);
    const freshPartial = await storage.openPartial(packageId);
    expect(await freshPartial.size()).toBe(0);
    let error: unknown;
    try {
      await storage.openReady(packageId);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeDefined();
    expect(String((error as Error).message)).toContain("not ready");
    expect(await storage.list()).toEqual([]);
  });
});
