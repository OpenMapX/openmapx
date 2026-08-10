import type { TransitMobileSession } from "@openmapx/core/navigation";
import type { ScheduledNotification } from "../../notifications/NotificationScheduler";
import { notificationIdFor } from "../../notifications/notificationIds";
import { boundedName } from "./transitCue";

/**
 * The get-off backup.
 *
 * Speech can be missed — headphones out, a loud carriage, a phone call, a device
 * the operating system suspended. Missing your stop is the one transit failure a
 * rider cannot recover from quickly, so a scheduled local notification exists
 * independently of everything else: the operating system holds it, and it fires
 * whether or not this app's JavaScript is still running.
 *
 * Because it is a backup, it is deliberately conservative:
 *
 *  - it uses the *captured* stop times first, which were fetched while the
 *    connection worked, and falls back to the itinerary's own arrival minus a
 *    few minutes only when there is no capture;
 *  - it schedules one alert, for the leg being ridden, under a stable identifier
 *    so a live update replaces rather than duplicates it;
 *  - it never schedules for a leg already finished, cancelled or in the past.
 */

/** How far before the itinerary's arrival to warn, when no capture exists. */
export const SCHEDULE_FALLBACK_LEAD_MS = 3 * 60_000;
/** A trigger closer than this is not worth scheduling; it has effectively passed. */
export const MIN_LEAD_MS = 5_000;

export interface AlightAlert extends ScheduledNotification {
  legIndex: number;
  /** Whether the time came from captured stop data or from the plan alone. */
  basis: "captured" | "schedule";
}

interface LegLike {
  mode?: string;
  route?: unknown;
  to?: { name?: string; platformCode?: string };
  endTime?: string;
  scheduledEndTime?: string;
  cancelled?: boolean;
}

function legsOf(session: TransitMobileSession): LegLike[] {
  return ((session.payload.startPackage.itinerary as { legs?: LegLike[] }).legs ?? []) as LegLike[];
}

function parseTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * When to warn, and on what evidence.
 *
 * The penultimate captured stop's departure is the best signal available: once
 * the train leaves it, the next stop is the rider's. Without a capture the plan's
 * own arrival is all there is, and the wording says so.
 */
function triggerFor(
  session: TransitMobileSession,
  leg: LegLike,
  legIndex: number,
): { atMs: number; basis: AlightAlert["basis"] } | null {
  const capture = session.payload.startPackage.captures.find(
    (entry) => entry.legIndex === legIndex,
  );

  if (capture?.status === "captured" && capture.stops.length >= 2) {
    const penultimate = capture.stops[capture.stops.length - 2];
    const atMs =
      parseTime(penultimate.expectedDeparture) ?? parseTime(penultimate.scheduledDeparture);
    if (atMs !== null) return { atMs, basis: "captured" };
  }

  const arrivalMs = parseTime(leg.endTime) ?? parseTime(leg.scheduledEndTime);
  if (arrivalMs === null) return null;
  return { atMs: arrivalMs - SCHEDULE_FALLBACK_LEAD_MS, basis: "schedule" };
}

export interface AlightAlertCopy {
  title: (stop: string) => string;
  body: (stop: string, basis: AlightAlert["basis"], platform?: string) => string;
}

/**
 * Computes the one alert this session should currently hold, or nothing.
 *
 * Content is composed here from the validated itinerary, never from anything a
 * bridge command supplied — a scheduler that accepted arbitrary text would let
 * the page post any notification it liked under the app's name.
 */
export function computeAlightAlert(
  session: TransitMobileSession,
  nowMs: number,
  copy: AlightAlertCopy,
): AlightAlert | null {
  if (!session.payload.startPackage.settings.alightAlertsEnabled) return null;
  if (session.status !== "active" && session.status !== "preparing") return null;

  const { tickState } = session.payload;
  if (tickState.phase === "arrived") return null;

  const legIndex = tickState.currentLegIndex;
  const leg = legsOf(session)[legIndex];
  if (!leg) return null;
  // Only a ride has a stop to miss; a walk does not.
  if (leg.mode === "walking" || !leg.route) return null;
  if (leg.cancelled) return null;

  const stop = boundedName(leg.to?.name);
  if (!stop) return null;

  const trigger = triggerFor(session, leg, legIndex);
  if (!trigger) return null;
  // A trigger that has effectively passed would fire immediately and mean
  // nothing; the spoken cue already covers that moment.
  if (trigger.atMs - nowMs < MIN_LEAD_MS) return null;
  if (trigger.atMs >= session.expiresAtMs) return null;

  const platform = boundedName(leg.to?.platformCode, 64);

  return {
    // Stable across a live update, so a new expected time replaces the alert
    // rather than adding a second one.
    id: notificationIdFor(
      session.sessionId,
      "alight",
      `${session.payload.startPackage.itineraryFingerprint}:${legIndex}`,
    ),
    category: "alight",
    legIndex,
    basis: trigger.basis,
    triggerAtMs: trigger.atMs,
    title: copy.title(stop),
    body: copy.body(stop, trigger.basis, platform ?? undefined),
  };
}

/**
 * Whether a newly computed alert actually differs from what is already held.
 *
 * Rescheduling on every tick would cancel and re-add an operating-system request
 * once a second, which some platforms rate-limit and all of them treat as churn.
 */
export function alertHasChanged(
  current: { alertId: string; triggerAtMs: number } | undefined,
  next: AlightAlert | null,
): boolean {
  if (!current && !next) return false;
  if (!current || !next) return true;
  if (current.alertId !== next.id) return true;
  // A shift smaller than the scheduling floor is not worth a round trip.
  return Math.abs(current.triggerAtMs - next.triggerAtMs) >= MIN_LEAD_MS;
}
