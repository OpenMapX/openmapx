"use client";

import type { LabeledPlace, SavedList, SavedPlace } from "@openmapx/core";
import { useSession } from "@openmapx/core";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { idbDelete, idbGet, idbSet } from "@/lib/idbStore";

const MIRROR_KEY = "omx-saved-mirror";
const SAVED_QUERY_ROOTS = ["savedLists", "labeledPlaces", "savedListPlaces", "savedCheck"];

interface SavedMirror {
  /** Owner of the mirror — so one user's saved data is never seeded for another. */
  userId?: string;
  lists?: SavedList[];
  labels?: LabeledPlace[];
  listPlaces?: Record<string, SavedPlace[]>;
}

/** Drop the persisted mirror and the cached saved-data queries. */
function dropSavedCaches(queryClient: QueryClient): Promise<void> {
  for (const root of SAVED_QUERY_ROOTS) {
    queryClient.removeQueries({ queryKey: [root] });
  }
  return idbDelete(MIRROR_KEY);
}

/**
 * Keeps the user's saved lists / places / labels usable offline. The saved-data
 * queries are server-only, so on a cold offline launch they'd otherwise be
 * empty. This mirrors each saved-places query into IndexedDB whenever it loads,
 * and seeds the query cache from that mirror on startup so the data renders
 * without a connection.
 *
 * The mirror is stamped with its owner's user id and dropped whenever the
 * session user changes or signs out, so on a shared device one user can never
 * see another's saved places. It deliberately does NOT gate offline hydration on
 * a live session (which isn't available offline) — a single-user device hydrates
 * its own last-known data; a different known user wipes it. Read-only offline —
 * queuing offline edits for replay is a separate follow-up.
 */
export function SavedPlacesMirror(): null {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const userId = session?.user?.id ?? null;
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const prev = prevUserIdRef.current;
    prevUserIdRef.current = userId;

    let cancelled = false;
    const mirror: SavedMirror = {};
    let writeTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleWrite = () => {
      if (!userId || writeTimer) return;
      writeTimer = setTimeout(() => {
        writeTimer = null;
        mirror.userId = userId;
        void idbSet(MIRROR_KEY, mirror);
      }, 1000);
    };

    const hydrate = async () => {
      // A signed-in user just signed out or switched accounts — drop the prior
      // user's mirror + cached saved data so it can't leak into the next session.
      if (prev && prev !== userId) {
        await dropSavedCaches(queryClient);
        return;
      }
      const stored = await idbGet<SavedMirror>(MIRROR_KEY);
      if (cancelled || !stored) return;
      // The persisted mirror belongs to a different (now-known) user.
      if (userId && stored.userId && stored.userId !== userId) {
        await dropSavedCaches(queryClient);
        return;
      }
      Object.assign(mirror, stored);
      // Seed the cache only where it's still empty, so fresher network data is
      // never clobbered.
      if (stored.lists && queryClient.getQueryData(["savedLists"]) === undefined) {
        queryClient.setQueryData(["savedLists"], stored.lists);
      }
      if (stored.labels && queryClient.getQueryData(["labeledPlaces"]) === undefined) {
        queryClient.setQueryData(["labeledPlaces"], stored.labels);
      }
      for (const [listId, places] of Object.entries(stored.listPlaces ?? {})) {
        if (queryClient.getQueryData(["savedListPlaces", listId]) === undefined) {
          queryClient.setQueryData(["savedListPlaces", listId], places);
        }
      }
    };
    void hydrate();

    // Mirror successful saved-places query results into IndexedDB.
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!userId) return; // never mirror anonymous / 401 results
      const key = event.query.queryKey;
      const root = key[0];
      if (root !== "savedLists" && root !== "labeledPlaces" && root !== "savedListPlaces") return;
      if (event.query.state.status !== "success") return;
      if (root === "savedLists") {
        mirror.lists = event.query.state.data as SavedList[];
      } else if (root === "labeledPlaces") {
        mirror.labels = event.query.state.data as LabeledPlace[];
      } else if (typeof key[1] === "string") {
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
    };
  }, [queryClient, userId]);

  return null;
}
