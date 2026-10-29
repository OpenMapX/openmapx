/**
 * A provider's read-only operational snapshot of the feeds behind it, for
 * the coverage report. Fetching it must never poll an original feed.
 */
export interface OperationalEvidence {
  schemaVersion: 1;
  collectedAt: string;
  instanceId: string;
  truncated?: boolean;
  feeds: OperationalFeedEvidence[];
}

export interface OperationalFeedEvidence {
  sourceId: string;
  /** The feed's display name. */
  name?: string;
  parentSourceId?: string;
  lastAttemptAt: string | null;
  lastOutcome: string | null;
  lastSuccessfulCheckAt: string | null;
  lastPublicationAt: string | null;
  publicationRevision: string | null;
  upstreamAsOf: string | null;
  freshUntil: string | null;
  expectedIntervalSeconds: number | null;
  activeEventCount: number | null;
  changedCount: number | null;
  rejectedCount: number | null;
  consecutiveFailures: number | null;
  error: string | null;
  bindingCounts: Record<string, number> | null;
  /** Why current bindings were not bound or were kept off routing, by status and reason. */
  bindingReasons?: OperationalBindingReason[];
  graph: {
    generation: string | null;
    status: "ready" | "partial" | "missing" | "unknown";
    regions: string[];
  };
  /**
   * Where the feed's places and readings are, set by providers of places
   * (charging, parking, fuel); an empty list when it holds none now. An
   * on-demand feed always lists its places where its catalogue entry places
   * it, records or not: it fetches them as reads ask.
   */
  coverage?: OperationalFeedCoverage[];
  status: string;
  action: string | null;
}

/**
 * How many of a feed's current bindings carry one reason under one status:
 * `situations` counts situations' own locations, `effects` effects bound on
 * their own. Reasons are the producer's machine codes (`no_candidates`,
 * `direction_undecided`, …); a reader labels the ones it knows.
 */
export interface OperationalBindingReason {
  status: string;
  reason: string;
  situations: number;
  effects: number;
}

export interface OperationalFeedCoverage {
  /** `static` for the places themselves, `live` for the readings about them. */
  stream: "static" | "live";
  /** Fetched whole (`bulk`) or cell by cell as reads ask for an area (`on_demand`). */
  accessMode: "bulk" | "on_demand";
  /** ISO 3166-1 alpha-2 codes of the countries. */
  countries: string[];
  /**
   * Whether the feed holds each of `countries` whole: a bulk feed with
   * records country-wide. A feed of one subdivision, or an on-demand feed,
   * holds part of it.
   */
  whole: boolean;
  /**
   * `observed` from the live records; `declared` when the catalogue entry
   * names a country or an area.
   */
  basis: "observed" | "declared";
  /**
   * The area the catalogue entry says an on-demand feed applies in,
   * `[west, south, east, north]`; a global feed's spans the world.
   */
  bbox?: [number, number, number, number];
}
