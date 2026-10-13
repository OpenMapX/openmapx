import type { RoadConditionEvent } from "@openmapx/core";
import { parseContributors, snapshotContributors } from "@openmapx/integration-framework";

export type RoadConditionCredit = ReturnType<typeof snapshotContributors>[number];

/** Bounded compatibility for old records: only their own recorded credit, never a catalogue. */
export function recordedRoadConditionAttributions(
  event: RoadConditionEvent,
): RoadConditionCredit[] {
  const sourceId = event.attribution.sourceId ?? event.source;
  const { provider, license, url, notice } = event.attribution;
  if (!sourceId) return [];
  return snapshotContributors(
    provider
      ? [
          {
            sourceId,
            name: provider,
            ...(license ? { spdxLicense: license } : {}),
            ...(url ? (license ? { licenseUrl: url } : { url }) : {}),
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
      (event) => parseContributors(event.contributors) ?? recordedRoadConditionAttributions(event),
    ),
  );
}
