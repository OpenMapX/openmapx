"use client";
import { useContext, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { AdminDraftContext } from "./AdminDraftProvider";
import { AdminDraftStore } from "./adminDraftStore";

type Values = Record<string, unknown>;
export function useAdminDraft({
  id,
  baseline,
  editableKeys,
  signature,
  ready = true,
}: {
  id: string;
  baseline: Values;
  editableKeys: readonly string[];
  signature: string;
  ready?: boolean;
}) {
  const shared = useContext(AdminDraftContext);
  const [local] = useState(() => new AdminDraftStore());
  const store = shared ?? local;
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const generation = store.generation;
  const entryId = JSON.stringify([id, signature]);
  const baselineKey = JSON.stringify(baseline),
    keys = JSON.stringify(editableKeys);
  useLayoutEffect(() => {
    if (!ready) return;
    store.reconcile(entryId, JSON.parse(baselineKey), JSON.parse(keys), generation);
  }, [store, entryId, baselineKey, keys, generation, ready]);
  const snapshot = store.read(entryId);
  // On the first render only, before the layout reconciliation, show the fresh allowlist.
  const values = {
    ...Object.fromEntries(Object.entries(baseline).filter(([key]) => editableKeys.includes(key))),
    ...snapshot.values,
  };
  return {
    values,
    dirty: snapshot.dirtyKeys.length > 0,
    dirtyKeys: snapshot.dirtyKeys,
    conflicts: snapshot.conflicts,
    setValues(next: Values | ((previous: Values) => Values)) {
      if (!store.has(entryId))
        store.reconcile(entryId, JSON.parse(baselineKey), JSON.parse(keys), generation);
      store.update(
        entryId,
        typeof next === "function" ? next(store.read(entryId).values) : next,
        generation,
      );
    },
    discard: (keys?: readonly string[]) => store.discard(entryId, keys),
    keepEdits: (keys?: readonly string[]) => store.keepEdits(entryId, keys),
    acknowledge: (submitted: Values) => store.acknowledge(entryId, submitted, generation),
  };
}
