import type { LngLat } from "@openmapx/core";
import { timeZoneAt, tzDiffMinutes, tzOffsetLabel, viewerTimeZone } from "@openmapx/core";
import { useMemo } from "react";

export interface TripTimeZones {
  originTimeZone: string | null;
  destinationTimeZone: string | null;
  destinationOffsetLabel: string | null;
}

/** The zones a trip's start and arrival times render in, when they differ from the usual clock. */
export function useTripTimeZones(origin: LngLat | null, destination: LngLat | null): TripTimeZones {
  // Meaningful only when the origin and destination actually keep a
  // different wall clock. Two zones can differ by id (Europe/Berlin vs
  // Europe/Paris) yet share the same UTC offset, in which case the arrival
  // time is byte-identical to before this feature and there is nothing to
  // annotate — so this derives from a non-zero offset difference rather than
  // an id mismatch. Same-offset trips pass null, keeping every same-offset
  // itinerary a strict no-op.
  const destinationTimeZone = useMemo(() => {
    if (!origin || !destination) return null;
    const from = timeZoneAt(origin[1], origin[0]);
    const to = timeZoneAt(destination[1], destination[0]);
    if (!from || !to) return null;
    return tzDiffMinutes(new Date(), from, to) ? to : null;
  }, [origin, destination]);
  // Gate the caption on the resolved label rather than the zone id itself:
  // tzOffsetLabel can still fail on a stale or unrecognised tzid even after
  // destinationTimeZone resolved, in which case the arrival already fell
  // back to the viewer's zone and the caption would otherwise claim a
  // re-zoning that didn't happen.
  const destinationOffsetLabel = useMemo(
    () => (destinationTimeZone ? tzOffsetLabel(new Date(), destinationTimeZone) : null),
    [destinationTimeZone],
  );
  // The start renders in the origin's zone whenever that differs from the
  // viewer's own — otherwise "startTime" would keep rendering in the
  // viewer's zone while "endTime" renders in the destination's, producing a
  // span the two ends disagree about. Same-offset origins pass null, a
  // strict no-op.
  const viewerZone = viewerTimeZone();
  const originTimeZone = useMemo(() => {
    if (!origin) return null;
    const zone = timeZoneAt(origin[1], origin[0]);
    if (!zone) return null;
    return tzDiffMinutes(new Date(), viewerZone, zone) ? zone : null;
  }, [origin, viewerZone]);
  return { originTimeZone, destinationTimeZone, destinationOffsetLabel };
}
