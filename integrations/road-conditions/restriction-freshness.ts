import type { RoadConditionEvent } from "@openmapx/core";

/**
 * When a displayed restriction view stops being verified-current.
 *
 * This only *consumes* the producer's published deadlines. The browser does
 * not decide freshness policy, does not re-evaluate a fact's state, and does
 * not extend a deadline the producer already considers elapsed.
 */

/** Upper bound on how long a restriction view may be shown between refreshes. */
export const RESTRICTION_VIEW_MAX_AGE_MS = 60_000;

/**
 * The next instant at which the visible restriction evaluation must be
 * refetched: the earliest published `freshUntil`/`nextTransitionAt`, capped at
 * one minute from `atMs`.
 *
 * Returns `atMs` when there is nothing to trust — a stale view, an
 * unsupported envelope, a missing freshness basis or an already-elapsed
 * deadline. Callers read that as "refresh now / mark as needing refresh"
 * rather than as a licence to keep showing a verified-current label.
 */
export function restrictionRefreshDeadline(
  events: readonly RoadConditionEvent[],
  atMs: number,
): number {
  if (!Number.isFinite(atMs)) return atMs;
  const ceiling = atMs + RESTRICTION_VIEW_MAX_AGE_MS;
  let earliest = ceiling;
  let sawView = false;
  for (const event of events) {
    if (event.restrictionDetailsUnsupported === true) return atMs;
    const details = event.restrictionDetails;
    if (details === undefined) continue;
    sawView = true;
    if (details.isStale || details.freshUntil === null) return atMs;
    for (const deadline of [details.freshUntil, details.nextTransitionAt]) {
      if (deadline === null) continue;
      const epoch = Date.parse(deadline);
      if (!Number.isFinite(epoch)) return atMs;
      if (epoch <= atMs) return atMs;
      if (epoch < earliest) earliest = epoch;
    }
  }
  return sawView ? earliest : ceiling;
}

/** Does the visible collection carry any restriction view at all? */
export function hasRestrictionView(events: readonly RoadConditionEvent[]): boolean {
  return events.some(
    (event) =>
      event.restrictionDetails !== undefined || event.restrictionDetailsUnsupported === true,
  );
}
