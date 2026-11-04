import { type MobileNavigationSession, upcomingManeuverIndex } from "@openmapx/core/navigation";
import { SURFACE_FRESH_MS, type SurfaceModel, surfaceCopy, surfaceText } from "./surfaceModel";

const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const index = (v: unknown): number => (Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : -1);
function distance(v: unknown, imperial: boolean): string {
  const n = finite(v);
  if (n === null) return "";
  if (imperial)
    return n < 160.934 ? `${Math.round(n / 0.3048)} ft` : `${(n / 1609.344).toFixed(1)} mi`;
  return n < 1000 ? `${Math.round(n)} m` : `${(n / 1000).toFixed(1)} km`;
}
/** Read only the fields the OS surface needs from the committed durable session. */
export function projectSurface(
  s: MobileNavigationSession | null,
  now: number,
): SurfaceModel | null {
  if (!s || !["active", "arrived"].includes(s.status) || s.expiresAtMs <= now) return null;
  const copy = surfaceCopy[s.locale];
  const fix = s.lastAcceptedFix;
  const realFix = fix && !fix.coasted && fix.timestampMs <= now ? fix.timestampMs : 0;
  const observed = realFix;
  const fresh = observed > 0 && now - observed < SURFACE_FRESH_MS;
  let status: SurfaceModel["status"] =
    s.status === "arrived" ? "arrived" : fresh ? "active" : observed ? "stale" : "waiting";
  let instruction: string = copy.waiting;
  let title: string = s.kind === "ground" ? copy.navigation : copy.transit;
  let detail = "";
  let eventAtMs: number | null = null;
  let compactText: string = title;
  if (s.kind === "ground") {
    const progress = record(s.payload.progress);
    const route = record(s.payload.startPackage.route);
    const step = Array.isArray(route.steps)
      ? record(
          route.steps[
            upcomingManeuverIndex(Math.max(0, index(progress.currentStepIndex)), route.steps.length)
          ],
        )
      : {};
    instruction = surfaceText(step.instruction) || copy.navigation;
    compactText = distance(progress.distanceToNextManeuver, s.units === "imperial") || title;
    const remaining = distance(progress.distanceRemaining, s.units === "imperial");
    const seconds = finite(progress.durationRemaining);
    detail = [
      compactText === title ? "" : compactText,
      remaining,
      seconds === null ? "" : `${Math.ceil(seconds / 60)} min`,
    ]
      .filter(Boolean)
      .join(" · ");
    if (s.payload.coasting || fix?.coasted) {
      status = "stale";
      instruction = copy.stale;
    } else if (s.payload.offRoute || s.payload.reroute.status === "in-flight") {
      instruction = copy.reroute;
      detail = "";
      compactText = copy.reroute;
    } else if (s.payload.weakGps) {
      instruction = copy.gps;
      detail = "";
      compactText = "GPS?";
    }
  } else {
    const tick = s.payload.tickState;
    const itinerary = record(s.payload.startPackage.itinerary);
    const legs = Array.isArray(itinerary.legs) ? itinerary.legs : [];
    const leg = record(legs[tick.currentLegIndex]);
    const line = surfaceText(record(leg.route).shortName);
    title = [copy.transit, line, surfaceText(leg.headsign)].filter(Boolean).join(" · ");
    const destination = surfaceText(
      record(tick.phase === "waiting-to-board" ? leg.from : leg.to).name,
    );
    const eventTime = Date.parse(
      String(tick.phase === "waiting-to-board" ? (leg.startTime ?? "") : (leg.endTime ?? "")),
    );
    if (Number.isFinite(eventTime) && eventTime > now && eventTime <= s.expiresAtMs)
      eventAtMs = eventTime;
    const phase =
      tick.phase === "walking"
        ? copy.walk
        : tick.phase === "waiting-to-board"
          ? copy.board
          : tick.phase === "transferring"
            ? copy.transfer
            : copy.ride;
    instruction = `${phase} ${destination}`.trim();
    const captures = s.payload.startPackage.captures;
    const capture = captures.find((c) => c.legIndex === tick.currentLegIndex);
    const stops = capture && Array.isArray(capture.stops) ? capture.stops : [];
    const cursor = index(record(s.payload.progress).stopCursor ?? tick.stopCursor);
    if (stops.length && cursor >= 0 && cursor < stops.length)
      detail = `${stops.length - 1 - cursor} ${copy.stops}`;
    if (s.payload.confidence !== "gps") {
      status = "stale";
      detail = copy.schedule;
    }
    compactText = line || copy.transit;
  }
  if (status === "stale") {
    instruction = copy.stale;
    detail = s.kind === "transit" && s.payload.confidence === "schedule" ? copy.schedule : "";
    compactText = "GPS?";
  }
  if (status === "waiting") {
    instruction = copy.waiting;
    detail = "";
  }
  if (s.status === "arrived") {
    status = "arrived";
    instruction = copy.arrived;
    detail = "";
    compactText = "✓";
  }
  if (status !== "active") eventAtMs = null;
  const staleAtMs = Math.min(
    s.expiresAtMs,
    (observed || s.startedAtMs) + SURFACE_FRESH_MS,
    eventAtMs ?? Infinity,
  );
  return {
    version: 1,
    sessionId: s.sessionId,
    revision: s.revision,
    kind: s.kind,
    status,
    title: surfaceText(title),
    instruction: surfaceText(instruction),
    detail: surfaceText(detail),
    compactText: surfaceText(compactText),
    eventAtMs,
    observedAtMs: observed,
    staleAtMs,
    expiresAtMs: s.expiresAtMs,
    locale: s.locale,
  };
}
