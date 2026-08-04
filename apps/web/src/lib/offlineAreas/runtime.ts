import { recordOfflinePackageMetric } from "./packageMetrics";
import type { OfflinePackageResolver } from "./packageResolver";
import {
  configureDefaultOfflinePackageResolver,
  getDefaultOfflinePackageResolver,
} from "./packageResolver";
import { createOfflinePackageStorage } from "./packageStorage";
import { hasOfflineGlyphAssets } from "./packageStyle";

let initialization: Promise<OfflinePackageResolver | undefined> | undefined;

/** Discover the current server dataset and prepare the page-side package resolver. */
export function ensureOfflinePackageRuntime(): Promise<OfflinePackageResolver | undefined> {
  if (initialization) return initialization;
  initialization = (async () => {
    const storage = createOfflinePackageStorage();
    const localRecords = await storage.list().catch(() => []);
    for (const record of localRecords) {
      if (record.status !== "ready" || (await hasOfflineGlyphAssets(record.manifest))) continue;
      record.status = "error";
      record.lastError = {
        code: "offline-assets-unavailable",
        message: "The offline glyph cache is missing and must be downloaded again.",
      };
      record.updatedAt = Date.now();
      await storage.put(record);
    }
    const ready = localRecords.find((record) => record.status === "ready");
    if (!ready) {
      recordOfflinePackageMetric({
        event: "cold-reload",
        status: "no-local-package",
        browserCapability: {
          indexedDb: typeof indexedDB !== "undefined",
          opfs:
            typeof navigator !== "undefined" &&
            typeof navigator.storage?.getDirectory === "function",
          cacheStorage: typeof caches !== "undefined",
        },
      });
      return undefined;
    }
    recordOfflinePackageMetric({
      event: "cold-reload",
      packageId: ready.id,
      status: "local-package",
      datasetVersion: ready.manifest.dataset.version,
      glyphsVersion: ready.manifest.glyphs.version,
      byteLength: ready.manifest.archive.byteLength,
    });
    const resolver = configureDefaultOfflinePackageResolver({
      tileSchema: "openmaptiles",
    });
    await resolver.refresh();
    return resolver;
  })().catch(() => undefined);
  return initialization;
}

export function resetOfflinePackageRuntime(): void {
  initialization = undefined;
}

export function currentOfflinePackageResolver(): OfflinePackageResolver | undefined {
  return getDefaultOfflinePackageResolver();
}
