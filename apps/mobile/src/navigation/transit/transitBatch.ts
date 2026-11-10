import {
  composeWalkInstruction,
  DEFAULT_TRANSIT_TICK_OPTIONS,
  type FixInput,
  type PreparedTransitProgress,
  prepareTransitProgress,
  processTransitFix,
  type TransitMobileSession,
  type TransitNavigationEvent,
  type TransitRiderAction,
  type TransitTickState,
  transitProgressFromTick,
  transitWalkVoiceCue,
  walkStepInfo,
} from "@openmapx/core/navigation";
import { createTranslator } from "@openmapx/i18n";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import type { SessionEffect } from "../../storage/SessionRepository";
import type { ProcessorMutation } from "../processor";
import { transitCueEffect, transitWalkCueEffect } from "./transitCue";
import { transitProfileForTime } from "./transitSession";

/**
 * One batch of fixes — or one wake-up with no fix at all — becomes one committed
 * revision.
 *
 * No-fix wake-ups update freshness while retaining the selected leg and last
 * known rider position. Timetable estimates never commit a physical transition.
 *
 * What this deliberately does not do is run a timer. A tick happens because the
 * operating system delivered a callback or the app is visible — never because
 * JavaScript decided it was time, which it cannot know while suspended.
 */

/** Prepared geometry and occurrence projections survive per-fix storage deserialization. */
export class TransitItineraryCache {
  private key: string | null = null;
  private prepared: PreparedTransitProgress | null = null;
  private captures: TransitMobileSession["payload"]["startPackage"]["captures"] = [];

  preparedFor(session: TransitMobileSession): PreparedTransitProgress {
    const key = `${session.sessionId}:${session.payload.startPackage.itineraryFingerprint}:${session.payload.navigationDataRevision ?? 0}`;
    if (this.key !== key || !this.prepared) {
      this.prepared = prepareTransitProgress(session.payload.startPackage.itinerary as never);
      this.captures = session.payload.startPackage.captures;
      this.key = key;
    }
    return this.prepared;
  }
  capturesFor(session: TransitMobileSession) {
    this.preparedFor(session);
    return this.captures;
  }
  invalidate(): void {
    this.key = null;
    this.prepared = null;
    this.captures = [];
  }
}

export interface TransitBatchOutcome extends ProcessorMutation {
  arrived: boolean;
  needsReplan: boolean;
  actionRejected?: boolean;
  events: TransitNavigationEvent[];
}

export interface ProcessTransitBatchInput {
  session: TransitMobileSession;
  /** Empty for a wake-up that carried no usable position. */
  fixes: readonly FixInput[];
  nowMs: number;
  cache: TransitItineraryCache;
  action?: TransitRiderAction;
}

/** Events that must reach the rider even if the page is not there to show them. */
const CRITICAL_EVENTS = new Set<TransitNavigationEvent["type"]>([
  "board",
  "platform-change",
  "approaching-alight",
  "alight",
  "transfer",
  "missed-connection",
  "arrival",
]);

export function processTransitBatch(input: ProcessTransitBatchInput): TransitBatchOutcome {
  const { session, fixes, nowMs, cache } = input;
  const { startPackage } = session.payload;
  const prepared = cache.preparedFor(session);

  const options = {
    ...DEFAULT_TRANSIT_TICK_OPTIONS,
    itineraryFingerprint: startPackage.itineraryFingerprint,
  };

  let tickState = {
    ...session.payload.tickState,
    ...(session.lastAcceptedFix ? { lastAcceptedFix: session.lastAcceptedFix } : {}),
  };
  let confidence = session.payload.confidence;
  let needsReplan = false;
  let actionRejected = false;
  const allEvents: TransitNavigationEvent[] = [];

  // A wake-up with no fix still updates confidence.
  const ticks: Array<FixInput | undefined> = fixes.length > 0 ? [...fixes] : [undefined];

  for (const fix of ticks) {
    const result = processTransitFix({
      itinerary: startPackage.itinerary as never,
      captures: cache.capturesFor(session),
      state: tickState as never,
      action: input.action,
      ...(fix ? { fix } : {}),
      nowMs,
      options,
      prepared,
      ...(startPackage.stopAreas ? { stopAreas: startPackage.stopAreas } : {}),
    });
    actionRejected ||= !!result.actionRejected;
    tickState = result.state as never;
    confidence = result.confidence;
    if (result.needsReplan) needsReplan = true;
    allEvents.push(...result.events);
  }

  const progress = followAlongProgress(
    tickState as TransitTickState,
    prepared,
    startPackage.itinerary as never,
  );

  const effects: SessionEffect[] = [];
  const enqueue: Array<{ eventId: string; critical: boolean; payload: unknown }> = [];
  const eventIds: string[] = [];
  const spokenCueIds: string[] = [];
  let arrived = false;

  for (const event of allEvents) {
    if (event.type === "arrival") arrived = true;
    if (session.cueLedger.events.includes(event.id)) continue;
    eventIds.push(event.id);
    enqueue.push({
      eventId: event.id,
      critical: CRITICAL_EVENTS.has(event.type),
      // Only the event's own structural fields travel: no stop name, no
      // coordinate, nothing the outbox would still hold after the trip ended.
      payload: { type: event.type, legIndex: "legIndex" in event ? event.legIndex : undefined },
    });

    const cue = transitCueEffect(session, event);
    if (!cue) continue;
    if (session.cueLedger.spoken.includes(cue.cueId)) continue;
    spokenCueIds.push(cue.cueId);
    if (startPackage.settings.voiceEnabled) effects.push(cue.effect);
  }

  if (tickState.phase === "walking" && tickState.progressConfidence === "gps") {
    const leg = (startPackage.itinerary as unknown as TripItinerary).legs[
      tickState.currentLegIndex
    ];
    const step = leg?.steps?.[tickState.currentWalkStepIndex + 1];
    if (step) {
      const t = createTranslator(session.locale, "navigation");
      const text = composeWalkInstruction(walkStepInfo(step), t);
      const prefix = `walk:${tickState.currentLegIndex}:${tickState.walkRevision ?? 0}:`;
      const namespace = `${session.sessionId}:transit:${startPackage.itineraryFingerprint}:`;
      const timing = transitWalkVoiceCue(
        step,
        tickState.currentWalkStepIndex,
        tickState.distanceToNextStepMeters ?? Infinity,
        tickState.lastAcceptedFix?.speed ?? 0,
        text,
        session.cueLedger.spoken
          .filter((id) => id.startsWith(namespace + prefix))
          .map((id) => id.slice((namespace + prefix).length)),
      );
      const cue = timing
        ? transitWalkCueEffect(session, prefix + timing.key, text, undefined, timing)
        : null;
      if (cue && !session.cueLedger.spoken.includes(cue.cueId)) {
        spokenCueIds.push(cue.cueId);
        if (startPackage.settings.voiceEnabled) effects.push(cue.effect);
      }
    }
  }

  const next: TransitMobileSession = {
    ...session,
    revision: session.revision + 1,
    updatedAtMs: nowMs,
    status: arrived
      ? "arrived"
      : tickState.phase !== "arrived" && session.status === "arrived"
        ? "active"
        : session.status,
    cueLedger: {
      spoken: appendBounded(session.cueLedger.spoken, spokenCueIds),
      events: appendBounded(session.cueLedger.events, eventIds),
    },
    ...(tickState.lastAcceptedFix ? { lastAcceptedFix: tickState.lastAcceptedFix } : {}),
    payload: {
      ...session.payload,
      tickState: (() => {
        const { lastAcceptedFix: _fix, ...durable } = tickState;
        return durable;
      })(),
      confidence,
      progress: (progress as unknown as Record<string, unknown> | null) ?? session.payload.progress,
    },
  };

  // The cadence follows the phase, and a change is a profile update on the one
  // existing stream — never a second one. On Android the driver holds a change
  // back while the app is in the background, where restarting the stream is
  // refused, and applies it when the app is next opened.
  const profile = transitProfileForTime(next, nowMs);
  const previousProfile = transitProfileForTime(session, nowMs);
  if (profile !== previousProfile) {
    effects.push({ kind: "update-location-profile", profile });
  }

  effects.push({ kind: "reconcile-alerts", sessionId: session.sessionId });
  effects.push({ kind: "publish-snapshot", immediate: arrived || enqueue.length > 0 });

  return {
    session: next,
    effects,
    ...(enqueue.length > 0 ? { enqueue } : {}),
    arrived,
    needsReplan,
    actionRejected,
    events: allEvents,
  };
}

function appendBounded(existing: readonly string[], additions: readonly string[]): string[] {
  const next = [...existing];
  for (const id of additions) if (!next.includes(id)) next.push(id);
  return next.length > 512 ? next.slice(next.length - 512) : next;
}

/** Shared rider progress; no placeholder coordinate is published as a location. */
function followAlongProgress(
  state: TransitTickState,
  prepared: PreparedTransitProgress,
  _itinerary: unknown,
) {
  return transitProgressFromTick(state, prepared);
}
