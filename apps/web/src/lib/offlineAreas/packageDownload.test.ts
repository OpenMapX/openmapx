import type { OfflineMapPackageManifest, OfflinePackageCompatibility } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OfflinePackageApi } from "./packageApi";
import { OfflinePackageApiError } from "./packageApi";
import {
  downloadOfflinePackage,
  hasActiveOfflinePackageDownload,
  OFFLINE_PACKAGE_CHANGED_EVENT,
} from "./packageDownload";
import type { OfflinePackageResolver } from "./packageResolver";
import { createOfflinePackageResolver } from "./packageResolver";
import { MemoryOfflinePackageStorage } from "./packageStorage";
import { Sha256 } from "./sha256";
import type { OfflinePackageStorage } from "./types";

vi.mock("./pmtilesReader", () => ({
  validateLocalPmtilesArchive: vi.fn(async () => ({ minZoom: 1, maxZoom: 14 })),
}));

const packageId = `omp2-${"c".repeat(64)}`;
const originalDateNow = Date.now;

afterEach(() => {
  Date.now = originalDateNow;
  vi.unstubAllGlobals();
});

function hash(bytes: Uint8Array): string {
  return new Sha256().update(bytes).digestHex();
}

function manifest(bytes: Uint8Array, sha = hash(bytes)): OfflineMapPackageManifest {
  return {
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
      byteLength: bytes.byteLength,
      sha256: sha,
      etag: `sha256-${sha}`,
    },
    glyphs: {
      version: "glyphs-v1",
      urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
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

async function storeReadyRecord(
  storage: OfflinePackageStorage,
  current: OfflineMapPackageManifest,
): Promise<void> {
  const byteLength = current.archive.byteLength;
  await storage.put({
    id: packageId,
    name: "Fixture",
    manifest: current,
    status: "ready",
    bytesReceived: byteLength,
    bytesTotal: byteLength,
    verifiedPrefixBytes: byteLength,
    createdAt: 1,
    updatedAt: 1,
  });
}

async function resolverFor(storage: OfflinePackageStorage): Promise<OfflinePackageResolver> {
  const compatibility: OfflinePackageCompatibility = { tileSchema: "openmaptiles" };
  const resolver = createOfflinePackageResolver(storage, compatibility);
  await resolver.refresh();
  return resolver;
}

/** Refresh `resolver` from every package-changed event, the way the app does. */
function trackPackageChanges(resolver: OfflinePackageResolver): {
  events: string[];
  settle(): Promise<void>;
} {
  const events: string[] = [];
  const refreshes: Promise<void>[] = [];
  const listener = (event: Event) => {
    events.push((event as CustomEvent<{ packageId: string }>).detail.packageId);
    refreshes.push(resolver.refresh());
  };
  window.addEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, listener);
  return {
    events,
    async settle() {
      window.removeEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, listener);
      await Promise.all(refreshes);
    },
  };
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
        const range = args[1] as { start: number; etag: string } | undefined;
        expect(range).toEqual({ start: 3, etag: current.archive.etag });
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

  it("fails before the network request when browser storage cannot hold the archive", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const api = apiFor(response(bytes, 200, { etag: current.archive.etag }));
    const storage = new MemoryOfflinePackageStorage();
    storage.estimate = async () => ({ available: bytes.byteLength - 1 });

    const error = await failure(() => downloadOfflinePackage(api, storage, current));
    expect(error.name).toBe("QuotaExceededError");
    expect(api.openArchive).not.toHaveBeenCalled();
    expect((await storage.get(packageId))?.lastError?.code).toBe("quota");
  });

  it("repairs evicted glyph assets without downloading a valid ready archive again", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const api = apiFor(response(bytes, 200, { etag: current.archive.etag }));
    const storage = new MemoryOfflinePackageStorage();
    await downloadOfflinePackage(api, storage, current);
    let validationAttempts = 0;
    const validateStyles = async (): Promise<void> => {
      validationAttempts += 1;
      if (validationAttempts === 1) throw new Error("glyph cache missing");
    };

    const error = await failure(() =>
      downloadOfflinePackage(api, storage, current, { validateStyles }),
    );
    expect(error.message).toContain("glyph cache missing");
    expect((await storage.get(packageId))?.lastError?.code).toBe("offline-assets-unavailable");

    const repaired = await downloadOfflinePackage(api, storage, current, { validateStyles });
    expect(repaired.status).toBe("ready");
    expect(api.openArchive).toHaveBeenCalledTimes(1);
  });

  it("shares one same-package download and keeps active state until it settles", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    let markArchiveOpened: (() => void) | undefined;
    const archiveOpened = new Promise<void>((resolve) => {
      markArchiveOpened = resolve;
    });
    const api = {
      openArchive: vi.fn(async () => {
        markArchiveOpened?.();
        return new Response(body, { headers: { etag: current.archive.etag } });
      }),
    } as unknown as OfflinePackageApi;
    const storage = new MemoryOfflinePackageStorage();

    const first = downloadOfflinePackage(api, storage, current);
    const second = downloadOfflinePackage(api, storage, current);
    await archiveOpened;
    expect(api.openArchive).toHaveBeenCalledTimes(1);
    expect(hasActiveOfflinePackageDownload()).toBe(true);

    streamController?.enqueue(bytes);
    streamController?.close();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.status).toBe("ready");
    expect(secondResult.status).toBe("ready");
    expect(api.openArchive).toHaveBeenCalledTimes(1);
    expect(hasActiveOfflinePackageDownload()).toBe(false);
  });

  it("calculates resumed transfer speed from bytes received in the current attempt", async () => {
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
    let now = 1_000;
    Date.now = () => now;
    const api = {
      openArchive: vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            now = 2_000;
            controller.enqueue(bytes.subarray(3));
            controller.close();
          },
        });
        return new Response(body, {
          status: 206,
          headers: {
            etag: current.archive.etag,
            "content-range": "bytes 3-5/6",
          },
        });
      }),
    } as unknown as OfflinePackageApi;
    const progress: Array<{ status: string; speedBytesPerSecond: number }> = [];

    await downloadOfflinePackage(api, storage, current, {
      onProgress: (update) => progress.push(update),
    });

    expect(progress.at(-1)).toEqual({
      packageId,
      status: "ready",
      bytesReceived: 6,
      bytesTotal: 6,
      speedBytesPerSecond: 3,
    });
  });

  it("runs the durable download inside an exclusive Web Lock when available", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const api = apiFor(response(bytes, 200, { etag: current.archive.etag }));
    const storage = new MemoryOfflinePackageStorage();
    const originalGet = storage.get.bind(storage);
    let lockHeld = false;
    storage.get = async (id: string) => {
      expect(lockHeld).toBe(true);
      return await originalGet(id);
    };
    const lockRequests: Array<{ name: string; options: LockOptions }> = [];
    const locks = {
      request: async (
        name: string,
        options: LockOptions,
        callback: (lock: Lock) => Promise<unknown>,
      ) => {
        lockRequests.push({ name, options });
        lockHeld = true;
        try {
          return await callback({ name, mode: "exclusive" } as Lock);
        } finally {
          lockHeld = false;
        }
      },
    } as unknown as LockManager;
    vi.stubGlobal("navigator", { ...navigator, locks });

    const result = await downloadOfflinePackage(api, storage, current);

    expect(result.status).toBe("ready");
    expect(lockRequests).toEqual([
      { name: `openmapx-offline-package:${packageId}`, options: { mode: "exclusive" } },
    ]);
  });

  it("announces the deletion of a record replaced by a new archive ETag", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const stale = manifest(bytes, "a".repeat(64));
    const current = manifest(bytes);
    const storage = new MemoryOfflinePackageStorage();
    await storeReadyRecord(storage, stale);
    const resolver = await resolverFor(storage);
    expect(resolver.packageForCoordinate([0.5, 0.5])?.id).toBe(packageId);
    const changes = trackPackageChanges(resolver);

    // The replacement download fails, so the only event can be the deletion.
    const api = apiFor(response(new Uint8Array(), 503));
    await failure(() => downloadOfflinePackage(api, storage, current));
    await changes.settle();

    expect(changes.events).toEqual([packageId]);
    expect(resolver.packageForCoordinate([0.5, 0.5])).toBeUndefined();
    expect(resolver.compatiblePackageIds()).toEqual([]);
  });

  it("announces the deletion of a ready record whose archive is no longer usable", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const storage = new MemoryOfflinePackageStorage();
    // A record left behind after the browser evicted the finalized archive.
    await storeReadyRecord(storage, current);
    const resolver = await resolverFor(storage);
    expect(resolver.packageForCoordinate([0.5, 0.5])?.id).toBe(packageId);
    const changes = trackPackageChanges(resolver);

    const api = apiFor(response(new Uint8Array(), 503));
    const error = await failure(() => downloadOfflinePackage(api, storage, current));
    await changes.settle();

    expect(error.name).toBe(new OfflinePackageApiError("x", 503, "x").name);
    expect(changes.events).toEqual([packageId]);
    expect(resolver.packageForCoordinate([0.5, 0.5])).toBeUndefined();
    expect(resolver.compatiblePackageIds()).toEqual([]);
  });

  it("does not announce a deletion when nothing was stored for the package", async () => {
    const bytes = new TextEncoder().encode("abcdef");
    const current = manifest(bytes);
    const storage = new MemoryOfflinePackageStorage();
    const resolver = await resolverFor(storage);
    const changes = trackPackageChanges(resolver);

    const api = apiFor(response(new Uint8Array(), 503));
    await failure(() => downloadOfflinePackage(api, storage, current));
    await changes.settle();

    expect(changes.events).toEqual([]);
  });
});
