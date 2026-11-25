// @vitest-environment jsdom

import { INDEXED_DB_DATABASES } from "@openmapx/core";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { clearPrivateDeviceData, deleteCrowdIdentity } from "./accountDeletionCleanup";

describe("clearPrivateDeviceData", () => {
  it("clears query state, browser stores, private caches, IndexedDB data, and offline packages", async () => {
    localStorage.setItem("openmapx-private", "value");
    sessionStorage.setItem("openmapx-session", "value");
    const deletedCaches: string[] = [];
    let idbClears = 0;
    let offlineClears = 0;
    let crowdClears = 0;
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
        keys: async () => ["openmapx:app-shell-v1", "openmapx:api-geodata"],
        delete: async (name: string) => {
          deletedCaches.push(name);
          return true;
        },
      },
      clearIdb,
      clearOfflinePackages,
      clearCrowdIdentity: async () => {
        crowdClears += 1;
      },
    });

    expect(queryClient.clear).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(deletedCaches).toEqual(["openmapx:api-geodata"]);
    expect(idbClears).toBe(1);
    expect(offlineClears).toBe(1);
    expect(crowdClears).toBe(1);
  });

  it("keeps the worker's app-shell precache and deletes every runtime cache", async () => {
    const runtimeCaches = [
      "openmapx:style-assets-build-a",
      "openmapx:static-assets",
      "openmapx:maplibre-runtimes",
      "openmapx:api-geodata",
      "openmapx:api-category-search",
      "openmapx:api-autocomplete",
      "openmapx:api-weather",
      "openmapx:api-photos",
      "openmapx:map-tiles",
      "openmapx:street-level-imagery-tiles",
      "openmapx:vector-tiles",
      "openmapx:offline-package-glyphs-v1",
      "openmapx:preferences",
      "others",
      "cross-origin",
      "next-data",
    ];
    const deletedCaches: string[] = [];

    const result = await clearPrivateDeviceData({
      queryClient: { clear: vi.fn() },
      cacheStorage: {
        keys: async () => [
          "openmapx:app-shell-build-a",
          "openmapx:app-shell-build-b",
          ...runtimeCaches,
        ],
        delete: async (name: string) => {
          deletedCaches.push(name);
          return true;
        },
      },
      clearIdb: async () => {},
      clearOfflinePackages: async () => {},
    });

    expect(deletedCaches).toEqual(runtimeCaches);
    expect(result.failures).toBe(0);
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

describe("deleteCrowdIdentity", () => {
  function openCrowdDatabase(factory: IDBFactory): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = factory.open(INDEXED_DB_DATABASES.crowd, 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  it("deletes the database when the open connection closes on request", async () => {
    const factory = new IDBFactory();
    const db = await openCrowdDatabase(factory);
    db.onversionchange = () => db.close();

    await expect(deleteCrowdIdentity(factory, 50)).resolves.toBeUndefined();
    expect((await factory.databases()).map((d) => d.name)).not.toContain(
      INDEXED_DB_DATABASES.crowd,
    );
  });

  it("fails instead of reporting success while a connection still blocks the delete", async () => {
    const factory = new IDBFactory();
    const db = await openCrowdDatabase(factory);

    await expect(deleteCrowdIdentity(factory, 20)).rejects.toThrow(/blocked/);
    db.close();
  });
});
