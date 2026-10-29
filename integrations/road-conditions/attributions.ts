import type { RoadConditionEvent } from "@openmapx/core";
import { readCapturedContributors, snapshotContributors } from "@openmapx/integration-framework";

export type RoadConditionCredit = ReturnType<typeof snapshotContributors>[number];

/** Capture an event's explicit source credit, without expanding to its catalogue. */
export function recordedRoadConditionAttributions(
  event: RoadConditionEvent,
): RoadConditionCredit[] {
  const sourceId = event.attribution.sourceId ?? event.source;
  const { provider, licensing, url, notice } = event.attribution;
  if (!sourceId) return [];
  return snapshotContributors(
    provider
      ? [
          {
            sourceId,
            name: provider,
            ...(licensing ? { licensing } : {}),
            ...(url ? { url } : {}),
          },
        ]
      : [],
    notice ? [{ sourceId, name: notice }] : [],
  );
}

/** Project immutable event receipts; native [] is authoritative even over recorded notices. */
export function roadConditionAttributions(
  events: readonly RoadConditionEvent[],
): RoadConditionCredit[] {
  return snapshotContributors(
    ...events.map(
      (event) =>
        readCapturedContributors(event.contributors) ?? recordedRoadConditionAttributions(event),
    ),
  );
}
