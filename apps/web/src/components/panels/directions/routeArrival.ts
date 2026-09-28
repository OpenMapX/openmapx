import { viewerTimeZone, zonedWallClockToInstant } from "@openmapx/core";

export type RouteArrivalContext =
  | { kind: "now"; destinationTimeZone?: string | null }
  | {
      kind: "departAt";
      wallClock: string;
      originTimeZone?: string | null;
      destinationTimeZone?: string | null;
    }
  | { kind: "arriveBy"; wallClock: string; destinationTimeZone?: string | null }
  | { kind: "scheduled"; arrival: string; destinationTimeZone?: string | null };

/** A deadline is a constraint, not an engine-reported arrival instant. */
export function resolveRouteArrival(
  context: RouteArrivalContext,
  durationSeconds: number,
  nowMs: number,
): { at: Date; isDeadline: boolean } | null {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return null;

  let at: Date | null;
  switch (context.kind) {
    case "now":
      at = new Date(nowMs + durationSeconds * 1000);
      break;
    case "departAt": {
      const departure = zonedWallClockToInstant(
        context.originTimeZone ?? viewerTimeZone(),
        context.wallClock,
      );
      at = departure ? new Date(departure.getTime() + durationSeconds * 1000) : null;
      break;
    }
    case "arriveBy":
      // Valhalla's arrival-time request is local to the destination. It does
      // not report an exact arrival, only a deadline.
      at = zonedWallClockToInstant(
        context.destinationTimeZone ?? viewerTimeZone(),
        context.wallClock,
      );
      break;
    case "scheduled":
      at = new Date(context.arrival);
      break;
  }

  return at && Number.isFinite(at.getTime())
    ? { at, isDeadline: context.kind === "arriveBy" }
    : null;
}
