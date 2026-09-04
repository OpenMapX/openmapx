"use client";

import type { QueryClient } from "@tanstack/react-query";
import { idbClear } from "./idbStore";
import { createOfflinePackageStorage } from "./offlineAreas";

interface CacheStorageCleanup {
  keys(): Promise<string[]>;
  delete(name: string): Promise<boolean>;
}

interface AccountDeletionCleanupOptions {
  queryClient: Pick<QueryClient, "clear">;
  cacheStorage?: CacheStorageCleanup;
  clearIdb?: () => Promise<void>;
  clearOfflinePackages?: () => Promise<void>;
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
  ];
  if (cacheStorage) {
    tasks.push(
      cacheStorage
        .keys()
        .then((names) => Promise.all(names.map((name) => cacheStorage.delete(name)))),
    );
  }
  const results = await Promise.allSettled(tasks);
  failures += results.filter((result) => result.status === "rejected").length;
  return { failures };
}
