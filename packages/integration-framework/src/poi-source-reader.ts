import { feedIdSchema } from "@openmapx/core";
import { type BBox, type PoiLiveState, poiLiveHashKey } from "@openmapx/poi-source-registry";
import type { IntegrationContext } from "./context.js";

const MAX_ROWS_PER_BBOX = 2000;
const TABLE_MISSING_PG_CODE = "42P01";

// Cold-start tracking: a missing ingest table is the normal pre-first-ingest
// state. The Set serves two purposes:
//   1. Warn-once-per-source — during boot every provider would spam the same
//      warning on each request, so we only log the first miss per source.
//   2. Cold-start signal — exposed via `isInColdStart` so the data-source
//      providers can flip `freshness.isStale=true` on the wrapped result
//      without inspecting per-domain fields.
// Process-scoped so a long-running host warns once + reports cold-start once
// per source no matter how many reader instances exist. Tests reset via
// `__resetReaderState`.
const coldStartSources = new Set<string>();
// Warn-once tracking for the "integration registered POI sources but its
// manifest didn't declare requires postgis, so ctx.db is undefined" case.
// Without this warning the reader silently returns [] forever and the
// integration looks like it's working — but no data ever surfaces.
const noDbWarnedSources = new Set<string>();

/** @internal Test-only helper. Resets the cold-start tracker between tests. */
export function __resetReaderState(): void {
  coldStartSources.clear();
  noDbWarnedSources.clear();
}

/**
 * Returns true if a search or fetchDetail call for this source most recently
 * cold-started (table missing in PostGIS). Set on first 42P01 and stays true
 * for the lifetime of the process — once an ingest succeeds, restart the
 * process or call __resetReaderState() to clear (the reader has no way to
 * know the table is now present without retrying, and we don't want a busy
 * loop on the request path).
 */
export function isInColdStart(sourceId: string): boolean {
  return coldStartSources.has(sourceId);
}

/**
 * Returns true if the live state's asOf timestamp is older than the given
 * threshold. Use in mergeXLive helpers to flip hasRealtimeData=false when
 * the upstream is stale, even if Redis still has the value cached.
 */
export function isLiveTooStale(live: PoiLiveState | null, maxAgeMs: number): boolean {
  if (!live) return false;
  const asOfMs = Date.parse(live.asOf);
  if (!Number.isFinite(asOfMs)) return true;
  return Date.now() - asOfMs > maxAgeMs;
}

export interface PoiReader<TResult> {
  search(ctx: IntegrationContext, bbox: BBox): Promise<TResult[]>;
  fetchDetail(ctx: IntegrationContext, poiId: string): Promise<TResult | null>;
}

export interface StaticPoiReaderOptions<TResult> {
  /** Registry id of the source (e.g. "bnetza-ev"). Drives table + Redis key naming. */
  sourceId: string;
  /** Maps the static jsonb payload + bare poi_id back to the provider's domain entity. */
  mapStatic: (poiId: string, payload: unknown) => TResult;
  /** Optional fast-path bbox short-circuit. */
  coverage?: BBox;
}

export interface TwoTierPoiReaderOptions<TResult> extends StaticPoiReaderOptions<TResult> {
  /** Merges live Redis state into the base static entity. Called once per result. */
  mergeWithLive: (base: TResult, live: PoiLiveState | null) => TResult;
}

interface StaticRow {
  poi_id: string;
  payload: unknown;
}

function assertValidSourceId(sourceId: string): void {
  if (!feedIdSchema.safeParse(sourceId).success) {
    throw new Error(
      `createPoiReader: sourceId "${sourceId}" must be a valid feed id (lowercase, hyphen-separated, table-name-safe)`,
    );
  }
}

// postgres-js parameterises *values*, not identifiers. The registry validator
// already constrains source ids via feedIdSchema, so the dash→underscore
// rewrite is sufficient to make a safe identifier — but we re-check at factory
// time so an unvalidated id can't sneak through into raw SQL.
function tableIdentFor(sourceId: string): string {
  return `poi_ingest."${sourceId.replace(/-/g, "_")}_static"`;
}

function bboxIntersects(a: BBox, b: BBox): boolean {
  // BBox tuple is [west, south, east, north]. Boxes intersect iff neither is
  // strictly outside the other on any axis.
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function isTableMissingError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === TABLE_MISSING_PG_CODE;
}

function warnMissingTableOnce(ctx: IntegrationContext, sourceId: string, tableIdent: string): void {
  if (coldStartSources.has(sourceId)) return;
  coldStartSources.add(sourceId);
  ctx.log.warn(
    `[poi-source-reader] ${sourceId}: table ${tableIdent} is missing — returning empty result. ` +
      `This is normal before the first ingest run; subsequent misses will not re-warn.`,
  );
}

function warnNoDbOnce(ctx: IntegrationContext, sourceId: string): void {
  if (noDbWarnedSources.has(sourceId)) return;
  noDbWarnedSources.add(sourceId);
  ctx.log.warn(
    `[poi-source-reader] ${sourceId}: ctx.db is undefined — returning empty result. ` +
      `The integration registered a POI source but its manifest.json does not declare ` +
      `requires: [{ service: "postgis" }], so the host did not wire up a database client. ` +
      `Add postgis to the integration's requires list to enable PoiReader-backed sources.`,
  );
}

async function runSearchQuery(
  ctx: IntegrationContext,
  sourceId: string,
  bbox: BBox,
): Promise<StaticRow[]> {
  if (!ctx.db) {
    warnNoDbOnce(ctx, sourceId);
    return [];
  }
  const tableIdent = tableIdentFor(sourceId);
  try {
    const rows = await ctx.db.execute<StaticRow[]>(
      `SELECT poi_id, payload FROM ${tableIdent}
       WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
         AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
       LIMIT $5`,
      [bbox[0], bbox[1], bbox[2], bbox[3], MAX_ROWS_PER_BBOX],
    );
    return normaliseRows((rows ?? []) as unknown as StaticRow[]);
  } catch (err) {
    if (isTableMissingError(err)) {
      warnMissingTableOnce(ctx, sourceId, tableIdent);
      return [];
    }
    throw err;
  }
}

// postgres-js's `sql.unsafe(query, params)` runs in simple-query mode and
// returns jsonb columns as raw JSON strings rather than auto-parsed objects.
// apps/api's IntegrationContext.db.execute wraps `unsafe`, so we parse here
// at the reader boundary rather than make every mapper handle both shapes.
function normaliseRows(rows: StaticRow[]): StaticRow[] {
  for (const row of rows) {
    if (typeof row.payload === "string") {
      try {
        row.payload = JSON.parse(row.payload);
      } catch {
        // Leave as string — the mapper will treat it as opaque + return defaults.
      }
    }
  }
  return rows;
}

async function runDetailQuery(
  ctx: IntegrationContext,
  sourceId: string,
  poiId: string,
): Promise<StaticRow | null> {
  if (!ctx.db) {
    warnNoDbOnce(ctx, sourceId);
    return null;
  }
  const tableIdent = tableIdentFor(sourceId);
  try {
    const rows = await ctx.db.execute<StaticRow[]>(
      `SELECT poi_id, payload FROM ${tableIdent} WHERE poi_id = $1 LIMIT 1`,
      [poiId],
    );
    const list = normaliseRows((rows ?? []) as unknown as StaticRow[]);
    return list.length > 0 ? (list[0] as StaticRow) : null;
  } catch (err) {
    if (isTableMissingError(err)) {
      warnMissingTableOnce(ctx, sourceId, tableIdent);
      return null;
    }
    throw err;
  }
}

function coerceLiveState(value: unknown): PoiLiveState | null {
  // The host's hmget already JSON-decodes; defensively reject anything that
  // isn't a non-null object so malformed/stale fields don't reach mergeWithLive.
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return null;
  return value as PoiLiveState;
}

export function createStaticPoiReader<TResult>(
  opts: StaticPoiReaderOptions<TResult>,
): PoiReader<TResult> {
  assertValidSourceId(opts.sourceId);
  const { sourceId, mapStatic, coverage } = opts;

  return {
    async search(ctx, bbox) {
      if (coverage && !bboxIntersects(bbox, coverage)) return [];
      const rows = await runSearchQuery(ctx, sourceId, bbox);
      return rows.map((r) => mapStatic(r.poi_id, r.payload));
    },
    async fetchDetail(ctx, poiId) {
      const row = await runDetailQuery(ctx, sourceId, poiId);
      return row ? mapStatic(row.poi_id, row.payload) : null;
    },
  };
}

export function createTwoTierPoiReader<TResult>(
  opts: TwoTierPoiReaderOptions<TResult>,
): PoiReader<TResult> {
  assertValidSourceId(opts.sourceId);
  const { sourceId, mapStatic, mergeWithLive, coverage } = opts;
  // Shared Redis hash key with services/data-manager's `write-live` stage —
  // both sides use `poiLiveHashKey` from @openmapx/poi-source-registry so
  // they can never drift.
  const hashKey = poiLiveHashKey(sourceId);

  return {
    async search(ctx, bbox) {
      if (coverage && !bboxIntersects(bbox, coverage)) return [];
      const rows = await runSearchQuery(ctx, sourceId, bbox);
      if (rows.length === 0) return [];
      const bases = rows.map((r) => ({
        id: r.poi_id,
        base: mapStatic(r.poi_id, r.payload),
      }));

      let live: (PoiLiveState | null)[] = [];
      try {
        const raw = await ctx.liveStore.hmget<unknown>(
          hashKey,
          bases.map((b) => b.id),
        );
        live = raw.map((v) => coerceLiveState(v));
      } catch {
        // Cache unavailable: degrade gracefully to base entities.
        live = bases.map(() => null);
      }

      return bases.map((b, i) => mergeWithLive(b.base, live[i] ?? null));
    },
    async fetchDetail(ctx, poiId) {
      const row = await runDetailQuery(ctx, sourceId, poiId);
      if (!row) return null;
      const base = mapStatic(row.poi_id, row.payload);
      let liveValue: PoiLiveState | null = null;
      try {
        const raw = await ctx.liveStore.hmget<unknown>(hashKey, [poiId]);
        liveValue = coerceLiveState(raw[0]);
      } catch {
        liveValue = null;
      }
      return mergeWithLive(base, liveValue);
    },
  };
}
