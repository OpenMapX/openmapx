import type {
  OperationalEvidence,
  OperationalFeedCoverage,
  OperationalFeedEvidence,
} from "@openmapx/integration-framework";
import type { OpenConditionsClient } from "../client.js";
import type { SourceScopes } from "../sources.js";

const MAX_OPERATIONAL_FEEDS = 500;

/** The OpenConditions domains whose feeds hold places. */
export type SiteDomain = "charging" | "parking" | "fuel" | "cameras";

/** The feature kind of each place domain's places. */
const SITE_KINDS: Readonly<Record<SiteDomain, string>> = {
  charging: "charging_site",
  parking: "parking_site",
  fuel: "fuel_station",
  cameras: "camera",
};

/**
 * The prefix of the properties of each place domain's readings. Cameras are
 * the `cameras` ingest domain but their readings are the model's `camera.*`.
 */
const PROPERTY_PREFIXES: Readonly<Record<SiteDomain, string>> = {
  charging: "charging.",
  parking: "parking.",
  fuel: "fuel.",
  cameras: "camera.",
};

type RawGraphStatus = {
  generation?: unknown;
  status?: unknown;
  regions?: unknown;
};

type RawFeedStatus = Record<string, unknown> & { id?: unknown; parentSourceId?: unknown };

/** A `GET /feeds/status` answer. */
export type RawOperationalStatus = {
  collectedAt?: unknown;
  instanceId?: unknown;
  graph?: RawGraphStatus;
  feeds?: RawFeedStatus[];
};

/** One `GET /coverage` row, as far as the place evidence reads it. */
interface CoverageRow {
  country: string | null;
  subdivision: string | null;
  class: string;
  kind: string;
  property?: string;
  accessMode: "bulk" | "on_demand";
  sources: string[];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A publication revision; OpenConditions counts from 0, which no publication has. */
function revisionOf(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? String(value) : null;
  return stringOrNull(value);
}

function graphOf(raw: RawGraphStatus | undefined): OperationalFeedEvidence["graph"] {
  const status = raw?.status;
  return {
    generation: stringOrNull(raw?.generation),
    status:
      status === "ready" || status === "partial" || status === "missing" || status === "unknown"
        ? status
        : "unknown",
    regions: Array.isArray(raw?.regions)
      ? raw.regions.filter((region): region is string => typeof region === "string")
      : [],
  };
}

/**
 * What the feed needs, if anything. A road feed's events route only once the
 * segment graph they bind to is imported; places need no graph.
 */
function operationalState(
  feed: RawFeedStatus,
  graph: OperationalFeedEvidence["graph"] | null,
  collectedAt: string,
): Pick<OperationalFeedEvidence, "status" | "action"> {
  if (feed.selectionState === "discovered")
    return { status: "discovered", action: "approve_source" };
  if (feed.hasCredentials === false)
    return { status: "missing_configuration", action: "configure_credentials" };
  if (graph && graph.status !== "ready")
    return { status: `graph_${graph.status}`, action: "import_graph" };
  if (feed.lastOutcome === "failed" || (numberOrNull(feed.consecutiveFailures) ?? 0) > 0) {
    return { status: "failed", action: "investigate_poll_failures" };
  }
  const freshUntil = stringOrNull(feed.freshnessDeadline);
  if (freshUntil && Date.parse(freshUntil) <= Date.parse(collectedAt)) {
    return { status: "stale", action: "refresh_source" };
  }
  if (stringOrNull(feed.lastNetworkSuccessAt)) return { status: "healthy", action: null };
  return { status: "unknown", action: null };
}

function bindingCounts(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

function changedCount(feed: RawFeedStatus): number | null {
  const values = [feed.lastInserted, feed.lastUpdated, feed.lastDeleted].map(numberOrNull);
  return values.every((value) => value == null)
    ? null
    : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

/**
 * The operational evidence of the feeds of one OpenConditions `domain` in a
 * `/feeds/status` answer. Road feeds are judged with the segment graph;
 * `coverage`, given for the place domains, says where each feed's places
 * and readings are. A feed the catalogue keeps disabled is never polled and
 * is left out.
 */
export function operationalEvidenceOf(
  raw: RawOperationalStatus,
  domain: string,
  opts: { graphBound: boolean; coverage?: (sourceId: string) => OperationalFeedCoverage[] },
): OperationalEvidence {
  const collectedAt = stringOrNull(raw.collectedAt) ?? new Date().toISOString();
  const graph = graphOf(raw.graph);
  const ofDomain = (Array.isArray(raw.feeds) ? raw.feeds : []).filter(
    (feed) => feed.domain === domain && feed.state !== "disabled",
  );
  const feeds = ofDomain.slice(0, MAX_OPERATIONAL_FEEDS).flatMap((feed) => {
    const sourceId = stringOrNull(feed.id);
    if (!sourceId) return [];
    const parentSourceId = stringOrNull(feed.parentSourceId);
    const name = stringOrNull(feed.name);
    return [
      {
        sourceId,
        ...(name ? { name } : {}),
        ...(parentSourceId ? { parentSourceId } : {}),
        lastAttemptAt: stringOrNull(feed.lastAttemptAt),
        lastOutcome: stringOrNull(feed.lastOutcome),
        lastSuccessfulCheckAt: stringOrNull(feed.lastNetworkSuccessAt),
        lastPublicationAt: stringOrNull(feed.lastPublicationAt),
        publicationRevision: revisionOf(feed.publicationRevision),
        upstreamAsOf: stringOrNull(feed.upstreamAsOf),
        freshUntil: stringOrNull(feed.freshnessDeadline),
        expectedIntervalSeconds: numberOrNull(feed.cadenceSec),
        activeEventCount: numberOrNull(feed.activeEvents),
        changedCount: changedCount(feed),
        rejectedCount: numberOrNull(feed.lastRejected),
        consecutiveFailures: numberOrNull(feed.consecutiveFailures),
        error: stringOrNull(feed.lastError),
        bindingCounts: bindingCounts(feed.binding),
        graph,
        ...(opts.coverage ? { coverage: opts.coverage(sourceId) } : {}),
        ...operationalState(feed, opts.graphBound ? graph : null, collectedAt),
      } satisfies OperationalFeedEvidence,
    ];
  });
  return {
    schemaVersion: 1,
    collectedAt,
    instanceId: stringOrNull(raw.instanceId) ?? "openconditions",
    truncated: ofDomain.length > MAX_OPERATIONAL_FEEDS,
    feeds,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The rows of a `/coverage` answer; throws on an answer that is not one. */
function coverageRowsOf(answer: unknown): CoverageRow[] {
  const rows = isRecord(answer) ? answer.coverage : undefined;
  if (!Array.isArray(rows)) throw new Error("Malformed /coverage answer");
  return rows.map((row: unknown) => {
    if (
      !isRecord(row) ||
      typeof row.class !== "string" ||
      typeof row.kind !== "string" ||
      (row.accessMode !== "bulk" && row.accessMode !== "on_demand") ||
      !Array.isArray(row.sources) ||
      !row.sources.every((source) => typeof source === "string") ||
      (row.country != null && typeof row.country !== "string") ||
      (row.subdivision != null && typeof row.subdivision !== "string") ||
      (row.property != null && typeof row.property !== "string")
    ) {
      throw new Error("Malformed /coverage row");
    }
    return {
      country: typeof row.country === "string" ? row.country.toUpperCase() : null,
      subdivision: typeof row.subdivision === "string" ? row.subdivision : null,
      class: row.class,
      kind: row.kind,
      ...(typeof row.property === "string" ? { property: row.property } : {}),
      accessMode: row.accessMode,
      sources: row.sources as string[],
    };
  });
}

/** A `/feeds/status` answer with its feed list; throws on one without. */
function statusOf(answer: unknown): RawOperationalStatus {
  if (!isRecord(answer) || !Array.isArray(answer.feeds)) {
    throw new Error("Malformed /feeds/status answer");
  }
  return answer as RawOperationalStatus;
}

/** The stream a row counts for in `domain`: its places, the readings about them, or neither. */
function streamOf(row: CoverageRow, domain: SiteDomain): OperationalFeedCoverage["stream"] | null {
  if (row.class === "feature" && row.kind === SITE_KINDS[domain]) return "static";
  if (row.class === "observation" && row.property?.startsWith(PROPERTY_PREFIXES[domain])) {
    return "live";
  }
  return null;
}

/** What one source holds of one stream in one access mode, per country, and the box it declares. */
type Held = Map<
  string,
  {
    countries: Map<string, boolean>;
    declared: boolean;
    bbox?: [number, number, number, number];
  }
>;

/**
 * Per source, where its places and readings of `domain` are. A source holds a
 * country whole only when it is a bulk source the catalogue does not limit to
 * a subdivision and some of its records there are not filed under one; any
 * other holding is part of the country. An on-demand source holds its places
 * where the catalogue says it applies, whether or not a read has fetched any
 * there yet: the countries of its coverage, else its country, and the box of
 * its coverage (a global source's spans the world).
 */
function coverageBySource(
  rows: readonly CoverageRow[],
  domain: SiteDomain,
  scopes: SourceScopes,
  sources: readonly string[],
): Map<string, OperationalFeedCoverage[]> {
  const found = new Map<string, Held>();
  const holding = (source: string, key: string) => {
    const groups = found.get(source) ?? new Map();
    const group = groups.get(key) ?? { countries: new Map<string, boolean>(), declared: false };
    groups.set(key, group);
    found.set(source, groups);
    return group;
  };
  for (const row of rows) {
    const stream = streamOf(row, domain);
    if (!stream) continue;
    for (const source of row.sources) {
      const group = holding(source, `${stream}|${row.accessMode}`);
      if (!row.country) continue;
      const whole =
        row.accessMode === "bulk" &&
        row.subdivision === null &&
        scopes.get(source)?.subdivision === undefined;
      group.countries.set(row.country, (group.countries.get(row.country) ?? false) || whole);
    }
  }
  for (const source of sources) {
    const scope = scopes.get(source);
    if (scope?.accessMode !== "on_demand") continue;
    const group = holding(source, "static|on_demand");
    for (const country of scope.countries ?? (scope.country ? [scope.country] : [])) {
      if (group.countries.has(country)) continue;
      group.countries.set(country, false);
      group.declared = true;
    }
    if (scope.bbox) {
      group.bbox = scope.bbox;
      group.declared = true;
    }
  }
  return new Map([...found].map(([source, groups]) => [source, entriesOf(groups)] as const));
}

/** The coverage entries of one source's holdings: whole and partial countries apart. */
function entriesOf(groups: Held): OperationalFeedCoverage[] {
  const order = (entry: OperationalFeedCoverage) =>
    (entry.stream === "static" ? 0 : 4) +
    (entry.accessMode === "bulk" ? 0 : 2) +
    (entry.whole ? 0 : 1);
  return [...groups]
    .flatMap(([key, group]) => {
      const [stream, accessMode] = key.split("|") as [
        OperationalFeedCoverage["stream"],
        OperationalFeedCoverage["accessMode"],
      ];
      const basis = group.declared ? ("declared" as const) : ("observed" as const);
      const of = (whole: boolean) =>
        [...group.countries]
          .filter(([, isWhole]) => isWhole === whole)
          .map(([country]) => country)
          .sort();
      const whole = of(true);
      const part = of(false);
      return [
        ...(whole.length > 0 ? [{ stream, accessMode, countries: whole, whole: true, basis }] : []),
        // A source with records nowhere it can place them still holds them.
        ...(part.length > 0 || whole.length === 0
          ? [
              {
                stream,
                accessMode,
                countries: part,
                whole: false,
                basis,
                ...(group.bbox ? { bbox: group.bbox } : {}),
              },
            ]
          : []),
      ];
    })
    .sort((a, b) => order(a) - order(b));
}

/** Reads the coverage evidence of the place domains. */
export interface SiteEvidenceReader {
  read(domain: SiteDomain): Promise<OperationalEvidence>;
}

/**
 * The evidence of the place domains from OpenConditions' own account:
 * `GET /feeds/status` for each feed's polls and publications, `GET /coverage`
 * for where its live records are, and the `/sources` list the integration
 * already keeps (`scopes`) for how each source is fetched (whole, or cell by
 * cell as reads ask) and whether the catalogue limits it to a subdivision.
 * The answers are read in the scope the client's token gives, so the
 * operator sees the restricted sources too.
 *
 * Reads that overlap share one fetch of the two answers, so the place
 * providers asked together cost one of each. Either answer failing or not
 * parsing, or no source list yet, fails every read: no evidence is made up
 * from part of it.
 */
export function createSiteEvidenceReader(
  client: OpenConditionsClient,
  scopes: SourceScopes,
): SiteEvidenceReader {
  let inFlight: Promise<{ status: RawOperationalStatus; rows: CoverageRow[] }> | undefined;
  const snapshot = () => {
    inFlight ??= Promise.all([
      client.get<unknown>("/feeds/status"),
      client.get<unknown>("/coverage"),
    ])
      .then(([status, coverage]) => ({ status: statusOf(status), rows: coverageRowsOf(coverage) }))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
  return {
    async read(domain) {
      if (!scopes.ready) throw new Error("OpenConditions source list not read yet");
      const { status, rows } = await snapshot();
      const ids = (status.feeds ?? []).flatMap((feed) =>
        feed.domain === domain && typeof feed.id === "string" ? [feed.id] : [],
      );
      const coverage = coverageBySource(rows, domain, scopes, ids);
      return operationalEvidenceOf(status, domain, {
        graphBound: false,
        coverage: (sourceId) => coverage.get(sourceId) ?? [],
      });
    },
  };
}
