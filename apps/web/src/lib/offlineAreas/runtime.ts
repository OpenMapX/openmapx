import { defaultOfflinePackageApi } from "./packageApi";
import { recordOfflinePackageMetric } from "./packageMetrics";
import type { OfflinePackageResolver } from "./packageResolver";
import {
  configureDefaultOfflinePackageResolver,
  getDefaultOfflinePackageResolver,
} from "./packageResolver";
import { createOfflinePackageStorage } from "./packageStorage";

let initialization: Promise<OfflinePackageResolver | undefined> | undefined;

/** Discover the current server dataset and prepare the page-side package resolver. */
export function ensureOfflinePackageRuntime(): Promise<OfflinePackageResolver | undefined> {
  if (initialization) return initialization;
  initialization = (async () => {
    try {
      const capability = await defaultOfflinePackageApi.capability();
      if (capability.available && capability.datasetVersion && capability.styleVersion) {
        const resolver = configureDefaultOfflinePackageResolver({
          datasetVersion: capability.datasetVersion,
          styleVersion: capability.styleVersion,
          tileSchema: "openmaptiles",
        });
        await resolver.refresh();
        return resolver;
      }
    } catch {
      // A package must remain usable after a cold offline launch. Fall through
      // to the compatibility values stored in the local package manifest.
    }

    const localRecords = await createOfflinePackageStorage()
      .list()
      .catch(() => []);
    const ready = localRecords.find((record) => record.status === "ready");
    if (!ready) {
      recordOfflinePackageMetric({
        event: "cold-reload",
        status: "no-local-package",
        browserCapability: {
          indexedDb: typeof indexedDB !== "undefined",
          opfs: typeof navigator !== "undefined" && "storage" in navigator,
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
      styleVersion: ready.manifest.style.version,
      byteLength: ready.manifest.archive.byteLength,
    });
    const resolver = configureDefaultOfflinePackageResolver({
      datasetVersion: ready.manifest.dataset.version,
      styleVersion: ready.manifest.style.version,
      tileSchema: ready.manifest.dataset.tileSchema,
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
