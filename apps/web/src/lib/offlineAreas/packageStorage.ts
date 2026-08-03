import { validateOfflineMapPackageManifest } from "@openmapx/core";
import type {
  OfflineArchiveFile,
  OfflinePackageRecord,
  OfflinePackageStorage,
  OfflinePackageStorageEstimate,
} from "./types";

const DB_NAME = "openmapx-offline";
const DB_VERSION = 1;
const PACKAGE_STORE = "packages";
const ARCHIVE_STORE = "archives";
const OPFS_DIRECTORY = "offline-packages";
const PACKAGE_ID_PATTERN = /^omp1-[0-9a-f]{64}$/;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy.buffer;
}

interface StoredArchive {
  key: string;
  blob: Blob;
}

function assertPackageId(packageId: string): void {
  if (!PACKAGE_ID_PATTERN.test(packageId)) throw new Error("invalid offline package id");
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function opfsAvailable(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.storage?.getDirectory === "function";
}

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (!idbAvailable()) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PACKAGE_STORE)) {
        database.createObjectStore(PACKAGE_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(ARCHIVE_STORE)) {
        database.createObjectStore(ARCHIVE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("offline database open failed"));
    request.onblocked = () => reject(new Error("offline database upgrade is blocked"));
  });
  return databasePromise;
}

async function idbRequest<T>(
  storeName: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openDatabase();
  return await new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = operation(transaction.objectStore(storeName));
    let result: T;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => reject(request.error ?? new Error("offline database request failed"));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("offline database transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("offline database transaction aborted"));
  });
}

async function readArchiveBlob(key: string): Promise<Blob | undefined> {
  const value = await idbRequest<StoredArchive | undefined>(ARCHIVE_STORE, "readonly", (store) =>
    store.get(key),
  );
  return value?.blob;
}

async function writeArchiveBlob(key: string, blob: Blob): Promise<void> {
  await idbRequest(ARCHIVE_STORE, "readwrite", (store) =>
    store.put({ key, blob } satisfies StoredArchive),
  );
}

async function deleteArchiveBlob(key: string): Promise<void> {
  await idbRequest(ARCHIVE_STORE, "readwrite", (store) => store.delete(key));
}

class BlobArchiveFile implements OfflineArchiveFile {
  private readonly chunks: Uint8Array[];
  private currentSize: number;
  private closed = false;

  constructor(
    initial: Uint8Array,
    private readonly persist: (bytes: Uint8Array) => Promise<void>,
  ) {
    this.chunks = initial.byteLength > 0 ? [initial.slice()] : [];
    this.currentSize = initial.byteLength;
  }

  async size(): Promise<number> {
    this.assertOpen();
    return this.currentSize;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      throw new Error("invalid offline archive range");
    }
    const bytes = this.toBytes();
    return bytes.slice(offset, Math.min(bytes.length, offset + length));
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.assertOpen();
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk.slice());
    this.currentSize += chunk.byteLength;
  }

  async truncate(size: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid offline archive size");
    const bytes = this.toBytes().slice(0, size);
    this.chunks.length = 0;
    if (bytes.byteLength > 0) this.chunks.push(bytes);
    this.currentSize = bytes.byteLength;
  }

  async flush(): Promise<void> {
    this.assertOpen();
    await this.persist(this.toBytes());
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  private toBytes(): Uint8Array {
    const result = new Uint8Array(this.currentSize);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("offline archive file is closed");
  }
}

type OpfsFileHandle = FileSystemFileHandle & {
  move?: (name: string) => Promise<void>;
};

class OpfsArchiveFile implements OfflineArchiveFile {
  private writable: FileSystemWritableFileStream | undefined;
  private currentSizePromise: Promise<number>;
  private closed = false;

  constructor(private readonly handle: OpfsFileHandle) {
    this.currentSizePromise = this.handle.getFile().then((file) => file.size);
  }

  async size(): Promise<number> {
    this.assertOpen();
    return await this.currentSizePromise;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.assertOpen();
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0
    ) {
      throw new Error("invalid offline archive range");
    }
    const file = await this.handle.getFile();
    return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  }

  async append(chunk: Uint8Array): Promise<void> {
    this.assertOpen();
    if (chunk.byteLength === 0) return;
    const writer = await this.getWritable();
    const offset = await this.currentSizePromise;
    await writer.seek(offset);
    await writer.write(toArrayBuffer(chunk));
    this.currentSizePromise = Promise.resolve(offset + chunk.byteLength);
  }

  async truncate(size: number): Promise<void> {
    this.assertOpen();
    if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid offline archive size");
    const writer = await this.getWritable();
    await writer.truncate(size);
    this.currentSizePromise = Promise.resolve(size);
  }

  async flush(): Promise<void> {
    this.assertOpen();
    if (!this.writable) return;
    const writer = this.writable;
    this.writable = undefined;
    await writer.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }

  private async getWritable(): Promise<FileSystemWritableFileStream> {
    if (!this.writable) {
      this.writable = await this.handle.createWritable({ keepExistingData: true });
    }
    return this.writable;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("offline archive file is closed");
  }
}

export class MemoryOfflinePackageStorage implements OfflinePackageStorage {
  private readonly records = new Map<string, OfflinePackageRecord>();
  private readonly partial = new Map<string, Uint8Array>();
  private readonly ready = new Map<string, Uint8Array>();

  async list(): Promise<OfflinePackageRecord[]> {
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(packageId: string): Promise<OfflinePackageRecord | undefined> {
    return this.records.get(packageId);
  }

  async put(record: OfflinePackageRecord): Promise<void> {
    validateOfflineMapPackageManifest(record.manifest);
    this.records.set(record.id, structuredClone(record));
  }

  async delete(packageId: string): Promise<void> {
    this.records.delete(packageId);
    this.partial.delete(packageId);
    this.ready.delete(packageId);
  }

  async openPartial(packageId: string): Promise<OfflineArchiveFile> {
    assertPackageId(packageId);
    const existing = this.partial.get(packageId) ?? new Uint8Array();
    return new BlobArchiveFile(existing, async (bytes) => {
      this.partial.set(packageId, bytes);
    });
  }

  async finalize(packageId: string): Promise<void> {
    assertPackageId(packageId);
    const bytes = this.partial.get(packageId);
    if (!bytes) throw new Error("offline package partial archive is missing");
    this.ready.set(packageId, bytes);
    this.partial.delete(packageId);
  }

  async openReady(packageId: string): Promise<OfflineArchiveFile> {
    assertPackageId(packageId);
    const bytes = this.ready.get(packageId);
    if (!bytes) throw new Error("offline package archive is not ready");
    return new BlobArchiveFile(bytes, async () => {});
  }

  async estimate(): Promise<OfflinePackageStorageEstimate> {
    return {};
  }
}

export class IndexedDbOfflinePackageStorage implements OfflinePackageStorage {
  private readonly useOpfs: boolean;
  private opfsDirectoryPromise: Promise<FileSystemDirectoryHandle> | undefined;

  constructor() {
    this.useOpfs = opfsAvailable();
  }

  async list(): Promise<OfflinePackageRecord[]> {
    if (!idbAvailable()) return [];
    const records = await idbRequest<unknown[]>(PACKAGE_STORE, "readonly", (store) =>
      store.getAll(),
    );
    return records.flatMap((value) => {
      try {
        const record = value as OfflinePackageRecord;
        validateOfflineMapPackageManifest(record.manifest);
        return record.id === record.manifest.packageId ? [record] : [];
      } catch {
        return [];
      }
    });
  }

  async get(packageId: string): Promise<OfflinePackageRecord | undefined> {
    assertPackageId(packageId);
    if (!idbAvailable()) return undefined;
    const value = await idbRequest<OfflinePackageRecord | undefined>(
      PACKAGE_STORE,
      "readonly",
      (store) => store.get(packageId),
    );
    if (!value) return undefined;
    try {
      validateOfflineMapPackageManifest(value.manifest);
      return value.id === value.manifest.packageId ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async put(record: OfflinePackageRecord): Promise<void> {
    assertPackageId(record.id);
    validateOfflineMapPackageManifest(record.manifest);
    if (record.id !== record.manifest.packageId)
      throw new Error("offline package record id mismatch");
    await idbRequest(PACKAGE_STORE, "readwrite", (store) => store.put(record));
  }

  async delete(packageId: string): Promise<void> {
    assertPackageId(packageId);
    if (idbAvailable()) {
      await idbRequest(PACKAGE_STORE, "readwrite", (store) => store.delete(packageId));
    }
    if (this.useOpfs) {
      const directory = await this.getOpfsDirectory();
      for (const name of [`${packageId}.pmtiles`, `${packageId}.pmtiles.part`]) {
        try {
          await directory.removeEntry(name);
        } catch {
          // A missing archive is already in the desired state.
        }
      }
      return;
    }
    if (idbAvailable()) {
      await Promise.all([
        deleteArchiveBlob(this.archiveKey(packageId, "ready")),
        deleteArchiveBlob(this.archiveKey(packageId, "partial")),
      ]);
    }
  }

  async openPartial(packageId: string): Promise<OfflineArchiveFile> {
    assertPackageId(packageId);
    if (this.useOpfs) {
      const directory = await this.getOpfsDirectory();
      const handle = (await directory.getFileHandle(`${packageId}.pmtiles.part`, {
        create: true,
      })) as OpfsFileHandle;
      return new OpfsArchiveFile(handle);
    }
    const blob = (await readArchiveBlob(this.archiveKey(packageId, "partial"))) ?? new Blob();
    const initial = new Uint8Array(await blob.arrayBuffer());
    return new BlobArchiveFile(initial, async (bytes) => {
      await writeArchiveBlob(
        this.archiveKey(packageId, "partial"),
        new Blob([toArrayBuffer(bytes)]),
      );
    });
  }

  async finalize(packageId: string): Promise<void> {
    assertPackageId(packageId);
    if (this.useOpfs) {
      const directory = await this.getOpfsDirectory();
      const partial = (await directory.getFileHandle(
        `${packageId}.pmtiles.part`,
      )) as OpfsFileHandle;
      const move = partial.move;
      if (typeof move === "function") {
        await move.call(partial, `${packageId}.pmtiles`);
        return;
      }
      const source = await partial.getFile();
      const target = await directory.getFileHandle(`${packageId}.pmtiles`, { create: true });
      const writable = await target.createWritable();
      await writable.write(source);
      await writable.close();
      await directory.removeEntry(`${packageId}.pmtiles.part`);
      return;
    }
    const blob = await readArchiveBlob(this.archiveKey(packageId, "partial"));
    if (!blob) throw new Error("offline package partial archive is missing");
    await writeArchiveBlob(this.archiveKey(packageId, "ready"), blob);
    await deleteArchiveBlob(this.archiveKey(packageId, "partial"));
  }

  async openReady(packageId: string): Promise<OfflineArchiveFile> {
    assertPackageId(packageId);
    if (this.useOpfs) {
      const directory = await this.getOpfsDirectory();
      const handle = (await directory.getFileHandle(`${packageId}.pmtiles`)) as OpfsFileHandle;
      return new OpfsArchiveFile(handle);
    }
    const blob = await readArchiveBlob(this.archiveKey(packageId, "ready"));
    if (!blob) throw new Error("offline package archive is not ready");
    return new BlobArchiveFile(new Uint8Array(await blob.arrayBuffer()), async () => {});
  }

  async estimate(): Promise<OfflinePackageStorageEstimate> {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return {};
    const estimate = await navigator.storage.estimate();
    return {
      usage: estimate.usage,
      quota: estimate.quota,
      available:
        estimate.quota !== undefined && estimate.usage !== undefined
          ? Math.max(0, estimate.quota - estimate.usage)
          : undefined,
    };
  }

  private async getOpfsDirectory(): Promise<FileSystemDirectoryHandle> {
    if (!this.opfsDirectoryPromise) {
      if (!opfsAvailable()) throw new Error("OPFS unavailable");
      this.opfsDirectoryPromise = navigator.storage
        .getDirectory()
        .then((root) => root.getDirectoryHandle(OPFS_DIRECTORY, { create: true }));
    }
    return await this.opfsDirectoryPromise;
  }

  private archiveKey(packageId: string, state: "ready" | "partial"): string {
    return `${packageId}:${state}`;
  }
}

let defaultStorage: OfflinePackageStorage | undefined;

export function createOfflinePackageStorage(): OfflinePackageStorage {
  if (defaultStorage) return defaultStorage;
  if (!idbAvailable()) {
    defaultStorage = new MemoryOfflinePackageStorage();
  } else {
    defaultStorage = new IndexedDbOfflinePackageStorage();
  }
  return defaultStorage;
}

export function resetOfflinePackageStorageForTests(): void {
  defaultStorage = undefined;
  databasePromise = undefined;
}
