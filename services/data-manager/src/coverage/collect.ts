import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type AuthorityObservation,
  type CoveragePermission,
  type CoverageReasonCode,
  evaluateFreshness,
  type FreshnessPolicy,
  type RightsEvidence,
  regionKeyForCountry,
  regionKeyForExtract,
  type StreamEvidence,
} from "@openmapx/core/coverage";
import {
  type PoiSource,
  type RegisteredPoiSource,
  getAllPoiSources as registrySources,
} from "@openmapx/poi-source-registry";
import { Cron } from "croner";
import type postgres from "postgres";
import {
  loadTrafficEvidence,
  type TrafficEvidenceStream,
  trafficEvidencePath,
} from "../jobs/traffic/evidence.js";
import { type MotisSlotRecord, readMotisSlotState } from "../jobs/transitous/slot-state.js";
import {
  readTransitSourceManifest,
  TRANSIT_SOURCE_MANIFEST_FILENAME,
  type TransitSourceManifest,
} from "../jobs/transitous/source-manifest.js";
import type { DatasetMetadata, StateStore } from "../state.js";
import { scrubSecrets } from "../utils/scrub-secrets.js";
import {
  type FeedStateRow,
  type OverturePublicationRow,
  type PoiFeedStateRow,
  readOverturePublication,
  readPoiFeedStates,
  readSearchPublication,
  readTransitFeedStates,
  type SearchPublicationRow,
} from "./inventory.js";
import { collectCoverageRegions } from "./regions.js";
import type { DataManagerCoverageSnapshot } from "./types.js";

export interface CollectCoverageOptions {
  dataDir: string;
  sql: postgres.Sql;
  store: StateStore;
  sources?: readonly RegisteredPoiSource[];
  now?: () => Date;
}

interface CollectionContext {
  now: Date;
  generatedAt: string;
  reasons: CoverageReasonCode[];
  authorities: AuthorityObservation[];
  partial: boolean;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_000_000_000 ? parsed : null;
}

function uniqueReasons(reasons: readonly CoverageReasonCode[]): CoverageReasonCode[] {
  return [...new Set(reasons)];
}

function domainForPoi(source: PoiSource): "pois" | "ev" | "parking" {
  if (source.domain === "ev-charging" || source.domain === "ev") return "ev";
  if (source.domain === "parking") return "parking";
  return "pois";
}

function streamNames(source: RegisteredPoiSource): Array<"static" | "live"> {
  const names: Array<"static" | "live"> = [];
  if (source.static || source.bundled) names.push("static");
  if (source.live || source.bundled) names.push("live");
  return names;
}

function cronPolicy(
  cron: string | undefined,
  lastCheck: string | null,
  _now: Date,
  fallbackBasis: string,
  expiry: string | null = null,
): FreshnessPolicy {
  let staleAt: string | null = null;
  let expectedIntervalSeconds: number | null = null;
  if (cron && lastCheck) {
    try {
      const next = new Cron(cron).nextRuns(2, new Date(lastCheck));
      staleAt = next[1]?.toISOString() ?? null;
      const first = next[0]?.getTime();
      const second = next[1]?.getTime();
      if (first !== undefined && second !== undefined && second > first) {
        expectedIntervalSeconds = Math.round((second - first) / 1_000);
      }
    } catch {
      staleAt = null;
    }
  }
  return {
    basis: cron ? "registered-cron" : fallbackBasis,
    expectedIntervalSeconds,
    staleAt,
    expiresAt: expiry,
    version: "coverage-v1",
    provenance: cron
      ? `registered schedule ${cron} in ${Intl.DateTimeFormat().resolvedOptions().timeZone}`
      : "owned evidence adapter; no explicit maximum age",
  };
}

function makeAttempt(
  at: string | null,
  outcome: StreamEvidence["attempt"]["outcome"],
  jobId: string | null = null,
  message?: string | null,
): StreamEvidence["attempt"] {
  return {
    at,
    outcome,
    ...(jobId ? { job: { system: "data-manager", id: jobId } } : {}),
    ...(message ? { message: safeDiagnostic(message, 1_000) } : {}),
  };
}

function safeDiagnostic(value: unknown, max: number): string {
  const message = scrubSecrets(value instanceof Error ? value.message : String(value));
  // Error messages from filesystem readers can contain the data-manager's
  // local mount. Reports expose diagnostics, never deployment paths.
  return message.replace(/(^|[\s("'=])\/(?:[^\s"'=()]+\/?)+/g, "$1[path]").slice(0, max);
}

function evaluateStreamFreshness(input: {
  now: Date;
  presence: StreamEvidence["presence"];
  activeVersion: string | null;
  lastSuccessfulCheckAt: string | null;
  lastSuccessfullyCheckedVersion: string | null;
  upstreamAsOf?: string | null;
  expiresAt?: string | null;
  policy: FreshnessPolicy;
}): { freshness: StreamEvidence["freshness"]; reasons: CoverageReasonCode[] } {
  const result = evaluateFreshness({
    now: input.now.getTime(),
    presence: input.presence,
    activeVersion: input.activeVersion,
    lastSuccessfulCheckAt: input.lastSuccessfulCheckAt,
    lastSuccessfullyCheckedVersion: input.lastSuccessfullyCheckedVersion,
    upstreamAsOf: input.upstreamAsOf,
    expiresAt: input.expiresAt,
    policy: input.policy,
  });
  return { freshness: result.status, reasons: result.reasons };
}

function baseStream(input: {
  key: string;
  owner: StreamEvidence["owner"];
  sourceId: string;
  attributionSourceId?: string;
  stream: string;
  domain: StreamEvidence["domain"];
  now: Date;
  observedAt: string;
  presence: StreamEvidence["presence"];
  region: StreamEvidence["region"];
  count?: StreamEvidence["count"];
  publication: StreamEvidence["publication"];
  attempt: StreamEvidence["attempt"];
  lastSuccessfulCheckAt: string | null;
  lastSuccessfullyCheckedVersion: string | null;
  upstreamAsOf?: string | null;
  expiresAt?: string | null;
  policy: FreshnessPolicy;
  reasons?: CoverageReasonCode[];
}): StreamEvidence {
  const freshness = evaluateStreamFreshness({
    now: input.now,
    presence: input.presence,
    activeVersion: input.publication.version,
    lastSuccessfulCheckAt: input.lastSuccessfulCheckAt,
    lastSuccessfullyCheckedVersion: input.lastSuccessfullyCheckedVersion,
    upstreamAsOf: input.upstreamAsOf,
    expiresAt: input.expiresAt,
    policy: input.policy,
  });
  return {
    key: input.key,
    owner: input.owner,
    sourceId: input.sourceId,
    ...(input.attributionSourceId ? { attributionSourceId: input.attributionSourceId } : {}),
    stream: input.stream,
    domain: input.domain,
    observedAt: input.observedAt,
    evidenceVersion: 1,
    presence: input.presence,
    region: input.region,
    ...(input.count ? { count: input.count } : {}),
    publication: input.publication,
    attempt: input.attempt,
    lastSuccessfulCheckAt: input.lastSuccessfulCheckAt,
    lastSuccessfullyCheckedVersion: input.lastSuccessfullyCheckedVersion,
    upstreamAsOf: input.upstreamAsOf ?? null,
    expiresAt: input.expiresAt ?? null,
    policy: input.policy,
    freshness: freshness.freshness,
    reasons: uniqueReasons([...(input.reasons ?? []), ...freshness.reasons]),
  };
}

function declaredRegion(source: RegisteredPoiSource): StreamEvidence["region"] {
  if (source.coverage) {
    return {
      keys: [`regional-scope:${source.id}`],
      label: source.name,
      basis: "declared",
      relation: "unknown",
      bounds: source.coverage,
    };
  }
  return { keys: [], basis: "unknown", relation: "unknown" };
}

function readRefreshStream(
  value: unknown,
  stream: "static" | "live",
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1)
    return null;
  const root = value as Record<string, unknown>;
  const selected = root[stream];
  return selected && typeof selected === "object" ? (selected as Record<string, unknown>) : null;
}

function textField(value: Record<string, unknown> | null, field: string): string | null {
  const result = value?.[field];
  return typeof result === "string" && result.length > 0 ? result.slice(0, 512) : null;
}

function dateField(value: Record<string, unknown> | null, field: string): string | null {
  const result = textField(value, field);
  return result && Number.isFinite(Date.parse(result)) ? result : null;
}

function attemptField(value: Record<string, unknown> | null): StreamEvidence["attempt"] {
  const attempt = value?.lastAttempt;
  if (!attempt || typeof attempt !== "object") return makeAttempt(null, "unknown");
  const record = attempt as Record<string, unknown>;
  const outcome = record.outcome;
  const allowed = [
    "running",
    "succeeded",
    "unchanged",
    "partial",
    "failed",
    "skipped",
    "unknown",
  ] as const;
  const normalized = allowed.includes(outcome as (typeof allowed)[number])
    ? (outcome as (typeof allowed)[number])
    : "unknown";
  return makeAttempt(
    dateField(record, "at"),
    normalized,
    typeof record.jobId === "string" ? record.jobId.slice(0, 256) : null,
    typeof record.message === "string" ? record.message : null,
  );
}

function buildPoiStreams(
  sources: readonly RegisteredPoiSource[],
  stateRows: readonly PoiFeedStateRow[],
  now: Date,
): StreamEvidence[] {
  const byId = new Map(stateRows.map((row) => [row.source_id, row]));
  const generatedAt = now.toISOString();
  const result: StreamEvidence[] = [];
  for (const source of sources) {
    const ownerId = source.ownerIntegrationId ?? "unknown";
    const owner = { kind: "integration" as const, id: ownerId };
    const row = byId.get(source.id);
    for (const stream of streamNames(source)) {
      const evidence = readRefreshStream(row?.refresh_evidence, stream);
      const activeVersion =
        typeof evidence?.activeVersion === "string" ? evidence.activeVersion : null;
      const activeAssociation = evidence?.activeAssociation;
      const associationKnown = activeAssociation === "known";
      const publishedAt = dateField(evidence, "lastPublishedAt");
      const checkedAt = dateField(evidence, "lastSuccessfulCheckAt");
      const lastAttempt = evidence ? attemptField(evidence) : makeAttempt(null, "unknown");
      const count = numeric(evidence?.rowCount);
      const configuredSpec =
        stream === "static" ? (source.static ?? source.bundled) : (source.live ?? source.bundled);
      const cron = configuredSpec?.cron;
      const expiry = dateField(evidence, "expiresAt");
      const policy = cronPolicy(cron, checkedAt, now, "freshness-policy-missing", expiry);
      const hasPublication = Boolean(
        activeVersion &&
          publishedAt &&
          associationKnown &&
          !textField(evidence, "pendingWriteIntentId"),
      );
      const presence: StreamEvidence["presence"] = hasPublication
        ? count === 0
          ? "empty"
          : "present"
        : "unknown";
      const reasons: CoverageReasonCode[] = [];
      if (!row) reasons.push("no_publication_evidence");
      if (!hasPublication) reasons.push("no_publication_evidence");
      if (activeAssociation === "unknown" || evidence?.pendingWriteIntentId) {
        reasons.push("publish_failed");
      }
      if (
        hasPublication &&
        (lastAttempt.outcome === "failed" || lastAttempt.outcome === "partial")
      ) {
        reasons.push("serving_earlier_data");
      }
      if (ownerId === "unknown") reasons.push("lineage_unknown");
      if (lastAttempt.outcome === "failed" || lastAttempt.outcome === "partial") {
        reasons.push("upstream_check_failed");
      }
      const lastSuccessfullyCheckedVersion = textField(evidence, "lastSuccessfullyCheckedVersion");
      const upstreamAsOf = dateField(evidence, "upstreamAsOf");
      const observedAt = lastAttempt.at ?? checkedAt ?? publishedAt ?? generatedAt;
      result.push(
        baseStream({
          key: `poi:${ownerId}:${source.id}:${stream}`,
          owner,
          sourceId: source.id,
          attributionSourceId: source.attributionSourceId,
          stream,
          domain: domainForPoi(source),
          now,
          observedAt,
          presence,
          region: declaredRegion(source),
          ...(count !== null
            ? { count: { value: count, unit: "records", scope: "registered source" } }
            : {}),
          publication: {
            version: textField(evidence, "lastPublishedVersion") ?? activeVersion,
            publishedAt,
            active: hasPublication ? true : null,
          },
          attempt: lastAttempt,
          lastSuccessfulCheckAt: checkedAt,
          lastSuccessfullyCheckedVersion,
          upstreamAsOf,
          expiresAt: expiry,
          policy,
          reasons,
        }),
      );
    }
  }
  return result;
}

function buildSearchStream(
  exists: boolean,
  row: SearchPublicationRow | null,
  datasets: readonly DatasetMetadata[],
  now: Date,
): StreamEvidence {
  const observedAt = iso(row?.updated_at) ?? now.toISOString();
  const sourceFingerprint = row?.source_fingerprint ?? null;
  const currentFingerprint = row?.current_fingerprint ?? null;
  const publicationAt = iso(row?.published_at);
  const active = row?.status === "ready" && row?.epoch !== null && publicationAt !== null;
  const placeCount = numeric(row?.place_count);
  const reasons: CoverageReasonCode[] = [];
  if (!exists) reasons.push("schema_unavailable");
  if (!row) reasons.push("no_publication_evidence");
  if (!active) reasons.push("no_publication_evidence");
  const fingerprintMatches =
    sourceFingerprint !== null &&
    currentFingerprint !== null &&
    sourceFingerprint === currentFingerprint;
  if (sourceFingerprint && currentFingerprint && sourceFingerprint !== currentFingerprint) {
    reasons.push("active_version_mismatch", "version_unverified");
    if (active) reasons.push("serving_earlier_data");
  }
  if (!sourceFingerprint || !currentFingerprint) reasons.push("version_unverified");
  if (datasets.length > 1) reasons.push("optional_evidence_missing");
  const attemptFailed = Boolean(row?.last_error);
  if (attemptFailed) {
    reasons.push("upstream_check_failed");
    if (active) reasons.push("serving_earlier_data");
  }
  const activeVersion = row?.epoch ?? null;
  return baseStream({
    key: "service:data-manager:osm-search",
    owner: { kind: "service", id: "data-manager" },
    sourceId: "osm-search",
    stream: "search-index",
    domain: "pois",
    now,
    observedAt,
    presence: active ? (placeCount === 0 ? "empty" : "present") : "unknown",
    region: row
      ? { keys: [regionKeyForExtract(row.region)], basis: "published-region", relation: "unknown" }
      : { keys: [], basis: "unknown", relation: "unknown" },
    ...(placeCount !== null
      ? { count: { value: placeCount, unit: "search-places", scope: "active search region" } }
      : {}),
    publication: { version: row?.epoch ?? null, publishedAt: publicationAt, active },
    attempt: makeAttempt(
      iso(row?.updated_at),
      row ? (attemptFailed ? "failed" : active ? "succeeded" : "failed") : "unknown",
      null,
      row?.last_error,
    ),
    lastSuccessfulCheckAt: fingerprintMatches ? publicationAt : null,
    lastSuccessfullyCheckedVersion: fingerprintMatches ? activeVersion : null,
    policy: cronPolicy(undefined, publicationAt, now, "freshness-policy-missing"),
    reasons,
  });
}

function buildOvertureStream(
  exists: boolean,
  row: OverturePublicationRow | null,
  feed: FeedStateRow | undefined,
  now: Date,
): StreamEvidence {
  const publishedAt = iso(row?.places_published_at);
  const active = row !== null && publishedAt !== null;
  const count = numeric(row?.place_count);
  const reasons: CoverageReasonCode[] = [];
  if (!exists) reasons.push("schema_unavailable");
  if (!row) reasons.push("no_publication_evidence");
  if (!publishedAt) reasons.push("no_publication_evidence");
  if (row?.status === "failed") reasons.push("optional_evidence_missing");
  return baseStream({
    key: "service:data-manager:overture-places",
    owner: { kind: "service", id: "data-manager" },
    sourceId: "overture-places",
    stream: "places",
    domain: "pois",
    now,
    observedAt: iso(feed?.last_fetched_at) ?? iso(row?.updated_at) ?? now.toISOString(),
    presence: active ? (count === 0 ? "empty" : "present") : "unknown",
    region: row
      ? { keys: [regionKeyForExtract(row.region)], basis: "published-region", relation: "unknown" }
      : { keys: [], basis: "unknown", relation: "unknown" },
    ...(count !== null
      ? { count: { value: count, unit: "places", scope: "published extract" } }
      : {}),
    publication: { version: row?.release ?? null, publishedAt, active: active },
    attempt: makeAttempt(
      iso(feed?.last_fetched_at),
      feed?.validation_status === "ok" ? "succeeded" : feed ? "failed" : "unknown",
      null,
      feed?.validation_message,
    ),
    lastSuccessfulCheckAt: publishedAt,
    lastSuccessfullyCheckedVersion: row?.release ?? null,
    policy: cronPolicy(undefined, publishedAt, now, "freshness-policy-missing"),
    reasons,
  });
}

function transitRegionKey(region: string): string {
  return /^[a-z]{2,3}$/i.test(region) ? regionKeyForCountry(region) : regionKeyForExtract(region);
}

function manifestPath(dataDir: string, slot: MotisSlotRecord): string {
  return join(dataDir, "motis", "slots", slot.activeSlot, TRANSIT_SOURCE_MANIFEST_FILENAME);
}

function recordValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function permissionValue(value: unknown): CoveragePermission {
  return value === "yes" || value === "no" || value === "conditional" || value === "unknown"
    ? value
    : "unknown";
}

function boundedTextValue(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
}

function safeManifestUrl(value: unknown): string | undefined {
  const raw = boundedTextValue(value, 2_000);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    const sensitiveNames = new Set([
      "access_token",
      "api_key",
      "apikey",
      "client_secret",
      "credential",
      "key",
      "password",
      "secret",
      "sig",
      "signature",
      "token",
    ]);
    for (const name of url.searchParams.keys()) {
      if (sensitiveNames.has(name.toLocaleLowerCase())) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function transitRights(manifest: TransitSourceManifest | null): RightsEvidence[] {
  return (manifest?.sources ?? []).map((source) => {
    const license = source.license && typeof source.license === "object" ? source.license : {};
    const redistribution = recordValue(license, "redistribution");
    const redistributionRecord =
      redistribution && typeof redistribution === "object"
        ? (redistribution as Record<string, unknown>)
        : {};
    const conditionsValue = recordValue(license, "usageConditions", "conditions", "requirements");
    const usageConditions = Array.isArray(conditionsValue)
      ? conditionsValue
          .map((condition) => boundedTextValue(condition, 1_000))
          .filter((condition): condition is string => condition !== undefined)
          .slice(0, 32)
      : [];
    const reviewedAt = boundedTextValue(recordValue(license, "reviewedAt", "reviewed_at"), 128);
    const reviewedTime =
      reviewedAt && Number.isFinite(Date.parse(reviewedAt))
        ? new Date(reviewedAt).toISOString()
        : undefined;
    const licenseName = boundedTextValue(
      recordValue(license, "name", "title", "license", "spdxIdentifier", "spdx-identifier"),
      512,
    );
    const attribution = boundedTextValue(recordValue(license, "attribution", "notice"), 1_000);
    const licenseUrl = safeManifestUrl(
      recordValue(license, "url", "licenseUrl", "license_url", "license-url"),
    );
    const termsUrl = safeManifestUrl(recordValue(license, "termsUrl", "terms_url", "terms-url"));
    const sourceData = permissionValue(
      recordValue(redistributionRecord, "sourceData", "source_data") ??
        recordValue(license, "sourceData", "source_data"),
    );
    const derivedData = permissionValue(
      recordValue(redistributionRecord, "derivedData", "derived_data") ??
        recordValue(license, "derivedData", "derived_data"),
    );
    const commercialUse = permissionValue(
      recordValue(license, "commercialUse", "commercial_use", "commercial-use"),
    );
    return {
      key: `rights:service:data-manager:${source.sourceId}`.slice(0, 512),
      qualifiedDatasetKey: `service:data-manager:${source.sourceId}`.slice(0, 512),
      owner: { kind: "service", id: "data-manager" },
      sourceId: source.sourceId,
      name: source.name.slice(0, 256),
      commercialUse,
      redistribution: { sourceData, derivedData },
      ...(licenseName ? { license: licenseName } : {}),
      ...(licenseUrl ? { licenseUrl } : {}),
      ...(termsUrl ? { termsUrl } : {}),
      ...(attribution ? { attribution } : {}),
      usageConditions,
      ...(reviewedTime ? { reviewedAt: reviewedTime } : {}),
      evidenceOrigin: "active transit source manifest",
      lineageKnown: true,
    } satisfies RightsEvidence;
  });
}

interface TransitPublicationRead {
  slot: MotisSlotRecord | null;
  manifest: TransitSourceManifest | null;
  unstable: boolean;
}

function slotIdentity(slot: MotisSlotRecord | null): string {
  if (!slot) return "none";
  return JSON.stringify({
    activeSlot: slot.activeSlot,
    datasetEpoch: slot.datasetEpoch ?? null,
    manifestHash: slot.manifestHash ?? null,
    activatedAt: slot.activatedAt ?? null,
  });
}

/**
 * Read the activation record and its manifest as one bounded observation.
 * Activation is a filesystem transaction separate from this collector, so a
 * second state read closes the race without repairing aliases or retrying
 * indefinitely.
 */
function readTransitPublication(dataDir: string): TransitPublicationRead {
  let last: TransitPublicationRead = { slot: null, manifest: null, unstable: false };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = readMotisSlotState(dataDir);
    let manifest: TransitSourceManifest | null = null;
    if (before) {
      const path = manifestPath(dataDir, before);
      if (existsSync(path)) {
        if (statSync(path).size > 8 * 1024 * 1024)
          throw new Error("Transit source manifest exceeds size limit");
        manifest = readTransitSourceManifest(path);
        if (
          !iso(manifest.generatedAt) ||
          manifest.sources.some(
            (source) =>
              !source ||
              typeof source.sourceId !== "string" ||
              !source.sourceId ||
              source.sourceId.length > 256 ||
              typeof source.region !== "string" ||
              !source.region ||
              source.region.length > 128 ||
              typeof source.name !== "string" ||
              !source.name ||
              source.name.length > 256,
          )
        ) {
          throw new Error("Malformed transit source identity");
        }
      }
    }
    const after = readMotisSlotState(dataDir);
    last = { slot: after, manifest, unstable: false };
    if (slotIdentity(before) === slotIdentity(after)) return last;
    last.unstable = true;
  }
  return { ...last, slot: null, manifest: null };
}

function buildTransitStreams(
  dataDir: string,
  slot: MotisSlotRecord | null,
  manifest: TransitSourceManifest | null,
  feedRows: readonly FeedStateRow[],
  now: Date,
): StreamEvidence[] {
  const generatedAt = now.toISOString();
  const streams: StreamEvidence[] = [];
  const activeIds = new Set<string>();
  for (const source of manifest?.sources ?? []) {
    activeIds.add(`${source.region.toLowerCase()}:${source.name.toLowerCase()}`);
    const publishedAt = iso(slot?.activatedAt) ?? iso(manifest?.generatedAt);
    streams.push(
      baseStream({
        key: `transit:${source.region}:${source.sourceId}`,
        owner: { kind: "service", id: "data-manager" },
        sourceId: source.sourceId,
        stream: "schedule",
        domain: "transit",
        now,
        observedAt: publishedAt ?? generatedAt,
        presence: slot && manifest ? "present" : "unknown",
        region: {
          keys: [transitRegionKey(source.region)],
          basis: "published-region",
          relation: "unknown",
        },
        publication: {
          version: slot?.datasetEpoch ?? null,
          publishedAt,
          active: Boolean(slot && manifest),
        },
        attempt: makeAttempt(publishedAt, slot && manifest ? "succeeded" : "unknown"),
        lastSuccessfulCheckAt: publishedAt,
        lastSuccessfullyCheckedVersion: slot?.datasetEpoch ?? null,
        policy: cronPolicy(undefined, publishedAt, now, "freshness-policy-missing"),
        reasons: [
          "schedule_validity_unknown",
          ...(slot?.datasetEpoch ? [] : ["version_unverified"]),
        ] as CoverageReasonCode[],
      }),
    );
  }
  for (const row of feedRows) {
    const key = `${row.region.toLowerCase()}:${row.name.toLowerCase()}`;
    if (activeIds.has(key)) continue;
    const at = iso(row.last_imported_at) ?? iso(row.last_fetched_at);
    streams.push(
      baseStream({
        key: `transit:history:${row.region}:${row.name}`,
        owner: { kind: "service", id: "data-manager" },
        sourceId: `${row.region}:${row.name}`,
        stream: "historical-feed",
        domain: "transit",
        now,
        observedAt: at ?? generatedAt,
        presence: "unknown",
        region: { keys: [transitRegionKey(row.region)], basis: "declared", relation: "unknown" },
        publication: { version: null, publishedAt: null, active: false },
        attempt: makeAttempt(
          at,
          row.validation_status === "ok" ? "succeeded" : "failed",
          null,
          row.validation_message,
        ),
        lastSuccessfulCheckAt: iso(row.last_imported_at),
        lastSuccessfullyCheckedVersion: row.hash,
        policy: cronPolicy(undefined, iso(row.last_imported_at), now, "freshness-policy-missing"),
        reasons: ["source_not_active", "no_publication_evidence"],
      }),
    );
  }
  if (streams.length === 0) {
    streams.push(
      baseStream({
        key: "transit:active-runtime",
        owner: { kind: "service", id: "data-manager" },
        sourceId: "transit-runtime",
        stream: "schedule",
        domain: "transit",
        now,
        observedAt: generatedAt,
        presence: "unknown",
        region: { keys: [], basis: "unknown", relation: "unknown" },
        publication: { version: null, publishedAt: null, active: null },
        attempt: makeAttempt(null, "unknown"),
        lastSuccessfulCheckAt: null,
        lastSuccessfullyCheckedVersion: null,
        policy: cronPolicy(undefined, null, now, "freshness-policy-missing"),
        reasons: ["no_publication_evidence"],
      }),
    );
  }
  void dataDir;
  return streams;
}

function buildTrafficStreams(
  evidence: Awaited<ReturnType<typeof loadTrafficEvidence>>,
  now: Date,
): StreamEvidence[] {
  const generatedAt = now.toISOString();
  const streams: StreamEvidence[] = [];
  const sourceFor = (stream: string) => `traffic:${stream}`;
  const make = (
    streamName: "flow" | "conditions" | "graph",
    domainStream: string,
    value: TrafficEvidenceStream,
  ): StreamEvidence => {
    const active =
      streamName === "graph" ? value.graphApplied === true && value.lastPublishedAt !== null : null;
    const presence: StreamEvidence["presence"] = value.lastSuccessfulCheckAt
      ? value.total === 0
        ? "empty"
        : "present"
      : "unknown";
    const reasons: CoverageReasonCode[] = [];
    if (!value.lastSuccessfulCheckAt) reasons.push("no_publication_evidence");
    if (value.lastAttemptOutcome === "failed") reasons.push("upstream_check_failed");
    if (value.lastSuccessfulCheckAt && value.lastAttemptOutcome === "failed") {
      reasons.push("serving_earlier_data");
    }
    if (value.lastAttemptOutcome === "skipped") reasons.push("optional_evidence_missing");
    if (streamName === "graph") reasons.push("version_unverified");
    if (streamName === "graph" && value.graphApplied === false)
      reasons.push("source_partial", "version_unverified");
    const policy = cronPolicy(
      process.env.TRAFFIC_LIVE_CRON || "*/2 * * * *",
      value.lastSuccessfulCheckAt,
      now,
      "declared-utc-cron",
      value.expiresAt,
    );
    return baseStream({
      key: sourceFor(streamName),
      owner: { kind: "service", id: "data-manager" },
      sourceId: streamName === "graph" ? "valhalla-traffic" : "openconditions",
      stream: domainStream,
      domain: "traffic",
      now,
      observedAt: value.lastAttemptAt ?? value.lastSuccessfulCheckAt ?? generatedAt,
      presence,
      region: { keys: [], basis: "unknown", relation: "unknown" },
      ...(value.total !== null
        ? { count: { value: value.total, unit: "feed-rows", scope: streamName } }
        : {}),
      publication: {
        version: value.activeVersion,
        publishedAt: value.lastPublishedAt,
        active,
      },
      attempt: makeAttempt(
        value.lastAttemptAt,
        value.lastAttemptOutcome,
        null,
        value.lastAttemptMessage,
      ),
      lastSuccessfulCheckAt: value.lastSuccessfulCheckAt,
      lastSuccessfullyCheckedVersion: value.activeVersion,
      upstreamAsOf: value.upstreamAsOf,
      expiresAt: value.expiresAt,
      policy,
      reasons,
    });
  };
  const current = evidence.status === "ok" ? evidence.evidence : null;
  const unknown = {
    lastAttemptAt: null,
    lastAttemptOutcome: "unknown" as const,
    lastAttemptMessage: null,
    lastSuccessfulCheckAt: null,
    lastPublishedAt: null,
    activeVersion: null,
    upstreamAsOf: null,
    graphApplied: null,
    total: null,
    matched: null,
    written: null,
    outOfBounds: null,
    expiresAt: null,
  };
  streams.push(make("flow", "flow", current?.flow ?? unknown));
  streams.push(make("conditions", "road-conditions", current?.conditions ?? unknown));
  streams.push(make("graph", "traffic-graph", current?.graph ?? unknown));
  if (evidence.status === "corrupt") {
    for (const stream of streams) stream.reasons.push("collector_unavailable");
  }
  return streams;
}

function authority(
  authorityName: AuthorityObservation["authority"],
  status: AuthorityObservation["status"],
  observedAt: string,
  message?: string,
): AuthorityObservation {
  return {
    authority: authorityName,
    status,
    observedAt,
    ...(message ? { message: safeDiagnostic(message, 500) } : {}),
  };
}

function mergeAuthorities(observations: readonly AuthorityObservation[]): AuthorityObservation[] {
  const severity = { available: 1, partial: 2, unavailable: 3 } as const;
  const byAuthority = new Map<AuthorityObservation["authority"], AuthorityObservation>();
  for (const observation of observations) {
    const existing = byAuthority.get(observation.authority);
    if (!existing || severity[observation.status] >= severity[existing.status]) {
      byAuthority.set(observation.authority, observation);
    }
  }
  return [...byAuthority.values()].sort((a, b) => a.authority.localeCompare(b.authority));
}

export async function collectCoverageSnapshot(
  opts: CollectCoverageOptions,
): Promise<DataManagerCoverageSnapshot> {
  const now = opts.now?.() ?? new Date();
  const generatedAt = now.toISOString();
  const context: CollectionContext = {
    now,
    generatedAt,
    reasons: [],
    authorities: [],
    partial: false,
  };
  const stateDiagnostics = opts.store.getLoadDiagnostics();
  context.authorities.push(
    authority(
      "data-manager",
      stateDiagnostics.status === "corrupt" ? "partial" : "available",
      generatedAt,
      stateDiagnostics.error ?? undefined,
    ),
  );
  if (stateDiagnostics.status === "corrupt") {
    context.partial = true;
    context.reasons.push("collector_unavailable");
  }

  const datasets = opts.store.getAll();
  const sources = opts.sources ?? registrySources();
  let poiRows: PoiFeedStateRow[] = [];
  let search: { exists: boolean; row: SearchPublicationRow | null } = { exists: false, row: null };
  let overture: {
    exists: boolean;
    row: OverturePublicationRow | null;
  } = {
    exists: false,
    row: null,
  };
  let transitRows: FeedStateRow[] = [];
  const reads = await Promise.allSettled([
    readPoiFeedStates(opts.sql),
    readSearchPublication(opts.sql),
    readOverturePublication(opts.sql),
    readTransitFeedStates(opts.sql),
  ]);
  if (reads[0].status === "fulfilled") poiRows = reads[0].value;
  if (reads[1].status === "fulfilled") search = reads[1].value;
  if (reads[2].status === "fulfilled") overture = reads[2].value;
  if (reads[3].status === "fulfilled") transitRows = reads[3].value;
  const failedReads = reads.filter((result) => result.status === "rejected").length;
  if (failedReads) {
    context.partial = true;
    context.reasons.push("collector_unavailable");
  }
  context.authorities.push(
    authority(
      "postgres",
      failedReads === reads.length ? "unavailable" : failedReads ? "partial" : "available",
      generatedAt,
    ),
  );

  const streams: StreamEvidence[] = [];
  streams.push(...buildPoiStreams(sources, poiRows, now));
  streams.push(
    buildSearchStream(
      search.exists,
      search.row,
      datasets.filter((dataset) => dataset.type === "osm-pbf"),
      now,
    ),
  );
  streams.push(
    buildOvertureStream(
      overture.exists,
      overture.row,
      transitRows.find((row) => row.name === "overture-places"),
      now,
    ),
  );

  let slot: MotisSlotRecord | null = null;
  let manifest: TransitSourceManifest | null = null;
  try {
    const transitPublication = readTransitPublication(opts.dataDir);
    slot = transitPublication.slot;
    manifest = transitPublication.manifest;
    if (transitPublication.unstable) {
      context.partial = true;
      context.reasons.push("collector_unavailable");
      context.authorities.push(
        authority(
          "data-manager",
          "partial",
          generatedAt,
          "transit activation changed during the bounded evidence read",
        ),
      );
    }
  } catch (err) {
    context.partial = true;
    context.reasons.push("collector_unavailable");
    context.authorities.push(
      authority("data-manager", "partial", generatedAt, (err as Error).message),
    );
  }
  streams.push(...buildTransitStreams(opts.dataDir, slot, manifest, transitRows, now));

  const trafficStatePath = join(opts.dataDir, "traffic", "live-state.json");
  const traffic = await loadTrafficEvidence(trafficEvidencePath(trafficStatePath));
  if (traffic.status === "corrupt") {
    context.partial = true;
    context.reasons.push("collector_unavailable");
  }
  streams.push(...buildTrafficStreams(traffic, now));

  const regions = collectCoverageRegions(
    streams,
    datasets
      .filter((dataset) => dataset.type === "osm-pbf" && (dataset.region ?? dataset.id))
      .map((dataset) => dataset.region ?? dataset.id),
  );
  const unassignedSourceCount = streams.filter((stream) => stream.region.keys.length === 0).length;
  return {
    schemaVersion: 1,
    snapshotId: "",
    generatedAt,
    collectionStatus: context.partial ? "partial" : "complete",
    authorities: mergeAuthorities(context.authorities),
    warnings: uniqueReasons(context.reasons),
    regions,
    streams,
    rights: transitRights(manifest),
    totalStreams: streams.length,
    truncated: false,
    unassignedSourceCount,
  };
}
