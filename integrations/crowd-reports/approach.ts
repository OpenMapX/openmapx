import { type IncidentAlert, selectActiveAlert } from "@openmapx/core";

/**
 * Whether a projected incident is a crowd-sourced situation (as opposed to an
 * authoritative DATEX/agency feed) — the reports a driver can vote on. The
 * road-conditions pipeline carries each situation's origin through to the
 * projected alert.
 */
export function isCrowdIncident(incident: Pick<IncidentAlert, "origin">): boolean {
  return incident.origin === "crowd";
}

/**
 * From the incidents already projected onto the route (by `useNavIncidents`),
 * pick the crowd-sourced one the driver should be prompted about right now —
 * gated by the SAME speed-scaled approach window the nav voice alerts use
 * (`selectActiveAlert`, `approach.minM/maxM` clamped around `speedMps·leadSec`).
 * Only crowd reports that are ahead AND within that window qualify, so the
 * prompt fires seconds before the report — not up to the 25 km look-ahead cap.
 *
 * `dismissed` ids are passed as the "already announced" set so a dismissed or
 * voted-on report never re-prompts. Pure; returns null when nothing qualifies.
 */
export function selectCrowdApproach(
  incidents: IncidentAlert[],
  alongMeters: number,
  speedMps: number,
  dismissed: readonly string[] = [],
): IncidentAlert | null {
  const crowd = incidents.filter(isCrowdIncident);
  const active = selectActiveAlert(crowd, alongMeters, speedMps, [...dismissed]);
  return (active?.alert as IncidentAlert | undefined) ?? null;
}
