import type { CoverageReasonCode, FreshnessPolicy, FreshnessStatus } from "./types";

export const CLOCK_TOLERANCE_MS = 5 * 60_000;

export interface FreshnessEvaluationInput {
  now: number;
  lastSuccessfulCheckAt: string | null;
  lastSuccessfullyCheckedVersion: string | null;
  activeVersion: string | null;
  upstreamAsOf?: string | null;
  expiresAt?: string | null;
  policy: Pick<FreshnessPolicy, "staleAt" | "expiresAt"> | null;
  presence?: "present" | "empty" | "not-configured" | "unknown";
}

export interface FreshnessEvaluation {
  status: FreshnessStatus;
  reasons: CoverageReasonCode[];
  deadline: string | null;
}

function parseTimestamp(value: string | null | undefined, now: number): number | null | "invalid" {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > now + CLOCK_TOLERANCE_MS) return "invalid";
  return parsed;
}

function parseDeadline(value: string | null | undefined): number | null | "invalid" {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : "invalid";
}

function pushUnique(reasons: CoverageReasonCode[], reason: CoverageReasonCode): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Recompute freshness at response time. Collection time is deliberately not a
 * substitute for a successful active-version check or the upstream content
 * clock. Deadlines are inclusive: now >= deadline is stale/expired.
 */
export function evaluateFreshness(input: FreshnessEvaluationInput): FreshnessEvaluation {
  const reasons: CoverageReasonCode[] = [];
  const checkAt = parseTimestamp(input.lastSuccessfulCheckAt, input.now);
  const upstreamAsOf = parseTimestamp(input.upstreamAsOf, input.now);
  const explicitExpiry = parseDeadline(input.expiresAt);
  const policyExpiry = parseDeadline(input.policy?.expiresAt);
  const staleAt = parseDeadline(input.policy?.staleAt);

  if ([checkAt, upstreamAsOf, explicitExpiry, policyExpiry, staleAt].includes("invalid")) {
    return { status: "unknown", reasons: ["clock_invalid"], deadline: null };
  }

  if (input.presence === "not-configured")
    return { status: "not-applicable", reasons, deadline: null };
  if (input.presence === "unknown" || !input.presence) {
    pushUnique(reasons, "no_publication_evidence");
    return { status: "unknown", reasons, deadline: null };
  }

  const knownActiveVersion = input.activeVersion;
  if (!input.lastSuccessfulCheckAt) {
    pushUnique(reasons, "no_publication_evidence");
    return { status: "unknown", reasons, deadline: null };
  }
  if (
    knownActiveVersion &&
    input.lastSuccessfullyCheckedVersion &&
    knownActiveVersion !== input.lastSuccessfullyCheckedVersion
  ) {
    pushUnique(reasons, "active_version_mismatch");
    return { status: "unknown", reasons, deadline: null };
  }
  if (knownActiveVersion && !input.lastSuccessfullyCheckedVersion) {
    pushUnique(reasons, "version_unverified");
    return { status: "unknown", reasons, deadline: null };
  }

  if (!input.policy || (!input.policy.staleAt && !input.policy.expiresAt && !input.expiresAt)) {
    pushUnique(reasons, "freshness_policy_missing");
    return { status: "unknown", reasons, deadline: null };
  }

  const expiry = [explicitExpiry, policyExpiry]
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b)[0];
  const stale = typeof staleAt === "number" ? staleAt : null;
  if (expiry !== undefined && input.now >= expiry) {
    pushUnique(reasons, "live_expired");
    return { status: "expired", reasons, deadline: null };
  }
  if (stale !== null && input.now >= stale) {
    pushUnique(reasons, "source_partial");
    return {
      status: "stale",
      reasons,
      deadline: expiry === undefined ? null : new Date(expiry).toISOString(),
    };
  }

  // A source-provided content clock can be old even when polling succeeded. A
  // policy adapter may express that deadline through staleAt/expiry; retaining
  // the clock here keeps it available for the report without inventing a
  // universal age threshold.
  void upstreamAsOf;
  return {
    status: "current",
    reasons: input.presence === "empty" ? ["empty_observation"] : reasons,
    deadline: new Date(Math.min(expiry ?? Infinity, stale ?? Infinity)).toISOString(),
  };
}

export function reportCollectionAgeSeconds(generatedAt: string, now: number): number {
  const observed = Date.parse(generatedAt);
  if (!Number.isFinite(observed)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - observed) / 1000);
}

export function isCollectionStale(generatedAt: string, now: number, maxAgeSeconds = 120): boolean {
  return reportCollectionAgeSeconds(generatedAt, now) > maxAgeSeconds;
}
