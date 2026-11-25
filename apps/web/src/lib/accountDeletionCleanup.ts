"use client";

import { INDEXED_DB_DATABASES } from "@openmapx/core";
import type { QueryClient } from "@tanstack/react-query";
import { idbClear } from "./idbStore";
import { createOfflinePackageStorage } from "./offlineAreas";
import { isAppShellCacheName } from "./swCaches";

interface CacheStorageCleanup {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

interface AccountDeletionCleanupOptions {
  queryClient: Pick<QueryClient, "clear">;
  cacheStorage?: CacheStorageCleanup;
  clearIdb?: () => Promise<void>;
  clearOfflinePackages?: () => Promise<void>;
  clearCrowdIdentity?: () => Promise<void>;
}

/** How long a delete may stay blocked by another open connection before it counts as failed. */
const BLOCKED_DELETE_TIMEOUT_MS = 5_000;

/**
 * Delete the crowd-report signing identity together with its database. Every
 * store closes its connection when asked, so a blocked delete normally goes
 * through within moments. One still blocked after the timeout is a failure:
 * the request stays queued and completes once the last connection closes,
 * but the identity is not gone yet.
 */
export function deleteCrowdIdentity(
  factory: IDBFactory | undefined = typeof indexedDB === "undefined" ? undefined : indexedDB,
  blockedTimeoutMs = BLOCKED_DELETE_TIMEOUT_MS,
): Promise<void> {
  if (!factory) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const request = factory.deleteDatabase(INDEXED_DB_DATABASES.crowd);
    request.onsuccess = () => {
      clearTimeout(timer);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timer);
      reject(request.error ?? new Error("IndexedDB delete failed"));
    };
    request.onblocked = () => {
      timer ??= setTimeout(
        () => reject(new Error("IndexedDB delete is blocked by an open connection")),
        blockedTimeoutMs,
      );
    };
  });
}

async function removeOfflinePackages(): Promise<void> {
  const storage = createOfflinePackageStorage();
  const packages = await storage.list();
  await Promise.all(packages.map((record) => storage.delete(record.id)));
}

/** Clear account-related browser state after the server confirms deletion. */
export async function clearPrivateDeviceData(options: AccountDeletionCleanupOptions): Promise<{
  failures: number;
}> {
  let failures = 0;
  try {
    options.queryClient.clear();
  } catch {
    failures += 1;
  }
  if (typeof window !== "undefined") {
    try {
      window.localStorage.clear();
    } catch {
      failures += 1;
    }
    try {
      window.sessionStorage.clear();
    } catch {
      failures += 1;
    }
  }

  const cacheStorage = options.cacheStorage ?? (typeof caches === "undefined" ? undefined : caches);
  const tasks: Array<Promise<unknown>> = [
    (options.clearIdb ?? idbClear)(),
    (options.clearOfflinePackages ?? removeOfflinePackages)(),
    (options.clearCrowdIdentity ?? deleteCrowdIdentity)(),
  ];
  if (cacheStorage) {
    // Keep only the worker's public app-shell precache: it holds no personal
    // data and is written only when a worker installs, so deleting it would
    // leave offline navigations without the offline page until the next deploy.
    tasks.push(
      cacheStorage
        .keys()
        .then((names) =>
          Promise.all(
            names
              .filter((name) => !isAppShellCacheName(name))
              .map((name) => cacheStorage.delete(name)),
          ),
        ),
    );
  }
  const results = await Promise.allSettled(tasks);
  failures += results.filter((result) => result.status === "rejected").length;
  return { failures };
}
