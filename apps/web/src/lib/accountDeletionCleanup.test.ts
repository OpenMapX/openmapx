// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { clearPrivateDeviceData } from "./accountDeletionCleanup";

describe("clearPrivateDeviceData", () => {
  it("clears query state, browser stores, caches, IndexedDB data, and offline packages", async () => {
    localStorage.setItem("openmapx-private", "value");
    sessionStorage.setItem("openmapx-session", "value");
    const deletedCaches: string[] = [];
    let idbClears = 0;
    let offlineClears = 0;
    const clearIdb = async () => {
      idbClears += 1;
    };
    const clearOfflinePackages = async () => {
      offlineClears += 1;
    };
    const queryClient = { clear: vi.fn() };

    await clearPrivateDeviceData({
      queryClient,
      cacheStorage: {
        keys: async () => ["app-shell-v1", "api-geodata"],
        delete: async (name: string) => {
          deletedCaches.push(name);
          return true;
        },
      },
      clearIdb,
      clearOfflinePackages,
    });

    expect(queryClient.clear).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(deletedCaches).toEqual(["app-shell-v1", "api-geodata"]);
    expect(idbClears).toBe(1);
    expect(offlineClears).toBe(1);
  });

  it("reports best-effort cleanup failures without misreporting server deletion as failed", async () => {
    const result = await clearPrivateDeviceData({
      queryClient: {
        clear: () => {
          throw new Error("query cleanup failed");
        },
      },
      cacheStorage: {
        keys: async () => {
          throw new Error("cache cleanup failed");
        },
        delete: async () => false,
      },
      clearIdb: async () => {
        throw new Error("idb cleanup failed");
      },
      clearOfflinePackages: async () => {
        throw new Error("offline cleanup failed");
      },
    });

    expect(result.failures).toBe(4);
  });
});
