import { type IncidentAlert, selectActiveAlert } from "@openmapx/core";

/**
 * Id prefix that marks a projected incident as crowd-sourced (as opposed to an
 * authoritative DATEX/agency feed). A crowd report published through the
 * contributions-api → road-conditions pipeline carries this on its observation
 * id, so confirm-on-approach can single out the reports a driver can vote on.
 */
export const CROWD_ORIGIN_PREFIXES = ["crowd:"] as const;

/** Whether a road-condition/observation id denotes a crowd-sourced report. */
export function isCrowdOriginId(id: string): boolean {
  return CROWD_ORIGIN_PREFIXES.some((p) => id.startsWith(p));
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
  const crowd = incidents.filter((i) => isCrowdOriginId(i.id));
  const active = selectActiveAlert(crowd, alongMeters, speedMps, [...dismissed]);
  return (active?.alert as IncidentAlert | undefined) ?? null;
}
