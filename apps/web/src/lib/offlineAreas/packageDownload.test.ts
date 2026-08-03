import type { OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it, vi } from "vitest";
import type { OfflinePackageApi } from "./packageApi";
import { OfflinePackageApiError } from "./packageApi";
import { downloadOfflinePackage } from "./packageDownload";
import { MemoryOfflinePackageStorage } from "./packageStorage";
import { Sha256 } from "./sha256";

vi.mock("./pmtilesReader", () => ({
  validateLocalPmtilesArchive: vi.fn(async () => ({ minZoom: 1, maxZoom: 14 })),
}));

const packageId = `omp1-${"c".repeat(64)}`;

function hash(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

function manifest(bytes: Uint8Array, sha = hash(bytes)): OfflineMapPackageManifest {
  return {
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
      byteLength: bytes.byteLength,
      sha256: sha,
      etag: `sha256-${sha}`,
    },
    style: {
      provider: "openmapx",
      version: "style-v1",
      variants: ["light", "dark"],
      assetBaseUrl: "/api/offline/packages/assets/openmapx/style-v1",
    },
    attribution: ["© OpenStreetMap contributors"],
  };
}

function apiFor(response: Response): OfflinePackageApi {
  return {
    openArchive: vi.fn(async () => response),
  } as unknown as OfflinePackageApi;
}

function response(bytes: Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  const body = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  body.set(bytes);
  return new Response(body.buffer, { status, headers });
}

async function failure(task: () => Promise<unknown>): Promise<Error> {
  try {
    await task();
  } catch (reason) {
    return reason as Error;
  }
  throw new Error("expected task to fail");
}

describe("downloadOfflinePackage", () => {
  it("streams, verifies, and atomically finalizes a fresh archive", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const api = apiFor(response(bytes, 200, { etag: current.archive.etag }));
    const storage = new MemoryOfflinePackageStorage();
    const metrics: string[] = [];
    const result = await downloadOfflinePackage(api, storage, current, {
      name: "Fixture",
      onMetric: (metric) => metrics.push(`${metric.event}:${metric.status}`),
    });
    expect(result.status).toBe("ready");
    expect(result.bytesReceived).toBe(bytes.byteLength);
    expect(metrics).toContain("download:started");
    expect(metrics).toContain("verify:started");
    expect(metrics).toContain("download:ready");
    const file = await storage.openReady(packageId);
    expect(Array.from(await file.read(0, bytes.byteLength))).toEqual(Array.from(bytes));
  });

  it("resumes only from a matching ETag and verified prefix", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const storage = new MemoryOfflinePackageStorage();
    await storage.put({
      id: packageId,
      name: "Fixture",
      manifest: current,
      status: "paused",
      bytesReceived: 3,
      bytesTotal: 6,
      verifiedPrefixBytes: 3,
      createdAt: 1,
      updatedAt: 1,
    });
    const partial = await storage.openPartial(packageId);
    await partial.append(bytes.subarray(0, 3));
    await partial.close();
    const api = {
      openArchive: vi.fn(async (...args: unknown[]) => {
        const range = args[1] as { start: number } | undefined;
        expect(range).toEqual({ start: 3 });
        return response(bytes.subarray(3), 206, {
          etag: current.archive.etag,
          "content-range": "bytes 3-5/6",
        });
      }),
    } as unknown as OfflinePackageApi;
    const result = await downloadOfflinePackage(api, storage, current);
    expect(result.status).toBe("ready");
    expect(api.openArchive).toHaveBeenCalledTimes(1);
  });

  it("does not mark a checksum failure as ready", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes, "d".repeat(64));
    const api = apiFor(response(bytes, 200, { etag: current.archive.etag }));
    const storage = new MemoryOfflinePackageStorage();
    const error = await failure(() => downloadOfflinePackage(api, storage, current));
    expect(error.message).toContain("checksum");
    expect((await storage.get(packageId))?.status).toBe("error");
    const readyError = await failure(() => storage.openReady(packageId));
    expect(readyError.message).toContain("not ready");
  });

  it("reports an HTTP error without confusing it with a successful package", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const api = apiFor(response(new Uint8Array(), 503));
    const storage = new MemoryOfflinePackageStorage();
    const error = await failure(() => downloadOfflinePackage(api, storage, current));
    expect(error.name).toBe(new OfflinePackageApiError("x", 503, "x").name);
    expect((await storage.get(packageId))?.status).toBe("error");
  });
});
