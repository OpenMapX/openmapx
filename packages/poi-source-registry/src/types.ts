/** Bounding box: [west, south, east, north] (lng/lat). */
export type BBox = readonly [number, number, number, number];

/** Canonical row produced by a parser and persisted to poi_ingest.<table>. */
export interface PoiRow {
  /** Source-local stable identifier (no prefix). The reader emits stationIdPrefix + poiId externally. */
  poiId: string;
  /** WGS84 longitude. */
  lng: number;
  /** WGS84 latitude. */
  lat: number;
  /** Source-specific payload — persisted as jsonb. */
  payload: Record<string, unknown>;
}

/** Live state for one POI — value of the per-source Redis hash field. */
export interface PoiLiveState {
  /** ISO 8601 timestamp from the upstream feed. */
  asOf: string;
  /** Arbitrary live fields (free spaces, occupancy %, status, etc.). */
  [key: string]: unknown;
}

/** Logger handed to resolveUrl/parse callbacks. */
export interface PoiSourceLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/** HTTP fetch spec. Auth is resolved by data-manager's secrets client. */
export interface PoiHttpFetchSpec {
  type: "http";
  url?: string;
  timeoutMs?: number;
  encoding?: BufferEncoding | "windows-1252";
  headers?: Record<string, string>;
  /**
   * Optional async header resolver. Runs at fetch time inside data-manager,
   * receives the source logger, returns headers to merge with `headers`
   * above (resolved values win on conflict). Use cases: HTTP Basic / Bearer
   * built from per-source env vars (UTMC, NSW, DB BahnPark, etc.).
   */
  resolveHeaders?: (log: PoiSourceLogger) => Promise<Record<string, string>>;
}
export type PoiFetchSpec = PoiHttpFetchSpec;

/** Streaming parser. Returns rows lazily so large CSVs don't buffer fully in memory. */
export type PoiStaticParseFn = (
  buffer: Buffer,
  ctx: { log: PoiSourceLogger },
) => AsyncIterable<PoiRow> | Iterable<PoiRow>;

/** Live parser. Returns full snapshot — caller wraps in a single Redis MULTI. */
export type PoiLiveParseFn = (
  buffer: Buffer,
  ctx: { log: PoiSourceLogger },
) => Promise<Map<string, PoiLiveState>> | Map<string, PoiLiveState>;

/** Bundled parser — one fetch, both outputs. */
export type PoiBundledParseFn = (
  buffer: Buffer,
  ctx: { log: PoiSourceLogger },
) =>
  | Promise<{ static: PoiRow[]; live: Map<string, PoiLiveState> }>
  | { static: PoiRow[]; live: Map<string, PoiLiveState> };

export type PoiValidateFn = (
  rows: readonly PoiRow[],
) => { ok: true } | { ok: false; error: string };

export interface StaticPoiSpec {
  cron: string;
  /** Dynamic URLs (e.g. BNetzA CSV path changes). Optional — falls back to fetch.url. */
  resolveUrl?: (log: PoiSourceLogger) => Promise<string>;
  fetch: PoiFetchSpec;
  parse: PoiStaticParseFn;
  validate?: PoiValidateFn;
  /** Reject ingests with fewer rows than this. Defaults to 1. */
  minRowCount?: number;
}

export interface LivePoiSpec {
  cron: string;
  resolveUrl?: (log: PoiSourceLogger) => Promise<string>;
  fetch: PoiFetchSpec;
  parse: PoiLiveParseFn;
  /** Redis EXPIRE TTL. Default = 5× the cron interval. */
  ttlSeconds?: number;
}

export interface BundledPoiSpec {
  cron: string;
  resolveUrl?: (log: PoiSourceLogger) => Promise<string>;
  fetch: PoiFetchSpec;
  parse: PoiBundledParseFn;
  /** Skip the static table swap if the hash matches the previous run. */
  staticChangeKey?: (rows: readonly PoiRow[]) => string;
  liveTtlSeconds?: number;
  staticValidate?: PoiValidateFn;
  staticMinRowCount?: number;
}

export interface PoiSourceCommon {
  /** Registry id — table name, Redis hash key, admin label. e.g. "bnetza-ev". */
  id: string;
  /** Prefix on emitted user-facing station IDs. Defaults to `${id}:`. */
  stationIdPrefix?: string;
  /** Domain bucket: "ev-charging" | "parking" | future ones. */
  domain: string;
  name: string;
  /** Optional perf short-circuit: skip the DB roundtrip when the request bbox is outside. */
  coverage?: BBox;
  /** sourceId in the integration's manifest dataSources. Defaults to id. */
  attributionSourceId?: string;
}

export type PoiSource =
  | (PoiSourceCommon & { static: StaticPoiSpec; live?: LivePoiSpec; bundled?: never })
  | (PoiSourceCommon & { bundled: BundledPoiSpec; static?: never; live?: never });
