"use client";

import {
  hashKey,
  type QueryKey,
  type QueryObserverResult,
  type QueryState,
  useQueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";

export interface RequestGateOptions {
  /** False disables every request and forgets what was admitted. */
  active: boolean;
  /** Requests kept unanswered at once. */
  concurrency: number;
  /** Whether a request's cached state lets it join at once, without a slot (and so without a fetch). */
  ready: (state: QueryState | undefined, now: number) => boolean;
}

/**
 * Which of a list of queries may run: a query joins at once when its cached
 * state is `ready`, else while fewer than `concurrency` admitted queries are
 * unanswered, in list order. A joined query stays enabled, because turning it
 * off and on again would refetch it outside the gate; it is unanswered until
 * it has an answer or an error newer than the moment it joined, or while
 * anything is fetching for it. States are read from the cache during render,
 * so the render after any query settles already sees it. Callers turn off
 * the refetches on focus, reconnect and (as they need) mount themselves.
 */
export function useRequestGate(
  keys: readonly QueryKey[],
  { active, concurrency, ready }: RequestGateOptions,
): boolean[] {
  const client = useQueryClient();
  const admitted = useRef(new Map<string, number>());
  if (!active) {
    admitted.current.clear();
    return keys.map(() => false);
  }
  const now = Date.now();
  const hashes = keys.map((key) => hashKey(key));
  const listed = new Set(hashes);
  for (const hash of admitted.current.keys()) {
    if (!listed.has(hash)) admitted.current.delete(hash);
  }
  const states = keys.map((key) => client.getQueryState(key));
  const unanswered = (index: number, since: number) => {
    const state = states[index];
    const answeredAt = Math.max(state?.dataUpdatedAt ?? 0, state?.errorUpdatedAt ?? 0);
    return (
      state === undefined ||
      state.status === "pending" ||
      state.fetchStatus === "fetching" ||
      answeredAt < since
    );
  };
  // Counted over every admitted query first: one listed ahead of a query
  // already in flight must not open an extra slot.
  let busy = 0;
  for (const [index, hash] of hashes.entries()) {
    const since = admitted.current.get(hash);
    if (since !== undefined && unanswered(index, since)) busy++;
  }
  return hashes.map((hash, index) => {
    if (!admitted.current.has(hash)) {
      if (ready(states[index], now)) admitted.current.set(hash, 0);
      else if (busy < concurrency) {
        admitted.current.set(hash, now);
        busy++;
      }
    }
    return admitted.current.has(hash);
  });
}

/** What a gated `useQueries` reports, in a shape that re-renders when any fetch starts or ends. */
export function combineGatedQueries<T>(results: QueryObserverResult<T>[]) {
  return {
    data: results.map((r) => r.data),
    statuses: results.map((r) => r.status),
    // Observed so a refetch that starts or ends re-renders and re-runs the gate.
    fetchStatuses: results.map((r) => r.fetchStatus),
    refetches: results.map((r) => r.refetch),
  };
}

/** The same array for as long as every element is the same object. */
export function useElementwiseStable<T>(values: T[]): T[] {
  const ref = useRef(values);
  if (ref.current.length !== values.length || values.some((v, i) => v !== ref.current[i])) {
    ref.current = values;
  }
  return ref.current;
}
