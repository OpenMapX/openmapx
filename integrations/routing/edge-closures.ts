import { isEdgeClosure, isRoutingRelevantBinding, type RoadConditionEvent } from "@openmapx/core";
import { services as coreServices } from "@openmapx/core/server";
import { envString } from "@openmapx/core/server-env";
import type { IntegrationContext } from "@openmapx/integration-framework";

export interface AppliedEdgeClosures {
  ids: ReadonlySet<string>;
  writtenAt: Date | null;
  /** True only when the writer reported a write less than APPLIED_SET_MAX_AGE_MS ago. */
  healthy: boolean;
}

/** A set written longer ago than this is stale: the router can no longer be assumed to hold it. */
export const APPLIED_SET_MAX_AGE_MS = 600_000;

/** How long one fetched set is reused before the reader polls the writer again. */
export const APPLIED_SET_CACHE_TTL_MS = 60_000;

/** Never let a slow or unhappy writer hold up a route request. */
const APPLIED_SET_TIMEOUT_MS = 2_000;

const DATA_MANAGER_URL_DEFAULT = "http://localhost:4000";

const UNHEALTHY: AppliedEdgeClosures = { ids: new Set(), writtenAt: null, healthy: false };

interface AppliedResponse {
  writtenAt?: string | null;
  observationIds?: unknown;
  error?: string;
}

/**
 * The data-manager origin to poll. The resolved service requirement wins; the
 * env fallback matches every other data-manager caller in the repo. The value
 * goes through the shared validator, which rejects credentials, path/query
 * suffixes and plaintext hosts outside the loopback/Compose allowlist, and
 * returns a bare origin — so appending a route can never double a slash. It
 * THROWS on a rejected URL, which the caller turns into an unhealthy set.
 */
function dataManagerBaseUrl(ctx: IntegrationContext): string {
  return coreServices.validateDataManagerBaseUrl(
    ctx.getRequiredService("data-manager")?.url ??
      envString("DATA_MANAGER_URL", DATA_MANAGER_URL_DEFAULT),
  );
}

/**
 * Reads the set of observation ids the data-manager's live-traffic writer
 * last applied as Valhalla edge closures. Cached for 60 s; any failure, a
 * rejected base URL, a 501 body, or a write that is not between 0 and 10
 * minutes old yields an UNHEALTHY set, which makes `activeClosuresForBbox`
 * fall back to point exclusions for everything. There is deliberately no
 * flag: the writer's own liveness is the switch.
 */
export function createAppliedEdgeClosuresReader(
  ctx: IntegrationContext,
  now: () => number = Date.now,
): () => Promise<AppliedEdgeClosures> {
  let cached: { at: number; value: AppliedEdgeClosures } | null = null;
  return async () => {
    if (cached && now() - cached.at < APPLIED_SET_CACHE_TTL_MS) return cached.value;
    let value = UNHEALTHY;
    try {
      const body = await ctx.http.get<AppliedResponse>(
        `${dataManagerBaseUrl(ctx)}/traffic/conditions/applied`,
        { timeoutMs: APPLIED_SET_TIMEOUT_MS },
      );
      const writtenAt = body?.writtenAt ? new Date(body.writtenAt) : null;
      // A write dated in the FUTURE is clock skew, not freshness: a negative
      // age would otherwise keep a set "fresh" forever and let us drop point
      // exclusions the router may never have received.
      const age =
        writtenAt != null && !Number.isNaN(writtenAt.getTime())
          ? now() - writtenAt.getTime()
          : null;
      const fresh = age != null && age >= 0 && age < APPLIED_SET_MAX_AGE_MS;
      const ids = Array.isArray(body?.observationIds)
        ? body.observationIds.filter((x): x is string => typeof x === "string")
        : [];
      value = { ids: new Set(ids), writtenAt, healthy: fresh && !body?.error };
    } catch (err) {
      // Covers a rejected base URL, a transport failure, the 501 and a timeout
      // alike. Optional call: nothing on this path, not even logging, may throw
      // into a route request — an unavailable set must only cost us the skip.
      ctx.log?.debug?.(
        "[routing/closures] applied edge-closure set unavailable; using point exclusions",
        err,
      );
    }
    cached = { at: now(), value };
    return value;
  };
}

/** An event leaves the point-exclusion path only when the router already has it as an edge closure. */
export function shouldSkipPointExclusion(
  event: RoadConditionEvent,
  applied: AppliedEdgeClosures,
): boolean {
  return (
    applied.healthy &&
    applied.ids.has(event.id) &&
    isEdgeClosure({
      type: event.type,
      roadState: event.roadState,
      vehiclesAffected: event.vehiclesAffected,
    }) &&
    isRoutingRelevantBinding(event.binding?.status)
  );
}
