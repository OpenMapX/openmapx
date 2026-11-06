import type { TransitPlatformEvidence } from "./types/transit";

export interface PlatformStop {
  platform?: string;
  scheduledPlatform?: string;
  arrivalPlatform?: TransitPlatformEvidence;
  departurePlatform?: TransitPlatformEvidence;
}

/** A source correction is not an operational move. Unknown-to-known is not a change. */
export function selectStopPlatform(stop: PlatformStop, event: "arrival" | "departure") {
  const evidence = event === "arrival" ? stop.arrivalPlatform : stop.departurePlatform;
  const code = evidence?.code ?? stop.platform;
  const scheduledCode = evidence
    ? evidence.kind === "realtime"
      ? evidence.scheduledCode
      : evidence.code
    : stop.scheduledPlatform;
  return {
    code,
    scheduledCode,
    kind: evidence?.kind ?? "legacy",
    changed: (!evidence || evidence.kind === "realtime") && platformChanged(scheduledCode, code),
  };
}

/**
 * Whether a departure's current platform differs from its planned one.
 * Sources can add a platform's sections once they know where the train stops:
 * KVB plans "10" and later gives "10 A-B". That narrows the plan rather than
 * moving the departure, so it is no change.
 */
export function platformChanged(planned: string | undefined, current: string | undefined): boolean {
  const from = planned?.trim().toUpperCase();
  const to = current?.trim().toUpperCase();
  if (!from || !to || from === to) return false;
  return !to.startsWith(`${from} `) && !from.startsWith(`${to} `);
}
