import type { TripItinerary, TripLeg } from "@openmapx/mobility-core/transit";
import type { TransitLegCapture } from "./mobileProtocol";
import { navOptionsForMode } from "./options";
import { snapPreparedRoute } from "./routeMatcher";
import { advanceStepGate } from "./stepGate";
import {
  isApproachingTransitAlight,
  type PreparedTransitProgress,
  prepareTransitProgress,
  type TransitPhase,
  type TransitProgress,
} from "./transitProgress";
import {
  isWithinStopArea,
  resolveTransitLegTargets,
  type TransitStopAreaIndex,
} from "./transitStopAreas";
import { advanceTransitStopCursor, type TransitStopTracking } from "./transitStopCursor";
import { selectLegPlatform } from "./transitStops";
import type { FixInput } from "./types";

export type { TransitPhase };
export type TransitConfidence = "gps" | "schedule" | "stale";
export type TransitRiderAction = {
  type: "board" | "alight" | "continue" | "undo";
  legIndex: number;
};
export interface TransitTickState {
  currentLegIndex: number;
  currentWalkStepIndex: number;
  walkRevision?: number;
  phase: TransitPhase;
  lastAcceptedFix?: FixInput;
  lastProgressAtMs?: number;
  legEnteredAtMs: number;
  spokenCueIds: string[];
  emittedEventIds: string[];
  stopCursor?: number;
  alongMeters?: number;
  stopTracking?: TransitStopTracking;
  reachedStepEnd?: boolean;
  distanceToNextStepMeters?: number;
  progressConfidence?: "gps" | "uncertain" | "stale";
  offPlan?: boolean;
  lastActionId?: string;
  lastAction?: {
    type: "board" | "alight" | "continue";
    legIndex: number;
    atMs: number;
    previous: {
      currentLegIndex: number;
      phase: TransitPhase;
      currentWalkStepIndex: number;
      stopCursor: number;
      alongMeters: number;
    };
  };
}
export type TransitNavigationEvent =
  | { id: string; type: "board" | "alight" | "missed-connection" | "arrival"; legIndex: number }
  | { id: string; type: "platform-change"; legIndex: number; platform: string }
  | { id: string; type: "approaching-alight"; legIndex: number; stopsRemaining: number }
  | { id: string; type: "transfer"; fromLegIndex: number; toLegIndex: number };
export interface TransitTickOptions {
  itineraryFingerprint: string;
  accuracyCapMeters: number;
}
/**
 * How long a board, alight or continue tap can be undone. Long enough to
 * notice a mistaken tap on the platform or as the doors close; short enough
 * that an undo cannot rewind a journey the rider has visibly moved on from.
 * Native keeps the location stream running this long after an arrival, so an
 * undo resumes a trip that is still being tracked.
 */
export const TRANSIT_UNDO_WINDOW_MS = 120_000;

export const DEFAULT_TRANSIT_TICK_OPTIONS: Omit<TransitTickOptions, "itineraryFingerprint"> = {
  accuracyCapMeters: 100,
};
export interface TransitTickResult {
  state: TransitTickState;
  events: TransitNavigationEvent[];
  confidence: TransitConfidence;
  needsReplan: boolean;
  actionRejected?: boolean;
  rejectedReason?: "low-accuracy" | "out-of-order" | "invalid" | "stale" | "future" | "coasted";
}
export interface TransitTickInput {
  itinerary: TripItinerary;
  captures: readonly TransitLegCapture[];
  state: TransitTickState;
  fix?: FixInput;
  action?: TransitRiderAction;
  nowMs: number;
  options: TransitTickOptions;
  prepared?: PreparedTransitProgress;
  stopAreas?: TransitStopAreaIndex;
}
export function isTransitRide(leg: TripLeg | undefined): boolean {
  return !!leg && (!!leg.tripId || (!!leg.route && leg.mode !== "walking"));
}
export function freshTransitTickState(nowMs: number, itinerary?: TripItinerary): TransitTickState {
  return {
    currentLegIndex: 0,
    currentWalkStepIndex: 0,
    phase: isTransitRide(itinerary?.legs[0]) ? "waiting-to-board" : "walking",
    legEnteredAtMs: nowMs,
    spokenCueIds: [],
    emittedEventIds: [],
    stopCursor: 1,
    alongMeters: 0,
  };
}

/** Physical progress belongs to GPS and rider actions; a timetable never commits it. */
export function processTransitFix(input: TransitTickInput): TransitTickResult {
  const { itinerary, nowMs, options } = input;
  const legs = itinerary.legs ?? [];
  const prepared = input.prepared ?? prepareTransitProgress(itinerary);
  const state: TransitTickState = {
    ...input.state,
    spokenCueIds: [...input.state.spokenCueIds],
    emittedEventIds: [...input.state.emittedEventIds],
  };
  const events: TransitNavigationEvent[] = [];
  const result: TransitTickResult = { state, events, confidence: "stale", needsReplan: false };
  const emit = (event: {
    type: "board" | "alight" | "arrival" | "platform-change" | "approaching-alight";
    legIndex: number;
    platform?: string;
    stopsRemaining?: number;
  }) => {
    let platformHash = 0;
    if (event.type === "platform-change" && event.platform)
      for (const c of event.platform)
        platformHash = (Math.imul(platformHash, 31) + c.charCodeAt(0)) >>> 0;
    const id = `${options.itineraryFingerprint}:${event.type}:${event.legIndex}${event.type === "platform-change" ? `:${platformHash.toString(36)}` : ""}`;
    if (state.emittedEventIds.includes(id)) return;
    state.emittedEventIds = [...state.emittedEventIds, id].slice(-512);
    events.push({ ...event, id } as TransitNavigationEvent);
  };
  const resetLeg = (index: number) => {
    const from = state.currentLegIndex;
    if (index !== from) {
      const id = `${options.itineraryFingerprint}:transfer:${from}:${index}`;
      if (!state.emittedEventIds.includes(id)) {
        state.emittedEventIds = [...state.emittedEventIds, id].slice(-512);
        events.push({ id, type: "transfer", fromLegIndex: from, toLegIndex: index });
      }
    }
    state.currentLegIndex = index;
    state.phase = isTransitRide(legs[index]) ? "waiting-to-board" : "walking";
    state.currentWalkStepIndex = 0;
    state.reachedStepEnd = false;
    state.distanceToNextStepMeters = undefined;
    state.stopCursor = 1;
    state.alongMeters = 0;
    state.stopTracking = undefined;
    state.legEnteredAtMs = nowMs;
  };
  if (
    state.phase !== "arrived" &&
    isTransitRide(legs[state.currentLegIndex]) &&
    state.phase === "walking"
  )
    state.phase = "waiting-to-board";
  if (state.phase === "waiting-to-board" && !isTransitRide(legs[state.currentLegIndex]))
    state.phase = "walking";
  const targets = resolveTransitLegTargets(itinerary, input.stopAreas);
  const fix = input.fix;
  let accepted: FixInput | undefined;
  if (fix) {
    if (
      !Number.isFinite(fix.coords[0]) ||
      !Number.isFinite(fix.coords[1]) ||
      Math.abs(fix.coords[0]) > 180 ||
      Math.abs(fix.coords[1]) > 90 ||
      !Number.isFinite(fix.accuracy) ||
      fix.accuracy < 0 ||
      !Number.isFinite(fix.timestampMs)
    )
      result.rejectedReason = "invalid";
    else if (fix.coasted) result.rejectedReason = "coasted";
    else if (fix.timestampMs < nowMs - 30000) result.rejectedReason = "stale";
    else if (fix.timestampMs > nowMs + 5000) result.rejectedReason = "future";
    else if (state.lastAcceptedFix && fix.timestampMs <= state.lastAcceptedFix.timestampMs)
      result.rejectedReason = "out-of-order";
    else if (fix.accuracy > options.accuracyCapMeters) result.rejectedReason = "low-accuracy";
    else accepted = fix;
  }
  const action = input.action;
  if (action) {
    if (action.type === "undo") {
      const previous = state.lastAction;
      if (
        previous &&
        previous.legIndex === action.legIndex &&
        nowMs - previous.atMs <= TRANSIT_UNDO_WINDOW_MS
      ) {
        Object.assign(state, previous.previous);
        state.lastAction = undefined;
        state.stopTracking = undefined;
        state.offPlan = false;
        state.legEnteredAtMs = nowMs;
      } else result.actionRejected = true;
    } else {
      const index = state.currentLegIndex;
      // A board tap on an access walk skips only to the immediately selected ride.
      const boardIndex =
        action.type === "continue" ? index + 1 : isTransitRide(legs[index]) ? index : index + 1;
      const valid =
        action.type === "continue"
          ? state.phase === "riding" &&
            action.legIndex === index &&
            !!legs[index + 1]?.interlineWithPrevious &&
            isTransitRide(legs[index + 1])
          : action.type === "board"
            ? state.phase !== "riding" &&
              state.phase !== "arrived" &&
              action.legIndex === boardIndex &&
              isTransitRide(legs[boardIndex]) &&
              !legs[boardIndex]?.cancelled
            : state.phase === "riding" && action.legIndex === index;
      if (!valid) result.actionRejected = true;
      else {
        state.lastAction = {
          type: action.type,
          legIndex: action.legIndex,
          atMs: nowMs,
          previous: {
            currentLegIndex: index,
            phase: state.phase,
            currentWalkStepIndex: state.currentWalkStepIndex,
            stopCursor: state.stopCursor ?? 1,
            alongMeters: state.alongMeters ?? 0,
          },
        };
        if (action.type === "board" || action.type === "continue") {
          resetLeg(boardIndex);
          state.phase = "riding";
          state.offPlan = false;
          emit({ type: "board", legIndex: boardIndex });
        } else {
          emit({ type: "alight", legIndex: index });
          const pos = accepted ?? state.lastAcceptedFix;
          const end = targets[index]?.end;
          state.offPlan =
            !!pos &&
            nowMs - pos.timestampMs <= 30000 &&
            !!end &&
            !isWithinStopArea(end, pos.coords, pos.accuracy);
          if (index === legs.length - 1) {
            state.phase = state.offPlan ? "transferring" : "arrived";
            if (!state.offPlan) emit({ type: "arrival", legIndex: index });
          } else resetLeg(index + 1);
        }
      }
    }
  }
  if (accepted) {
    const index = state.currentLegIndex;
    const leg = legs[index];
    const indexed = prepared.legs[index];
    const snap = indexed ? snapPreparedRoute(indexed.matcher, accepted.coords) : null;
    const corridor = 25 + Math.min(accepted.accuracy, 25);
    state.progressConfidence = snap && snap.deviationMeters > corridor ? "uncertain" : "gps";
    if (leg && state.phase !== "arrived") {
      if (state.phase === "riding") {
        const capture = input.captures.find(
          (c) => c.legIndex === index && c.tripId === leg.tripId && c.status === "captured",
        );
        if (capture) {
          const progress = advanceTransitStopCursor(
            capture.stops,
            indexed,
            accepted,
            state.lastAcceptedFix,
            state.stopCursor ?? 1,
            state.alongMeters ?? 0,
            state.stopTracking,
          );
          state.stopTracking = progress.tracking;
          state.stopCursor = progress.cursor;
          state.alongMeters = progress.alongMeters;
          state.progressConfidence = progress.trusted ? "gps" : "uncertain";
          if (
            progress.trusted &&
            isApproachingTransitAlight(capture.stops, state.stopCursor ?? 1, accepted.coords)
          )
            emit({
              type: "approaching-alight",
              legIndex: index,
              stopsRemaining: Math.max(1, capture.stops.length - (state.stopCursor ?? 1)),
            });
        }
      } else if (!isTransitRide(leg)) {
        if (snap && indexed && snap.deviationMeters <= corridor) {
          const steps = leg.steps ?? [];
          const total = steps.reduce((n, s) => n + s.distanceMeters, 0);
          const along =
            indexed.lengthMeters > 0 ? (snap.alongMeters / indexed.lengthMeters) * total : 0;
          const opts = navOptionsForMode("walking");
          const gate = advanceStepGate(
            { steps: steps.map((s) => ({ distance: s.distanceMeters })) },
            along,
            {
              committedStepIndex: state.currentWalkStepIndex,
              reachedStepEnd: state.reachedStepEnd ?? false,
            },
            opts.stepGateEntryMeters,
            opts.stepGateExitMeters,
          );
          state.currentWalkStepIndex = Math.min(
            gate.committedStepIndex,
            state.currentWalkStepIndex + 1,
          );
          state.reachedStepEnd = gate.reachedStepEnd;
          state.distanceToNextStepMeters = Math.max(
            0,
            steps
              .slice(0, state.currentWalkStepIndex + 1)
              .reduce((n, s) => n + s.distanceMeters, 0) - along,
          );
        }
        const shapes = targets[index]?.end;
        const endpoint = leg.geometry?.coordinates?.at(-1);
        const end =
          shapes ??
          (endpoint
            ? [
                {
                  type: "point" as const,
                  coordinates: endpoint as [number, number],
                  bufferMeters: 20,
                },
              ]
            : []);
        if (end.length > 0 && isWithinStopArea(end, accepted.coords, accepted.accuracy)) {
          state.offPlan = false;
          if (index === legs.length - 1) {
            state.phase = "arrived";
            emit({ type: "arrival", legIndex: index });
          } else resetLeg(index + 1);
        }
      }
      const board = selectLegPlatform(leg, index, input.captures, "departure");
      if (isTransitRide(leg) && state.phase !== "riding" && board.changed && board.code)
        emit({ type: "platform-change", legIndex: index, platform: board.code });
    }
    state.lastAcceptedFix = accepted;
    state.lastProgressAtMs = nowMs;
  }
  if (!state.lastAcceptedFix || nowMs - state.lastAcceptedFix.timestampMs > 30000)
    state.progressConfidence = "stale";
  result.confidence = state.progressConfidence === "stale" ? "stale" : "gps";
  return result;
}

/** Never use the callback's rejected coordinates as the rider position. */
export function transitProgressFromTick(
  state: TransitTickState,
  prepared: PreparedTransitProgress,
  _coords?: [number, number],
): TransitProgress {
  const coords = state.lastAcceptedFix?.coords;
  const indexed = prepared.legs[state.currentLegIndex];
  const match = coords && indexed ? snapPreparedRoute(indexed.matcher, coords) : null;
  return {
    currentLegIndex: state.currentLegIndex,
    ...(coords
      ? { position: coords, positionTimestampMs: state.lastAcceptedFix?.timestampMs }
      : {}),
    snapped: match?.snapped ?? coords ?? [0, 0],
    fractionAlongLeg:
      match && indexed && indexed.lengthMeters > 0 ? match.alongMeters / indexed.lengthMeters : 0,
    deviationMeters: match?.deviationMeters ?? 0,
    arrived: state.phase === "arrived",
    phase: state.phase,
    confidence: state.progressConfidence ?? "stale",
    stopCursor: state.stopCursor ?? 1,
    currentWalkStepIndex: state.currentWalkStepIndex,
    walkRevision: state.walkRevision ?? 0,
    distanceToNextStepMeters: state.distanceToNextStepMeters,
    offPlan: state.offPlan,
    canUndo: !!state.lastAction,
    lastActionLegIndex: state.lastAction?.legIndex,
    lastActionAtMs: state.lastAction?.atMs,
  };
}
