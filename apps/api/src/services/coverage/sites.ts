import {
  type CoverageDomain,
  regionKeyForCountry,
  type StreamEvidence,
  streamEvidenceSchema,
} from "@openmapx/core/coverage";
import type {
  OperationalEvidence,
  OperationalFeedCoverage,
  OperationalFeedEvidence,
} from "@openmapx/integration-framework";
import { attemptOutcomeOf, safeText } from "./road-conditions.js";

/**
 * How long a working on-demand feed's availability holds once observed. The
 * coverage report collects again well within it.
 */
const ON_DEMAND_WINDOW_MS = 10 * 60_000;

type Name = OperationalFeedCoverage["stream"];

/**
 * Where a feed's stream is: its countries, and the area its catalogue
 * declares. A global feed declares the world, so every region lists it
 * rather than only the unassigned one; a box names no country, so how it
 * relates to a country stays unknown.
 */
function regionOf(
  feed: OperationalFeedEvidence,
  coverage: readonly OperationalFeedCoverage[],
): StreamEvidence["region"] {
  const keys = [...new Set(coverage.flatMap((entry) => entry.countries))]
    .sort()
    .map(regionKeyForCountry);
  const bounds = coverage.find((entry) => entry.bbox)?.bbox;
  return {
    keys,
    basis:
      keys.length === 0 && !bounds
        ? "unknown"
        : coverage.some((entry) => entry.basis === "declared")
          ? "declared"
          : "observed",
    relation: "unknown",
    ...(bounds ? { bounds } : {}),
    ...(feed.name ? { label: feed.name.slice(0, 256) } : {}),
  };
}

function keyOf(
  owner: string,
  domain: CoverageDomain,
  snapshot: OperationalEvidence,
  feed: OperationalFeedEvidence,
  name: Name,
  suffix = "",
): string {
  return `${domain}:${owner}:${snapshot.instanceId}:${feed.sourceId}:${name}${suffix}`.slice(
    0,
    512,
  );
}

/** A feed OpenConditions cannot poll until the operator gives it credentials. */
function unconfigured(
  owner: string,
  domain: CoverageDomain,
  snapshot: OperationalEvidence,
  feed: OperationalFeedEvidence,
): StreamEvidence {
  return streamEvidenceSchema.parse({
    key: keyOf(owner, domain, snapshot, feed, "static"),
    owner: { kind: "integration", id: owner },
    sourceId: feed.sourceId,
    attributionSourceId: feed.sourceId,
    consumerInstance: snapshot.instanceId,
    domain,
    stream: "static",
    evidenceVersion: 1,
    observedAt: snapshot.collectedAt,
    presence: "not-configured",
    region: regionOf(feed, feed.coverage ?? []),
    publication: { version: null, publishedAt: null, active: false },
    attempt: {
      at: feed.lastAttemptAt,
      outcome: "skipped",
      reasonCode: "not_configured",
      ...(feed.action ? { message: safeText(feed.action) } : {}),
    },
    lastSuccessfulCheckAt: null,
    lastSuccessfullyCheckedVersion: null,
    upstreamAsOf: null,
    expiresAt: null,
    policy: {
      basis: "catalog-only",
      staleAt: null,
      expiresAt: null,
      version: "openconditions-places-v1",
      provenance: "OpenConditions feed status: credentials missing",
    },
    freshness: "not-applicable",
    reasons: ["not_configured"],
  });
}

function stream(
  owner: string,
  domain: CoverageDomain,
  snapshot: OperationalEvidence,
  feed: OperationalFeedEvidence,
  name: Name,
  coverage: readonly OperationalFeedCoverage[],
  suffix = "",
): StreamEvidence {
  const region = regionOf(feed, coverage);
  const partial = coverage.some((entry) => !entry.whole);
  // An on-demand feed fetches the places of any area a read asks for, so
  // while it works it stands for its region (in part) whether or not a read
  // came lately. A failing one keeps the deadline of what it last fetched.
  const standing =
    name === "static" &&
    coverage.some((entry) => entry.accessMode === "on_demand") &&
    feed.status !== "failed";
  const checkedAt = standing ? snapshot.collectedAt : feed.lastSuccessfulCheckAt;
  const deadline = standing
    ? new Date(Date.parse(snapshot.collectedAt) + ON_DEMAND_WINDOW_MS).toISOString()
    : feed.freshUntil;
  return streamEvidenceSchema.parse({
    key: keyOf(owner, domain, snapshot, feed, name, suffix),
    owner: { kind: "integration", id: owner },
    sourceId: feed.sourceId,
    attributionSourceId: feed.sourceId,
    consumerInstance: snapshot.instanceId,
    domain,
    stream: name,
    evidenceVersion: 1,
    observedAt: snapshot.collectedAt,
    presence: coverage.length > 0 ? "present" : feed.activeEventCount === 0 ? "empty" : "unknown",
    region,
    publication: {
      version: feed.publicationRevision,
      publishedAt: feed.lastPublicationAt,
      active: standing || feed.publicationRevision ? true : null,
    },
    attempt: {
      at: feed.lastAttemptAt,
      outcome: attemptOutcomeOf(feed.lastOutcome),
      ...(feed.error ? { message: safeText(feed.error) } : {}),
    },
    lastSuccessfulCheckAt: checkedAt,
    lastSuccessfullyCheckedVersion: feed.publicationRevision,
    upstreamAsOf: feed.upstreamAsOf,
    expiresAt: deadline,
    policy: {
      basis: standing ? "on-demand-availability" : "validated-source-snapshot",
      expectedIntervalSeconds: feed.expectedIntervalSeconds,
      staleAt: deadline,
      expiresAt: deadline,
      version: "openconditions-places-v1",
      provenance: standing
        ? "OpenConditions fetches this source for the area a read asks for"
        : "OpenConditions durable feed status and live record coverage",
    },
    freshness: "unknown",
    reasons: [
      ...(partial ? ["source_partial"] : []),
      ...(region.keys.length > 0 ? [] : ["region_unknown"]),
    ],
  });
}

/**
 * The coverage streams of a place provider's feeds (charging, parking or
 * fuel): a `static` stream for the places and a `live` stream for the
 * readings about them, in the countries they are in. A feed that holds a
 * country only in part (one subdivision of it, or on demand) says so with
 * `source_partial`; one holding some countries whole and others in part
 * has a stream for each. A feed that holds no record now keeps one static
 * stream, so its failures show; one missing credentials shows as not
 * configured.
 */
export function siteStreams(
  owner: string,
  domain: CoverageDomain,
  snapshot: OperationalEvidence,
): StreamEvidence[] {
  if (snapshot.schemaVersion !== 1 || snapshot.feeds.length > 500)
    throw new Error("Invalid place operational snapshot");
  return snapshot.feeds.flatMap((feed) => {
    if (feed.status === "missing_configuration")
      return [unconfigured(owner, domain, snapshot, feed)];
    const coverage = feed.coverage ?? [];
    if (coverage.length === 0) return [stream(owner, domain, snapshot, feed, "static", [])];
    return (["static", "live"] as const).flatMap((name) => {
      const entries = coverage.filter((entry) => entry.stream === name);
      const whole = entries.filter((entry) => entry.whole);
      const part = entries.filter((entry) => !entry.whole);
      return [
        ...(whole.length > 0 ? [stream(owner, domain, snapshot, feed, name, whole)] : []),
        ...(part.length > 0
          ? [stream(owner, domain, snapshot, feed, name, part, whole.length > 0 ? ":part" : "")]
          : []),
      ];
    });
  });
}
