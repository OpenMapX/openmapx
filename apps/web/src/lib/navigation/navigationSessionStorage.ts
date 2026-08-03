"use client";

import {
  isNavigationSessionExpired,
  type NavigationSessionSnapshot,
  parseNavigationSessionSnapshot,
} from "@openmapx/core";
import { idbDelete, idbGet, idbSet } from "../idbStore";

export const NAVIGATION_SESSION_STORAGE_KEY = "openmapx:navigation-session:v1";

export interface NavigationSessionStorage {
  read(): Promise<NavigationSessionSnapshot | null>;
  write(snapshot: NavigationSessionSnapshot): Promise<void>;
  clear(): Promise<void>;
}

interface NavigationSessionStorageOperations {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

const defaultOperations: NavigationSessionStorageOperations = {
  get: (key) => idbGet(key),
  set: idbSet,
  delete: idbDelete,
};

/**
 * IndexedDB adapter for the one resumable ground-navigation session.
 * IndexedDB is deliberately used instead of localStorage: route geometry and
 * maneuver data can be much larger than a preference, and the record remains
 * scoped to this exact key.
 */
export function createNavigationSessionStorage(
  operations: NavigationSessionStorageOperations = defaultOperations,
  now: () => number = Date.now,
): NavigationSessionStorage {
  return {
    async read() {
      const raw = await operations.get(NAVIGATION_SESSION_STORAGE_KEY);
      const snapshot = parseNavigationSessionSnapshot(raw);
      if (!snapshot || isNavigationSessionExpired(snapshot, now())) {
        if (raw !== undefined) await operations.delete(NAVIGATION_SESSION_STORAGE_KEY);
        return null;
      }
      return snapshot;
    },

    async write(snapshot) {
      if (snapshot.kind !== "ground" || isNavigationSessionExpired(snapshot, now())) {
        throw new Error("cannot persist an invalid or expired navigation session");
      }
      const validated = parseNavigationSessionSnapshot(snapshot);
      if (!validated) throw new Error("cannot persist an invalid navigation session");
      await operations.set(NAVIGATION_SESSION_STORAGE_KEY, validated);
    },

    async clear() {
      await operations.delete(NAVIGATION_SESSION_STORAGE_KEY);
    },
  };
}

const defaultStorage = createNavigationSessionStorage();

export function readNavigationSession(): Promise<NavigationSessionSnapshot | null> {
  return defaultStorage.read();
}

export function writeNavigationSession(snapshot: NavigationSessionSnapshot): Promise<void> {
  return defaultStorage.write(snapshot);
}

export function clearNavigationSession(): Promise<void> {
  return defaultStorage.clear();
}
