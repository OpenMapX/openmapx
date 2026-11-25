"use client";

import type { LabeledPlace, SavedList, SavedPlace } from "@openmapx/core";
import { STORAGE_KEYS, useSession } from "@openmapx/core";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { idbDelete, idbGet, idbSet } from "@/lib/idbStore";

export const SAVED_PLACES_MIRROR_KEY = STORAGE_KEYS.savedPlacesMirror.key;
/** Version of the stored mirror record; a record of any other version is dropped. */
export const SAVED_PLACES_MIRROR_VERSION = 1;
const MIRROR_KEY = SAVED_PLACES_MIRROR_KEY;
const SAVED_QUERY_ROOTS = ["savedLists", "labeledPlaces", "savedListPlaces", "savedCheck"];

interface StoredSavedMirror extends SavedMirror {
  version: typeof SAVED_PLACES_MIRROR_VERSION;
}

interface SavedMirror {
  /** Owner of the mirror — so one user's saved data is never seeded for another. */
  userId?: string;
  lists?: SavedList[];
  labels?: LabeledPlace[];
  listPlaces?: Record<string, SavedPlace[]>;
}

/** Drop the cached saved-data queries (memory only). */
function removeSavedQueries(queryClient: QueryClient): void {
  for (const root of SAVED_QUERY_ROOTS) {
    queryClient.removeQueries({ queryKey: [root] });
  }
}

/** Drop the persisted mirror and the cached saved-data queries. */
function dropSavedCaches(queryClient: QueryClient): Promise<void> {
  removeSavedQueries(queryClient);
  return idbDelete(MIRROR_KEY);
}

/**
 * Whose saved data this device may show right now: the user id when signed in;
 * `null` once the server has answered that there is no session (signed out,
 * expired or revoked; a 401 counts); `undefined` while that is unknown because
 * the lookup is still pending or failed without an answer (offline, server
 * unreachable). Only `null` proves the previous owner has left.
 */
function sessionOwner(state: {
  data?: { user?: { id?: string } | null } | null;
  isPending?: boolean;
  error?: unknown;
}): string | null | undefined {
  const userId = state.data?.user?.id;
  if (userId) return userId;
  if (state.isPending) return undefined;
  if (state.error && (state.error as { status?: unknown }).status !== 401) return undefined;
  return null;
}

/**
 * Keeps the user's saved lists / places / labels usable offline. The saved-data
 * queries are server-only, so on a cold offline launch they'd otherwise be
 * empty. This mirrors each saved-places query into IndexedDB whenever it loads,
 * and seeds the query cache from that mirror on startup so the data renders
 * without a connection.
 *
 * The mirror is stamped with its owner's user id. It is seeded only for that
 * owner, or while the session is unknown (lookup pending or offline, when no
 * live session is available), so a single-user device still hydrates its own
 * last-known data offline. It is dropped, together with the cached saved-data
 * queries, as soon as the server confirms there is no session or a different
 * user signs in, so on a shared device one user can never see another's saved
 * places. Read-only offline — queuing offline edits for replay is a separate
 * follow-up.
 */
export function SavedPlacesMirror(): null {
  const queryClient = useQueryClient();
  const owner = sessionOwner(useSession());
  const prevOwnerRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prev = prevOwnerRef.current;
    prevOwnerRef.current = owner;
    // Only a known signed-in user's results are mirrored.
    const userId = typeof owner === "string" ? owner : null;

    let cancelled = false;
    const mirror: SavedMirror = {};
    const deletedListIds = new Set<string>();
    let writeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleWrite = () => {
      if (!userId || writeTimer) return;
      writeTimer = setTimeout(() => {
        writeTimer = null;
        mirror.userId = userId;
        const stored: StoredSavedMirror = { ...mirror, version: SAVED_PLACES_MIRROR_VERSION };
        void idbSet(MIRROR_KEY, stored);
      }, 1000);
    };

    const updateLists = (lists: SavedList[]) => {
      const retainedIds = new Set(lists.map((list) => list.id));
      for (const list of mirror.lists ?? []) {
        if (!retainedIds.has(list.id)) deletedListIds.add(list.id);
      }
      for (const id of retainedIds) deletedListIds.delete(id);
      mirror.lists = lists;
      for (const listId of Object.keys(mirror.listPlaces ?? {})) {
        if (deletedListIds.has(listId)) delete mirror.listPlaces?.[listId];
      }
    };

    const hydrate = async () => {
      // The server confirmed nobody is signed in, or the signed-in user changed:
      // the previous owner's saved data must not reach whoever uses the device next.
      if (owner === null || (typeof prev === "string" && prev !== owner)) {
        await dropSavedCaches(queryClient);
        return;
      }
      const record = await idbGet<Partial<StoredSavedMirror>>(MIRROR_KEY);
      if (cancelled || !record) return;
      if (record.version !== SAVED_PLACES_MIRROR_VERSION) {
        await idbDelete(MIRROR_KEY);
        return;
      }
      const { version: _version, ...stored } = record;
      // A known user only ever gets a mirror stamped with their own id.
      if (userId && stored.userId !== userId) {
        await dropSavedCaches(queryClient);
        return;
      }
      // Network results may have arrived while IndexedDB was reading. Preserve
      // current cache data before merging/seeding the older stored snapshot.
      const lists =
        queryClient.getQueryData<SavedList[]>(["savedLists"]) ?? mirror.lists ?? stored.lists;
      const labels =
        queryClient.getQueryData<LabeledPlace[]>(["labeledPlaces"]) ??
        mirror.labels ??
        stored.labels;
      const listPlaces = { ...stored.listPlaces, ...mirror.listPlaces };
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ["savedListPlaces"] })) {
        const id = query.queryKey[1];
        if (typeof id === "string" && query.state.data !== undefined) {
          listPlaces[id] = query.state.data as SavedPlace[];
        }
      }
      Object.assign(mirror, stored, { labels, listPlaces });
      if (lists) updateLists(lists);
      // Seed the cache only where it's still empty, so fresher network data is
      // never clobbered.
      if (mirror.lists && queryClient.getQueryData(["savedLists"]) === undefined) {
        queryClient.setQueryData(["savedLists"], mirror.lists);
      }
      if (mirror.labels && queryClient.getQueryData(["labeledPlaces"]) === undefined) {
        queryClient.setQueryData(["labeledPlaces"], mirror.labels);
      }
      for (const [listId, places] of Object.entries(mirror.listPlaces ?? {})) {
        if (queryClient.getQueryData(["savedListPlaces", listId]) === undefined) {
          queryClient.setQueryData(["savedListPlaces", listId], places);
        }
      }
      scheduleWrite();
    };
    void hydrate();

    // Mirror successful saved-places query results into IndexedDB.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!userId) return; // never mirror anonymous / 401 results
      // Observer changes, invalidations and GC carry old data, not fresh results.
      if (event.type !== "updated" || event.action.type !== "success") return;
      const key = event.query.queryKey;
      const root = key[0];
      if (root !== "savedLists" && root !== "labeledPlaces" && root !== "savedListPlaces") return;
      if (event.query.state.status !== "success") return;
      if (root === "savedLists") {
        updateLists(event.query.state.data as SavedList[]);
      } else if (root === "labeledPlaces") {
        mirror.labels = event.query.state.data as LabeledPlace[];
      } else if (typeof key[1] === "string") {
        // A late result for a deleted list must not revive its offline places.
        if (deletedListIds.has(key[1])) return;
        mirror.listPlaces = {
          ...(mirror.listPlaces ?? {}),
          [key[1]]: event.query.state.data as SavedPlace[],
        };
      }
      scheduleWrite();
    });

    return () => {
      cancelled = true;
      if (writeTimer) clearTimeout(writeTimer);
      unsubscribe();
      // This signed-in owner is ending (sign-out, account switch, impersonation).
      // Release their saved data from memory; the next instance decides about the
      // IndexedDB copy (kept offline for the same user, dropped otherwise).
      if (userId) removeSavedQueries(queryClient);
    };
  }, [queryClient, owner]);

  return null;
}
