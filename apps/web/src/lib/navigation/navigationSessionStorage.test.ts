import type { Route } from "@openmapx/core";
import { createNavigationSessionSnapshot } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  createNavigationSessionStorage,
  NAVIGATION_SESSION_STORAGE_KEY,
} from "./navigationSessionStorage";

const route: Route = {
  distance: 100,
  duration: 60,
  geometry: [
    [0, 0],
    [0.001, 0.001],
  ],
  legs: [
    {
      distance: 100,
      duration: 60,
      geometry: [
        [0, 0],
        [0.001, 0.001],
      ],
      steps: [
        {
          instruction: "Turn right",
          distance: 100,
          duration: 60,
          coordinates: [
            [0, 0],
            [0.001, 0.001],
          ],
        },
      ],
    },
  ],
  steps: [
    {
      instruction: "Turn right",
      distance: 100,
      duration: 60,
      coordinates: [
        [0, 0],
        [0.001, 0.001],
      ],
    },
  ],
  mode: "driving",
};

function makeSnapshot(updatedAtMs = 1_000) {
  return createNavigationSessionSnapshot({
    route,
    routes: [route],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic",
    mode: "driving",
    routeOptions: {
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
    },
    routeProvider: null,
    destinationWaypoints: [
      [0, 0],
      [0.001, 0.001],
    ],
    progress: null,
    packageIds: [],
    startedAtMs: 900,
    updatedAtMs,
  });
}

function harness(now = 1_000) {
  const map = new Map<string, unknown>();
  const storage = createNavigationSessionStorage(
    {
      get: async (key) => map.get(key),
      set: async (key, value) => void map.set(key, value),
      delete: async (key) => void map.delete(key),
    },
    () => now,
  );
  return { map, storage };
}

describe("navigation session storage", () => {
  it("reads no session when the key is absent", async () => {
    const { storage } = harness();
    expect(await storage.read()).toBeNull();
  });

  it("writes and reads a schema-valid session", async () => {
    const { map, storage } = harness();
    const snapshot = makeSnapshot();
    await storage.write(snapshot);
    expect(map.has(NAVIGATION_SESSION_STORAGE_KEY)).toBe(true);
    expect(await storage.read()).toEqual(snapshot);
  });

  it("clears corrupt data before returning null", async () => {
    const { map, storage } = harness();
    map.set(NAVIGATION_SESSION_STORAGE_KEY, { schemaVersion: 999 });
    expect(await storage.read()).toBeNull();
    expect(map.has(NAVIGATION_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("clears expired data before returning null", async () => {
    const { map, storage } = harness(1_000 + 24 * 60 * 60 * 1000 + 1);
    map.set(NAVIGATION_SESSION_STORAGE_KEY, makeSnapshot());
    expect(await storage.read()).toBeNull();
    expect(map.has(NAVIGATION_SESSION_STORAGE_KEY)).toBe(false);
  });

  it("does not throw when the backing adapter is unavailable", async () => {
    const storage = createNavigationSessionStorage({
      get: async () => undefined,
      set: async () => {},
      delete: async () => {},
    });
    expect(await storage.read()).toBeNull();
    await storage.clear();
  });

  it("does not write a transit snapshot", async () => {
    const { storage } = harness();
    let error: unknown;
    try {
      await storage.write({ ...makeSnapshot(), kind: "transit" } as never);
    } catch (reason) {
      error = reason;
    }
    expect(error).toBeDefined();
  });
});
