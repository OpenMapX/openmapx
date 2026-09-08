import { readFile } from "node:fs/promises";
import { isRoutingRelevantBinding } from "@openmapx/core";
import { atomicWriteFile } from "../../utils/atomic-write.js";
import { type BoundCondition, type BoundSpan, spanKey } from "./conditions-to-edges.js";
import { decodeGraphId, type WayEdge } from "./ways-to-edges.js";

export interface SpanEdgesDeps {
  /** Base URL of the routing container, e.g. `http://valhalla:8002`. */
  valhallaUrl: string;
  waysToEdges: Map<number, WayEdge[]>;
  /** Test seam; production callers use the global `fetch`. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  /**
   * Wall-clock ceiling for one resolve pass. Tracing runs inline in the
   * live-traffic cycle, so an unreachable routing container must not be able
   * to stretch that cycle past its own cadence.
   */
  budgetMs?: number;
  logger?: { warn: (m: string, extra?: Record<string, unknown>) => void };
}

/** `spanKey` → accepted edges; `null` = traced but nothing accepted (whole-way fallback). */
export type SpanEdgeCache = Map<string, WayEdge[] | null>;

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CONCURRENCY = 4;
/**
 * Half the live-traffic cycle's 2-minute cadence, minus room for the fetch and
 * the write it shares that cycle with. Deliberately a constant and not an
 * operator knob: it protects an invariant (the live-speed write happens every
 * cycle), and lowering tracing throughput only costs precision — untraced
 * spans simply close their whole way.
 */
const SPAN_TRACE_BUDGET_MS = 30_000;

const TRACE_FILTER = [
  "edge.id",
  "edge.way_id",
  "edge.length",
  "matched.type",
  "matched.edge_index",
];

interface TraceResponse {
  edges?: Array<{ id?: number | string; way_id?: number }>;
  matched_points?: Array<{ type?: string; edge_index?: number }>;
}

export interface ResolveSpanEdgesResult {
  resolved: Map<string, WayEdge[]>;
  /** Spans a trace was dispatched for this pass. */
  traced: number;
  /**
   * Traced spans whose answer could not be obtained (transport failure). NOT
   * cached, so they are retried next cycle. A rising count means the routing
   * container is unhealthy, not that the spans are unmatchable.
   */
  unanswered: number;
  /** Traced spans Valhalla answered with nothing acceptable. Cached. */
  negative: number;
  /** Spans left untraced because the pass ran out of its time budget. Not cached. */
  skippedBudget: number;
  cacheHits: number;
}

/**
 * Asks Valhalla which of its edges the span geometry covers and keeps only
 * those the way→edge map lists for this way in the bound direction. The caller
 * closes the whole way in that direction (conservative) for anything but a
 * non-empty result.
 *
 * `null` is a verdict about the span — traced, nothing acceptable — and is
 * safe to cache. `undefined` means the question went unanswered (the routing
 * container was unreachable, slow, or returned something unusable), so the
 * span must be retried rather than remembered as untraceable.
 */
export async function traceSpanEdges(
  span: BoundSpan,
  deps: SpanEdgesDeps,
): Promise<WayEdge[] | null | undefined> {
  if (!span.geometry || span.geometry.length < 2) return null;
  const wayEdges = deps.waysToEdges.get(span.wayId);
  // Nothing to cross-check against, so nothing could be accepted anyway — do
  // not spend a routing request to learn that.
  if (!wayEdges || wayEdges.length === 0) return null;

  const doFetch = deps.fetch ?? fetch;
  const body = {
    shape: span.geometry.map(([lon, lat]) => ({ lat, lon })),
    costing: "auto",
    shape_match: "map_snap",
    trace_options: { search_radius: 30, gps_accuracy: 5 },
    filters: { attributes: TRACE_FILTER, action: "include" },
  };
  const url = `${deps.valhallaUrl.replace(/\/+$/, "")}/trace_attributes`;

  let data: TraceResponse;
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    // Every non-2xx is treated as "no answer": a 503 is plainly transient, and
    // even a 400 can come from a container that has not finished loading its
    // tiles. Caching either as a verdict would freeze the span into the
    // whole-way fallback for as long as the condition lives.
    if (!res.ok) return undefined;
    data = (await res.json()) as TraceResponse;
  } catch (err) {
    deps.logger?.warn("span-edges: trace request failed", {
      wayId: span.wayId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  const points = data.matched_points ?? [];
  const unmatched = points.filter((p) => p.type === "unmatched").length;
  // A trace whose points mostly failed to snap describes some other road.
  if (points.length > 0 && unmatched * 2 > points.length) return null;

  const forward = span.dir === "f";
  const accepted: WayEdge[] = [];
  const seen = new Set<string>();
  for (const edge of data.edges ?? []) {
    if (edge.id == null || Number(edge.way_id) !== span.wayId) continue;
    let decoded: { level: number; tile: number; index: number };
    try {
      decoded = decodeGraphId(BigInt(edge.id));
    } catch {
      continue;
    }
    const match = wayEdges.find(
      (candidate) =>
        candidate.level === decoded.level &&
        candidate.tile === decoded.tile &&
        candidate.index === decoded.index &&
        candidate.forward === forward,
    );
    if (!match) continue;
    const key = `${decoded.level}:${decoded.tile}:${decoded.index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push(match);
  }
  return accepted.length > 0 ? accepted : null;
}

/**
 * Resolves every routing-relevant span, tracing only cache misses with bounded
 * concurrency and a wall-clock budget. A traced-but-unmatched span is cached as
 * `null` (`negative`) so it is not re-traced on every cycle;
 * `saveSpanEdgeCache` drops the entry once the span stops being referenced. A
 * transport failure (`unanswered`) and a span dropped for want of budget
 * (`skippedBudget`) are NOT cached, so both are retried on the next cycle
 * instead of being pinned to the whole-way fallback by one bad minute. Never
 * throws — a span that cannot be resolved simply has no entry in `resolved`,
 * which the consumer reads as "close the whole way".
 */
export async function resolveSpanEdges(
  conditions: BoundCondition[],
  cache: SpanEdgeCache,
  deps: SpanEdgesDeps,
  trace: typeof traceSpanEdges = traceSpanEdges,
): Promise<ResolveSpanEdgesResult> {
  const resolved = new Map<string, WayEdge[]>();
  const todo: Array<{ key: string; span: BoundSpan }> = [];
  const queued = new Set<string>();
  let cacheHits = 0;

  for (const condition of conditions) {
    // Mirrors the consumer's skip rules so no request is spent on a span whose
    // condition never reaches the override map.
    if (!isRoutingRelevantBinding(condition.bindingStatus)) continue;
    if (condition.originKind !== "feed" && !condition.routingEligible) continue;
    for (const span of condition.segments) {
      const key = spanKey(condition.id, span);
      if (cache.has(key)) {
        cacheHits++;
        const hit = cache.get(key);
        if (hit && hit.length > 0) resolved.set(key, hit);
      } else if (!queued.has(key)) {
        queued.add(key);
        todo.push({ key, span });
      }
    }
  }

  let traced = 0;
  let unanswered = 0;
  let negative = 0;
  let cursor = 0;
  // Checked before DISPATCH only: a request already in flight keeps its own
  // per-request timeout rather than being cut mid-answer.
  const deadline = Date.now() + (deps.budgetMs ?? SPAN_TRACE_BUDGET_MS);
  const worker = async (): Promise<void> => {
    while (cursor < todo.length) {
      if (Date.now() >= deadline) return;
      const item = todo[cursor++];
      if (!item) break;
      traced++;
      let edges: WayEdge[] | null | undefined;
      try {
        edges = await trace(item.span, deps);
      } catch (err) {
        deps.logger?.warn("span-edges: trace threw", {
          wayId: item.span.wayId,
          err: err instanceof Error ? err.message : String(err),
        });
        edges = undefined;
      }
      // Unanswered: leave the cache untouched so the next cycle asks again.
      if (edges === undefined) {
        unanswered++;
        continue;
      }
      // `null` is the canonical negative, so an empty array stores as one.
      const accepted = edges !== null && edges.length > 0 ? edges : null;
      cache.set(item.key, accepted);
      if (accepted) resolved.set(item.key, accepted);
      else negative++;
    }
  };
  const workers = Math.min(Math.max(deps.concurrency ?? DEFAULT_CONCURRENCY, 1), todo.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { resolved, traced, unanswered, negative, skippedBudget: todo.length - traced, cacheHits };
}

function parseCachedEdges(value: unknown): WayEdge[] | null {
  if (!Array.isArray(value)) return null;
  const edges: WayEdge[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const edge = entry as Record<string, unknown>;
    if (
      typeof edge.forward !== "boolean" ||
      !Number.isInteger(edge.level) ||
      !Number.isInteger(edge.tile) ||
      !Number.isInteger(edge.index)
    ) {
      return null;
    }
    edges.push({
      forward: edge.forward,
      level: edge.level as number,
      tile: edge.tile as number,
      index: edge.index as number,
    });
  }
  // An empty array would read as "traced, nothing accepted" anyway; store the
  // canonical negative form so the cache has one representation for it.
  return edges.length > 0 ? edges : null;
}

/** Reads the persisted cache; a missing or unreadable file simply means "cold". */
export async function loadSpanEdgeCache(path: string): Promise<SpanEdgeCache> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
  const cache: SpanEdgeCache = new Map();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (value !== null && !Array.isArray(value)) continue;
    cache.set(key, value === null ? null : parseCachedEdges(value));
  }
  return cache;
}

/** Persists only the keys still referenced this cycle, so lifted closures fall out of the cache. */
export async function saveSpanEdgeCache(
  path: string,
  cache: SpanEdgeCache,
  keepKeys: Iterable<string>,
): Promise<void> {
  const out: Record<string, WayEdge[] | null> = {};
  for (const key of keepKeys) {
    if (cache.has(key)) out[key] = cache.get(key) ?? null;
  }
  await atomicWriteFile(path, JSON.stringify(out), {
    durability: "visibility",
    createParentDirectory: true,
  });
}
