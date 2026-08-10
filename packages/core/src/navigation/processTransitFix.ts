import type { TransitStep, TripItinerary } from "@openmapx/mobility-core/transit";
import type { TransitLegCapture } from "./mobileProtocol";
import { snapPreparedRoute } from "./routeMatcher";
import { type PreparedTransitProgress, prepareTransitProgress } from "./transitProgress";
import { walkLegStepProgress } from "./transitWalk";
import type { FixInput } from "./types";

/**
 * Stateful transit navigation.
 *
 * The existing `computeTransitProgress` picks whichever leg is geometrically
 * closest on every fix. That is fine for drawing a banner, and wrong for
 * guidance: a bus that passes near the return leg of a loop would "advance" the
 * traveller two legs and then snap back, and the alighting cue would fire in the
 * wrong place.
 *
 * This engine instead holds a position and defends it. It only ever considers
 * the current leg, the next one, and — inside a short recovery window — the
 * previous one. It advances at most one leg per call, and once riding progress
 * is established it never goes backwards.
 *
 * It is pure: one optional fix, the captured itinerary, prior state, and an
 * explicit `nowMs` in; new state and typed events out. No clock, no network, no
 * storage, no localisation.
 */

export type TransitPhase = "walking" | "waiting-to-board" | "riding" | "transferring" | "arrived";
export type TransitConfidence = "gps" | "schedule" | "stale";

export interface TransitTickState {
  currentLegIndex: number;
  currentWalkStepIndex: number;
  phase: TransitPhase;
  lastAcceptedFix?: FixInput;
  lastProgressAtMs?: number;
  legEnteredAtMs: number;
  recoveryUntilMs?: number;
  spokenCueIds: string[];
  emittedEventIds: string[];
  scheduleFallback: "inactive" | "eligible" | "active";
  replanRequestedForLeg?: number;
}

export type TransitNavigationEvent =
  | { id: string; type: "board"; legIndex: number }
  | { id: string; type: "platform-change"; legIndex: number; platform: string }
  | { id: string; type: "approaching-alight"; legIndex: number; stopsRemaining: number }
  | { id: string; type: "alight"; legIndex: number }
  | { id: string; type: "transfer"; fromLegIndex: number; toLegIndex: number }
  | { id: string; type: "missed-connection"; legIndex: number }
  | { id: string; type: "arrival"; legIndex: number };

export interface TransitTickOptions {
  /** Stable per-itinerary identity; cue and event ids hang off it. */
  itineraryFingerprint: string;
  /** Reject fixes worse than this (metres). */
  accuracyCapMeters: number;
  /** Seconds without an accepted fix before schedule fallback may engage. */
  scheduleFallbackAfterSeconds: number;
  /** Grace (seconds) past a leg's scheduled end before fallback advances it. */
  scheduleFallbackGraceSeconds: number;
}

export const DEFAULT_TRANSIT_TICK_OPTIONS: Omit<TransitTickOptions, "itineraryFingerprint"> = {
  accuracyCapMeters: 100,
  scheduleFallbackAfterSeconds: 120,
  scheduleFallbackGraceSeconds: 120,
};

export interface TransitTickResult {
  state: TransitTickState;
  events: TransitNavigationEvent[];
  confidence: TransitConfidence;
  /** True when the engine wants a replacement itinerary; emitted once per leg. */
  needsReplan: boolean;
  /** Set when the fix was refused, so a caller can record why without guessing. */
  rejectedReason?: "low-accuracy" | "out-of-order" | "invalid";
}

/* ---------------------------------------------------------------- tuning --- */

/** Fraction of the current leg that counts as "essentially finished". */
const ADVANCE_FRACTION = 0.85;
/** Deviation (m) at which the next leg is a plausible match. */
const NEXT_LEG_DEVIATION_METERS = 120;
/** Distance (m) from the current leg's endpoint that also allows advancing. */
const ENDPOINT_PROXIMITY_METERS = 80;
/** Distance (m) from the board stop below which the traveller is waiting there. */
const BOARD_STOP_PROXIMITY_METERS = 60;
/** How long after entering a leg a correction back to the previous one is allowed. */
const RECOVERY_WINDOW_MS = 90_000;
/** Progress on the new leg beyond which recovery is refused. */
const RECOVERY_MAX_FRACTION = 0.1;
/** How much better the previous leg must fit before recovery is accepted (m). */
const RECOVERY_DEVIATION_MARGIN_METERS = 50;
/** Stops remaining at which the alighting warning fires. */
const APPROACHING_ALIGHT_STOPS = 1;

/* --------------------------------------------------------------- helpers --- */

export function freshTransitTickState(nowMs: number): TransitTickState {
  return {
    currentLegIndex: 0,
    currentWalkStepIndex: 0,
    phase: "walking",
    legEnteredAtMs: nowMs,
    spokenCueIds: [],
    emittedEventIds: [],
    scheduleFallback: "inactive",
  };
}

function eventId(
  fingerprint: string,
  type: string,
  legIndex: number,
  suffix?: string | number,
): string {
  // Identity is structural — never a stop name, which can change between
  // refreshes and would silently re-fire a cue.
  return suffix === undefined
    ? `${fingerprint}:${type}:${legIndex}`
    : `${fingerprint}:${type}:${legIndex}:${suffix}`;
}

function legAt(itinerary: TripItinerary, index: number) {
  return (itinerary.legs ?? [])[index];
}

function isTransitLeg(leg: unknown): boolean {
  return Boolean((leg as { tripId?: string } | undefined)?.tripId);
}

function legEndMs(leg: unknown): number {
  const end = (leg as { endTime?: string } | undefined)?.endTime;
  const parsed = end ? new Date(end).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function legStartMs(leg: unknown): number {
  const start = (leg as { startTime?: string } | undefined)?.startTime;
  const parsed = start ? new Date(start).getTime() : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

interface LegMatch {
  fraction: number;
  deviationMeters: number;
  snapped: [number, number];
}

function matchLeg(
  prepared: PreparedTransitProgress,
  legIndex: number,
  coords: [number, number],
): LegMatch | null {
  const leg = prepared.legs[legIndex];
  if (!leg) return null;
  const snap = snapPreparedRoute(leg.matcher, coords);
  const fraction = leg.lengthMeters > 0 ? snap.alongMeters / leg.lengthMeters : 0;
  return {
    fraction: Math.max(0, Math.min(1, fraction)),
    deviationMeters: snap.deviationMeters,
    snapped: snap.snapped as [number, number],
  };
}

function metresBetween(a: [number, number], b: [number, number]): number {
  const R = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function captureFor(captures: readonly TransitLegCapture[], legIndex: number) {
  return captures.find((capture) => capture.legIndex === legIndex);
}

/** Stops still ahead on the ridden leg, from the captured slice. */
function stopsRemainingOnLeg(
  captures: readonly TransitLegCapture[],
  legIndex: number,
  snapped: [number, number],
): number | null {
  const capture = captureFor(captures, legIndex);
  if (capture?.status !== "captured" || capture.stops.length === 0) return null;
  // The captured slice is board→alight in ride order, so "remaining" is simply
  // how many entries sit after the nearest one.
  let nearestIndex = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;
  capture.stops.forEach((stop, index) => {
    const distance = metresBetween(snapped, [stop.lng, stop.lat]);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = index;
    }
  });
  return Math.max(0, capture.stops.length - 1 - nearestIndex);
}

export interface TransitTickInput {
  itinerary: TripItinerary;
  captures: readonly TransitLegCapture[];
  state: TransitTickState;
  /** Omitted when the callback delivered no usable fix (tunnel, denied, gap). */
  fix?: FixInput;
  nowMs: number;
  options: TransitTickOptions;
  /** Reused across ticks; rebuilt transparently after process death. */
  prepared?: PreparedTransitProgress;
}

/**
 * Advances transit navigation by one tick.
 *
 * Called for every accepted location batch *and* for legitimate wake-ups that
 * carried no fix, so schedule fallback can keep the banner honest without an
 * independent background timer.
 */
export function processTransitFix(input: TransitTickInput): TransitTickResult {
  const { itinerary, captures, nowMs, options } = input;
  const legs = itinerary.legs ?? [];
  const prepared = input.prepared ?? prepareTransitProgress(itinerary);

  const state: TransitTickState = {
    ...input.state,
    spokenCueIds: [...input.state.spokenCueIds],
    emittedEventIds: [...input.state.emittedEventIds],
  };
  const events: TransitNavigationEvent[] = [];
  let needsReplan = false;

  const emit = (event: TransitNavigationEvent) => {
    if (state.emittedEventIds.includes(event.id)) return;
    state.emittedEventIds.push(event.id);
    events.push(event);
  };

  if (state.phase === "arrived") {
    return { state, events, confidence: "gps", needsReplan: false };
  }

  /* ------------------------------------------------------- fix admission --- */

  const fix = input.fix;
  let rejectedReason: TransitTickResult["rejectedReason"];
  let accepted: FixInput | undefined;

  if (fix) {
    const validCoords =
      Number.isFinite(fix.coords[0]) &&
      Number.isFinite(fix.coords[1]) &&
      Math.abs(fix.coords[0]) <= 180 &&
      Math.abs(fix.coords[1]) <= 90;
    if (!validCoords || !Number.isFinite(fix.accuracy) || fix.accuracy < 0) {
      rejectedReason = "invalid";
    } else if (state.lastAcceptedFix && fix.timestampMs <= state.lastAcceptedFix.timestampMs) {
      rejectedReason = "out-of-order";
    } else if (fix.accuracy > options.accuracyCapMeters) {
      rejectedReason = "low-accuracy";
    } else {
      accepted = fix;
    }
  }

  /* --------------------------------------------------------- leg tracking --- */

  if (accepted) {
    const coords = accepted.coords as [number, number];
    const current = matchLeg(prepared, state.currentLegIndex, coords);
    const next = matchLeg(prepared, state.currentLegIndex + 1, coords);

    // A narrowly-scoped correction: only just after entering a leg, only before
    // meaningful progress on it, and only when the previous leg fits clearly
    // better. Beyond that the engine never goes backwards.
    const withinRecovery =
      nowMs - state.legEnteredAtMs <= RECOVERY_WINDOW_MS &&
      (current?.fraction ?? 1) < RECOVERY_MAX_FRACTION &&
      state.phase !== "riding";
    if (withinRecovery && state.currentLegIndex > 0) {
      const previous = matchLeg(prepared, state.currentLegIndex - 1, coords);
      if (
        previous &&
        current &&
        previous.deviationMeters + RECOVERY_DEVIATION_MARGIN_METERS < current.deviationMeters
      ) {
        state.currentLegIndex -= 1;
        state.currentWalkStepIndex = 0;
        state.legEnteredAtMs = nowMs;
        state.phase = isTransitLeg(legAt(itinerary, state.currentLegIndex))
          ? "waiting-to-board"
          : "walking";
      }
    }

    const match = matchLeg(prepared, state.currentLegIndex, coords);
    const leg = legAt(itinerary, state.currentLegIndex);

    if (match) {
      const endpointDistance = (() => {
        const legGeometry = (leg as { geometry?: { coordinates?: [number, number][] } } | undefined)
          ?.geometry?.coordinates;
        const endpoint = legGeometry?.at(-1);
        return endpoint ? metresBetween(coords, endpoint) : Number.POSITIVE_INFINITY;
      })();

      const scheduledEnd = legEndMs(leg);
      const plausibleByTime = !Number.isFinite(scheduledEnd) || nowMs >= scheduledEnd - 5 * 60_000;

      const nextIsCloser = next !== null && next.deviationMeters <= NEXT_LEG_DEVIATION_METERS;
      const alightProximity = stopsRemainingOnLeg(captures, state.currentLegIndex, match.snapped);

      const shouldAdvance =
        state.currentLegIndex < legs.length - 1 &&
        ((match.fraction >= ADVANCE_FRACTION && nextIsCloser) ||
          (endpointDistance <= ENDPOINT_PROXIMITY_METERS && plausibleByTime) ||
          (alightProximity === 0 && state.phase === "riding"));

      // Phase within the leg, before any advance.
      if (isTransitLeg(leg)) {
        const boardStop = captureFor(captures, state.currentLegIndex)?.stops[0];
        const nearBoardStop =
          boardStop !== undefined &&
          metresBetween(coords, [boardStop.lng, boardStop.lat]) <= BOARD_STOP_PROXIMITY_METERS;
        const departed = Number.isFinite(legStartMs(leg)) && nowMs >= legStartMs(leg);

        if (state.phase !== "riding" && (match.fraction > 0.05 || (departed && !nearBoardStop))) {
          state.phase = "riding";
          emit({
            id: eventId(options.itineraryFingerprint, "board", state.currentLegIndex),
            type: "board",
            legIndex: state.currentLegIndex,
          });
        } else if (state.phase !== "riding") {
          state.phase = "waiting-to-board";
        }

        const capture = captureFor(captures, state.currentLegIndex);
        const changedPlatform = capture?.stops[0];
        if (
          changedPlatform?.platform &&
          changedPlatform.scheduledPlatform &&
          changedPlatform.platform !== changedPlatform.scheduledPlatform
        ) {
          emit({
            id: eventId(
              options.itineraryFingerprint,
              "platform-change",
              state.currentLegIndex,
              changedPlatform.platform,
            ),
            type: "platform-change",
            legIndex: state.currentLegIndex,
            platform: changedPlatform.platform,
          });
        }

        if (
          state.phase === "riding" &&
          alightProximity !== null &&
          alightProximity <= APPROACHING_ALIGHT_STOPS
        ) {
          emit({
            id: eventId(options.itineraryFingerprint, "approaching-alight", state.currentLegIndex),
            type: "approaching-alight",
            legIndex: state.currentLegIndex,
            stopsRemaining: alightProximity,
          });
        }
      } else {
        state.phase = "walking";
        const steps = ((leg as { steps?: { distanceMeters?: number }[] } | undefined)?.steps ??
          []) as Pick<TransitStep, "distanceMeters">[];
        if (steps.length > 0) {
          const walk = walkLegStepProgress(steps, match.fraction);
          // Walking steps only ever move forward within a leg.
          state.currentWalkStepIndex = Math.max(state.currentWalkStepIndex, walk.currentStepIndex);
        }
      }

      if (shouldAdvance) {
        const from = state.currentLegIndex;
        if (isTransitLeg(leg)) {
          emit({
            id: eventId(options.itineraryFingerprint, "alight", from),
            type: "alight",
            legIndex: from,
          });
        }
        state.currentLegIndex = from + 1;
        state.currentWalkStepIndex = 0;
        state.legEnteredAtMs = nowMs;
        state.phase = isTransitLeg(legAt(itinerary, state.currentLegIndex))
          ? "waiting-to-board"
          : "walking";
        emit({
          id: eventId(options.itineraryFingerprint, "transfer", from, state.currentLegIndex),
          type: "transfer",
          fromLegIndex: from,
          toLegIndex: state.currentLegIndex,
        });
      }

      // Arrival is only ever asserted from a real fix on the final leg.
      if (state.currentLegIndex === legs.length - 1 && match.fraction >= 0.98 && legs.length > 0) {
        state.phase = "arrived";
        emit({
          id: eventId(options.itineraryFingerprint, "arrival", state.currentLegIndex),
          type: "arrival",
          legIndex: state.currentLegIndex,
        });
      }
    }

    state.lastAcceptedFix = accepted;
    state.lastProgressAtMs = nowMs;
    state.scheduleFallback = "inactive";
  }

  /* ---------------------------------------------------- missed connection --- */
  //
  // Evaluated before schedule fallback: fallback advances the leg, and if it
  // ran first it would step straight past the departure that was missed and
  // the traveller would never be told.

  const upcoming = legAt(itinerary, state.currentLegIndex);
  if (state.phase !== "arrived" && isTransitLeg(upcoming)) {
    const departure = legStartMs(upcoming);
    const missed =
      Number.isFinite(departure) && nowMs > departure + 120_000 && state.phase !== "riding";
    if (missed && state.replanRequestedForLeg !== state.currentLegIndex) {
      state.replanRequestedForLeg = state.currentLegIndex;
      needsReplan = true;
      emit({
        id: eventId(options.itineraryFingerprint, "missed-connection", state.currentLegIndex),
        type: "missed-connection",
        legIndex: state.currentLegIndex,
      });
    }
  }

  /* ----------------------------------------------------- schedule fallback --- */

  let confidence: TransitConfidence = accepted ? "gps" : "stale";

  if (!accepted && state.phase !== "arrived") {
    const sinceProgress = state.lastProgressAtMs ? nowMs - state.lastProgressAtMs : Infinity;
    const eligible = sinceProgress >= options.scheduleFallbackAfterSeconds * 1_000;
    if (eligible) {
      state.scheduleFallback =
        state.scheduleFallback === "inactive" ? "eligible" : state.scheduleFallback;
      const leg = legAt(itinerary, state.currentLegIndex);
      const end = legEndMs(leg);
      const dueToAdvance =
        Number.isFinite(end) &&
        nowMs >= end + options.scheduleFallbackGraceSeconds * 1_000 &&
        state.currentLegIndex < legs.length - 1;

      if (dueToAdvance) {
        // At most one leg per tick, and labelled: time alone never asserts that
        // the traveller physically arrived anywhere.
        const from = state.currentLegIndex;
        state.currentLegIndex = from + 1;
        state.currentWalkStepIndex = 0;
        state.legEnteredAtMs = nowMs;
        state.phase = isTransitLeg(legAt(itinerary, state.currentLegIndex))
          ? "waiting-to-board"
          : "walking";
        state.scheduleFallback = "active";
        emit({
          id: eventId(options.itineraryFingerprint, "transfer", from, state.currentLegIndex),
          type: "transfer",
          fromLegIndex: from,
          toLegIndex: state.currentLegIndex,
        });
      }
      confidence = "schedule";
    }
  }

  return {
    state,
    events,
    confidence,
    needsReplan,
    ...(rejectedReason && { rejectedReason }),
  };
}
