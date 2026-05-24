import type { PoiIngestKind } from "./types.js";

/**
 * Per-`(sourceId, kind)` in-process single-flight lock for POI ingests.
 *
 * The lock granularity is deliberately `(sourceId, kind)` — not `sourceId` —
 * because static and live pipelines for the same source touch disjoint
 * resources (Postgres staging table vs Redis hash) and there is no reason to
 * serialise them. Table-level safety against torn writes is provided by the
 * DROP+RENAME swap inside a transaction in `stages/swap.ts`; this lock just
 * stops two concurrent runs of the same (id, kind) from racing in this
 * process.
 *
 * No DB rows are inserted here — B3 will add audit rows in
 * `data_manager.jobs` around this controller.
 */

export interface PoiInflight {
  sourceId: string;
  kind: PoiIngestKind;
  startedAt: Date;
}

export type PoiTryAcquireResult =
  | { ok: true }
  | { ok: false; reason: "in-flight"; existing: PoiInflight };

export interface PoiSingleFlight {
  tryAcquire(sourceId: string, kind: PoiIngestKind): PoiTryAcquireResult;
  release(sourceId: string, kind: PoiIngestKind): void;
  getInflight(sourceId: string, kind: PoiIngestKind): PoiInflight | null;
  listInflight(): PoiInflight[];
}

export interface CreatePoiSingleFlightOptions {
  /** Test seam — `Date.now()` indirection. */
  now?: () => number;
}

function lockKey(sourceId: string, kind: PoiIngestKind): string {
  return `${sourceId}:${kind}`;
}

export function createPoiSingleFlight(opts: CreatePoiSingleFlightOptions = {}): PoiSingleFlight {
  const now = opts.now ?? Date.now;
  const locks = new Map<string, PoiInflight>();

  function tryAcquire(sourceId: string, kind: PoiIngestKind): PoiTryAcquireResult {
    const key = lockKey(sourceId, kind);
    const existing = locks.get(key);
    if (existing) {
      return { ok: false, reason: "in-flight", existing: { ...existing } };
    }
    const inflight: PoiInflight = { sourceId, kind, startedAt: new Date(now()) };
    locks.set(key, inflight);
    return { ok: true };
  }

  function release(sourceId: string, kind: PoiIngestKind): void {
    locks.delete(lockKey(sourceId, kind));
  }

  function getInflight(sourceId: string, kind: PoiIngestKind): PoiInflight | null {
    const entry = locks.get(lockKey(sourceId, kind));
    return entry ? { ...entry } : null;
  }

  function listInflight(): PoiInflight[] {
    return Array.from(locks.values(), (entry) => ({ ...entry }));
  }

  return { tryAcquire, release, getInflight, listInflight };
}
