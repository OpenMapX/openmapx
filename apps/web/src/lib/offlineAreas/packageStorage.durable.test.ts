import { Blob } from "node:buffer";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformOpfs } from "../../test/platformOpfs";
import {
  createOfflinePackageStorage,
  IndexedDbOfflinePackageStorage,
  MemoryOfflinePackageStorage,
  resetOfflinePackageStorageForTests,
} from "./packageStorage";
import type { OfflinePackageRecord } from "./types";

const packageId = `omp2-${"a".repeat(64)}`;
function record(): OfflinePackageRecord {
  return {
    id: packageId,
    name: "Fixture",
    status: "paused",
    bytesReceived: 3,
    bytesTotal: 3,
    verifiedPrefixBytes: 3,
    createdAt: 1,
    updatedAt: 2,
    manifest: {
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
    },
  };
}

const connections: IDBDatabase[] = [];
function reopen() {
  for (const database of connections.splice(0)) database.close();
  resetOfflinePackageStorageForTests();
  return new IndexedDbOfflinePackageStorage();
}

beforeEach(() => {
  resetOfflinePackageStorageForTests();
  const factory = new IDBFactory();
  const open = factory.open.bind(factory);
  vi.spyOn(factory, "open").mockImplementation((name, version) => {
    const request = open(name as string, version as number | undefined);
    request.addEventListener("success", () => connections.push(request.result));
    return request;
  });
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("Blob", Blob);
  vi.stubGlobal("navigator", { storage: {} });
});
afterEach(() => {
  reopen();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

for (const backend of ["blob", "opfs-move", "opfs-copy"] as const) {
  describe(`durable storage: ${backend}`, () => {
    let opfs: ReturnType<typeof createPlatformOpfs>;
    beforeEach(() => {
      opfs = createPlatformOpfs(backend === "opfs-move");
      if (backend !== "blob") vi.stubGlobal("navigator", { storage: opfs.storage });
    });

    it("persists independent metadata snapshots across database reopen", async () => {
      const storage = new IndexedDbOfflinePackageStorage();
      const original = record();
      await storage.put(original);
      original.name = "mutated";
      const fresh = reopen();
      expect(await fresh.get(packageId)).toEqual(record());
      const result = (await fresh.list())[0];
      result.name = "also mutated";
      expect((await fresh.get(packageId))?.name).toBe("Fixture");
    });

    it("flushes append, reopens, truncates and finalizes exact bytes", async () => {
      let storage = new IndexedDbOfflinePackageStorage();
      const partial = await storage.openPartial(packageId);
      await partial.append(new Uint8Array([10, 20]));
      await partial.flush();
      await expect(storage.openReady(packageId)).rejects.toThrow();
      await partial.append(new Uint8Array([30, 40]));
      await partial.close();
      storage = reopen();
      const resumed = await storage.openPartial(packageId);
      expect(await resumed.read(0, 10)).toEqual(new Uint8Array([10, 20, 30, 40]));
      await resumed.truncate(3);
      await resumed.close();
      await storage.finalize(packageId);
      storage = reopen();
      const ready = await storage.openReady(packageId);
      expect(await ready.size()).toBe(3);
      expect(await ready.read(1, 20)).toEqual(new Uint8Array([20, 30]));
      await ready.close();
      expect(await (await storage.openPartial(packageId)).size()).toBe(0);
    });

    it("deletes metadata and both partial and ready bytes", async () => {
      const storage = new IndexedDbOfflinePackageStorage();
      await storage.put(record());
      const partial = await storage.openPartial(packageId);
      await partial.append(new Uint8Array([1, 2, 3]));
      await partial.close();
      await storage.finalize(packageId);
      const nextPartial = await storage.openPartial(packageId);
      await nextPartial.append(new Uint8Array([4]));
      await nextPartial.close();
      await storage.delete(packageId);
      const fresh = reopen();
      expect(await fresh.get(packageId)).toBeUndefined();
      expect(await fresh.list()).toEqual([]);
      await expect(fresh.openReady(packageId)).rejects.toThrow();
      expect(await (await fresh.openPartial(packageId)).size()).toBe(0);
    });

    it("reconciles missing ready archives and clamps verified prefix to durable partial", async () => {
      const storage = new IndexedDbOfflinePackageStorage();
      await storage.put({ ...record(), status: "ready" });
      const partial = await storage.openPartial(packageId);
      await partial.append(new Uint8Array([7, 8]));
      await partial.close();
      expect(await storage.list()).toEqual([
        expect.objectContaining({
          status: "error",
          bytesReceived: 2,
          verifiedPrefixBytes: 2,
          lastError: expect.objectContaining({ code: "archive-missing" }),
        }),
      ]);
      expect((await reopen().get(packageId))?.status).toBe("error");
    });

    if (backend === "opfs-copy") {
      it.each(["create", "write", "close"] as const)(
        "preserves resumable bytes and hides ready archive after rejected copy %s",
        async (failure) => {
          const storage = new IndexedDbOfflinePackageStorage();
          const partial = await storage.openPartial(packageId);
          await partial.append(new Uint8Array([1, 2, 3]));
          await partial.close();
          opfs.failures.set(`${packageId}.pmtiles`, failure);
          await expect(storage.finalize(packageId)).rejects.toThrow();
          const fresh = reopen();
          await expect(fresh.openReady(packageId)).rejects.toThrow();
          expect(await (await fresh.openPartial(packageId)).read(0, 3)).toEqual(
            new Uint8Array([1, 2, 3]),
          );
        },
      );
    }

    if (backend === "opfs-copy") {
      it("retains an existing ready archive when replacing it fails", async () => {
        const storage = new IndexedDbOfflinePackageStorage();
        const partial = await storage.openPartial(packageId);
        await partial.append(new Uint8Array([1, 2]));
        await partial.close();
        await storage.finalize(packageId);
        const replacement = await storage.openPartial(packageId);
        await replacement.append(new Uint8Array([9]));
        await replacement.close();
        opfs.failures.set(`${packageId}.pmtiles`, "write");
        await expect(storage.finalize(packageId)).rejects.toThrow();
        expect(await (await reopen().openReady(packageId)).read(0, 3)).toEqual(
          new Uint8Array([1, 2]),
        );
      });
    }

    if (backend === "opfs-move") {
      it("retains partial bytes when the atomic move rejects", async () => {
        const storage = new IndexedDbOfflinePackageStorage();
        const partial = await storage.openPartial(packageId);
        await partial.append(new Uint8Array([4, 5]));
        await partial.close();
        opfs.failures.set(`${packageId}.pmtiles.part`, "move");
        await expect(storage.finalize(packageId)).rejects.toThrow("move rejected");
        const fresh = reopen();
        await expect(fresh.openReady(packageId)).rejects.toThrow();
        expect(await (await fresh.openPartial(packageId)).read(0, 3)).toEqual(
          new Uint8Array([4, 5]),
        );
      });
    }

    if (backend !== "blob") {
      it("preserves committed partial bytes when writable close rejects", async () => {
        const storage = new IndexedDbOfflinePackageStorage();
        const partial = await storage.openPartial(packageId);
        await partial.append(new Uint8Array([1]));
        await partial.flush();
        await partial.append(new Uint8Array([2]));
        opfs.failures.set(`${packageId}.pmtiles.part`, "close");
        await expect(partial.close()).rejects.toThrow("close rejected");
        const fresh = reopen();
        await expect(fresh.openReady(packageId)).rejects.toThrow();
        expect(await (await fresh.openPartial(packageId)).read(0, 3)).toEqual(new Uint8Array([1]));
      });
    }
  });
}

it("uses durable factory only when IndexedDB is available", () => {
  expect(createOfflinePackageStorage()).toBeInstanceOf(IndexedDbOfflinePackageStorage);
  resetOfflinePackageStorageForTests();
  vi.stubGlobal("indexedDB", undefined);
  expect(createOfflinePackageStorage()).toBeInstanceOf(MemoryOfflinePackageStorage);
});

it("rejects invalid IDs, invalid manifests and mismatched record IDs", async () => {
  const storage = new IndexedDbOfflinePackageStorage();
  for (const method of ["get", "delete", "openPartial", "openReady", "finalize"] as const) {
    await expect(storage[method]("../invalid")).rejects.toThrow("invalid offline package id");
  }
  await expect(
    storage.put({
      ...record(),
      manifest: { ...record().manifest, schemaVersion: 1 },
    } as unknown as OfflinePackageRecord),
  ).rejects.toThrow();
  await expect(storage.put({ ...record(), id: `omp2-${"b".repeat(64)}` })).rejects.toThrow(
    "mismatch",
  );
  expect(await storage.list()).toEqual([]);
});

it("rejects metadata transactions aborted after request success without committing", async () => {
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    const request = original.call(this, value, key as IDBValidKey | undefined);
    request.addEventListener("success", () => this.transaction.abort());
    return request;
  });
  const storage = new IndexedDbOfflinePackageStorage();
  await expect(storage.put(record())).rejects.toThrow("aborted");
  expect(await storage.get(packageId)).toBeUndefined();
});

it("rejects a quota error during Blob finalization and retains the durable partial", async () => {
  const storage = new IndexedDbOfflinePackageStorage();
  const partial = await storage.openPartial(packageId);
  await partial.append(new Uint8Array([1, 2, 3]));
  await partial.close();
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    if (this.name === "archives" && (value as { key?: string }).key === `${packageId}:ready`)
      throw new DOMException("quota", "QuotaExceededError");
    return original.call(this, value, key as IDBValidKey | undefined);
  });
  await expect(storage.finalize(packageId)).rejects.toMatchObject({ name: "QuotaExceededError" });
  const fresh = reopen();
  await expect(fresh.openReady(packageId)).rejects.toThrow();
  expect(await (await fresh.openPartial(packageId)).read(0, 3)).toEqual(new Uint8Array([1, 2, 3]));
});

it("retains Blob partial bytes when the ready transaction aborts after write success", async () => {
  const storage = new IndexedDbOfflinePackageStorage();
  const partial = await storage.openPartial(packageId);
  await partial.append(new Uint8Array([6, 7]));
  await partial.close();
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    const request = original.call(this, value, key as IDBValidKey | undefined);
    if (this.name === "archives" && (value as { key?: string }).key === `${packageId}:ready`) {
      request.addEventListener("success", () => this.transaction.abort());
    }
    return request;
  });
  await expect(storage.finalize(packageId)).rejects.toThrow("aborted");
  const fresh = reopen();
  await expect(fresh.openReady(packageId)).rejects.toThrow();
  expect(await (await fresh.openPartial(packageId)).read(0, 3)).toEqual(new Uint8Array([6, 7]));
});
