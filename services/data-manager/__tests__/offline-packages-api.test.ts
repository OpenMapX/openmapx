import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OfflineMapPackageManifest, OfflinePackageRequest } from "@openmapx/core";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerApi } from "../src/api.js";
import { OfflinePackageGenerator } from "../src/offline-packages/generator.js";
import { OfflinePackageStorage } from "../src/offline-packages/storage.js";

const roots: string[] = [];
const archiveBytes = "offline-pmtiles-fixture";
const archiveSha256 = createHash("sha256").update(archiveBytes).digest("hex");
const source = {
  descriptor: {
    datasetId: "openmapx" as const,
    datasetVersion: "fixture-dataset",
    sourceMaxZoom: 12,
    sourceBounds: { west: 0, south: 0, east: 10, north: 10 },
    tileSchema: "openmaptiles" as const,
    styleProvider: "openmapx" as const,
    styleVersion: "fixture-style-v1",
    packageAlgorithmVersion: "pmtiles-area-v1",
    attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
  },
  mbtilesPath: "/fixture/tiles.mbtiles",
  styleDirectory: "/fixture/styles",
  packageRoot: "/fixture/packages",
};
const request: OfflinePackageRequest = {
  bbox: { west: 1, south: 1, east: 2, north: 2 },
  minZoom: 1,
  maxZoom: 12,
  provider: "openmapx",
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function publishedManifest(packageId: string): OfflineMapPackageManifest {
  return {
    schemaVersion: 1,
    packageId,
    requestKey: "fixture-request-key",
    dataset: {
      id: "openmapx",
      version: "fixture-dataset",
      generatedAt: "2026-08-03T00:00:00.000Z",
      sourceMaxZoom: 12,
      tileSchema: "openmaptiles",
    },
    coverage: { bbox: request.bbox, minZoom: 1, maxZoom: 12 },
    archive: {
      url: `/api/offline/packages/${packageId}/archive`,
      contentType: "application/vnd.pmtiles",
      byteLength: Buffer.byteLength(archiveBytes),
      sha256: archiveSha256,
      etag: `sha256-${archiveSha256}`,
    },
    style: {
      provider: "openmapx",
      version: "fixture-style-v1",
      variants: ["light", "dark"],
      assetBaseUrl: "/api/offline/packages/assets/openmapx/fixture-style-v1",
    },
    attribution: ["© OpenStreetMap contributors", "© OpenMapTiles"],
  };
}

async function createGenerator(root: string): Promise<{
  generator: OfflinePackageGenerator;
  storage: OfflinePackageStorage;
}> {
  const storage = new OfflinePackageStorage(join(root, "packages"));
  const existingId = `omp1-${"a".repeat(64)}`;
  const part = storage.temporaryArchivePath("existing");
  writeFileSync(part, archiveBytes);
  await storage.publishPackage({ archivePath: part, manifest: publishedManifest(existingId) });
  const generator = new OfflinePackageGenerator({
    source: () => source,
    storage,
    extractor: vi.fn(async ({ destinationPath }) => {
      mkdirSync(join(root, "packages", ".tmp"), { recursive: true });
      writeFileSync(destinationPath, archiveBytes);
      return {
        byteLength: Buffer.byteLength(archiveBytes),
        sha256: archiveSha256,
        etag: `sha256-${archiveSha256}`,
        bounds: request.bbox,
        minZoom: 1,
        maxZoom: 12,
        tileCount: 1,
        tileCompression: "none" as const,
        attribution: source.descriptor.attribution,
        sourceBytesRead: 100,
        destinationBytesWritten: Buffer.byteLength(archiveBytes),
        temporaryBytesPeak: Buffer.byteLength(archiveBytes),
      };
    }),
  });
  await generator.initialize();
  return { generator, storage };
}

describe("data-manager offline package API", () => {
  it("exposes capability, preparation, manifest, and range-safe archive responses", async () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-offline-api-"));
    roots.push(root);
    const { generator } = await createGenerator(root);
    const assetPath = join(root, "fixture-style.json");
    writeFileSync(assetPath, JSON.stringify({ version: 8 }));
    vi.spyOn(generator, "openStyleAsset").mockResolvedValue({
      path: assetPath,
      byteLength: Buffer.byteLength(JSON.stringify({ version: 8 })),
      contentType: "application/json",
    });
    const app = Fastify();
    registerApi(app, { dataDir: root, offlinePackages: generator });

    const capability = await app.inject({ method: "GET", url: "/offline/packages/capability" });
    expect(capability.statusCode).toBe(200);
    expect(capability.json()).toMatchObject({
      available: true,
      provider: "openmapx",
      sourceMaxZoom: 12,
    });

    const prepare = await app.inject({
      method: "POST",
      url: "/offline/packages/prepare",
      payload: request,
    });
    expect(prepare.statusCode).toBe(202);
    expect(prepare.json().status).toBe("preparing");

    const packageId = `omp1-${"a".repeat(64)}`;
    const manifest = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/manifest`,
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().archive.sha256).toBe(archiveSha256);

    const assetHead = await app.inject({
      method: "HEAD",
      url: "/offline/packages/assets/openmapx/fixture-style-v1/styles/osm-bright/style.json",
    });
    expect(assetHead.statusCode).toBe(200);
    expect(assetHead.headers["cache-control"]).toContain("immutable");
    expect(assetHead.headers["content-type"]).toContain("application/json");
    const asset = await app.inject({
      method: "GET",
      url: "/offline/packages/assets/openmapx/fixture-style-v1/styles/osm-bright/style.json",
    });
    expect(asset.statusCode).toBe(200);
    expect(asset.json().version).toBe(8);

    const head = await app.inject({
      method: "HEAD",
      url: `/offline/packages/${packageId}/archive`,
    });
    expect(head.statusCode).toBe(200);
    expect(head.headers["accept-ranges"]).toBe("bytes");
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(archiveBytes)));
    expect(head.headers.etag).toBe(`sha256-${archiveSha256}`);

    const range = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/archive`,
      headers: { range: "bytes=1-3" },
    });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe(`bytes 1-3/${Buffer.byteLength(archiveBytes)}`);
    expect(range.body).toBe(archiveBytes.slice(1, 4));

    const suffix = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/archive`,
      headers: { range: "bytes=-4" },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.body).toBe(archiveBytes.slice(-4));

    const unsatisfiable = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/archive`,
      headers: { range: "bytes=999-1000" },
    });
    expect(unsatisfiable.statusCode).toBe(416);
    expect(unsatisfiable.headers["content-range"]).toBe(
      `bytes */${Buffer.byteLength(archiveBytes)}`,
    );

    const ifRangeMismatch = await app.inject({
      method: "GET",
      url: `/offline/packages/${packageId}/archive`,
      headers: { range: "bytes=1-3", "if-range": "sha256-wrong" },
    });
    expect(ifRangeMismatch.statusCode).toBe(200);
    expect(ifRangeMismatch.body).toBe(archiveBytes);

    const missing = await app.inject({
      method: "GET",
      url: `/offline/packages/omp1-${"f".repeat(64)}/manifest`,
    });
    expect(missing.statusCode).toBe(404);
    const traversal = await app.inject({
      method: "GET",
      url: "/offline/packages/not-a-package/manifest",
    });
    expect(traversal.statusCode).toBe(400);
    await app.close();
  });
});
