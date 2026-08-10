import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  type FixInput,
  type PreparedTransitProgress,
  prepareTransitProgress,
  processTransitFix,
  type TransitMobileSession,
  type TransitNavigationEvent,
} from "@openmapx/core/navigation";
import type { SessionEffect } from "../../storage/SessionRepository";
import type { ProcessorMutation } from "../processor";
import { transitCueEffect } from "./transitCue";
import { transitProfileForTime } from "./transitSession";

/**
 * One batch of fixes — or one wake-up with no fix at all — becomes one committed
 * revision.
 *
 * The no-fix case is not an edge case here the way it is for driving. A rider on
 * an underground train produces no usable position for twenty minutes, and the
 * engine still has to advance the leg from the schedule so the banner does not
 * freeze on a stop the train left long ago. So every legitimate wake-up ticks the
 * engine, with or without a position, and the engine labels the result
 * `gps | schedule | stale` rather than pretending they are the same thing.
 *
 * What this deliberately does not do is run a timer. A tick happens because the
 * operating system delivered a callback or the app is visible — never because
 * JavaScript decided it was time, which it cannot know while suspended.
 */

/**
 * A prepared itinerary index, keyed by the itinerary object it indexes.
 *
 * Keyed by identity rather than fingerprint for the same reason as the ground
 * cache: a session reloaded from storage produces a new object with identical
 * values, and a prepared index belongs to the one it was built from.
 */
export class TransitItineraryCache {
  private itinerary: object | null = null;
  private prepared: PreparedTransitProgress | null = null;

  preparedFor(session: TransitMobileSession): PreparedTransitProgress {
    const itinerary = session.payload.startPackage.itinerary as object;
    if (this.itinerary !== itinerary || !this.prepared) {
      this.prepared = prepareTransitProgress(itinerary as never);
      this.itinerary = itinerary;
    }
    return this.prepared;
  }

  invalidate(): void {
    this.itinerary = null;
    this.prepared = null;
  }
}

export interface TransitBatchOutcome extends ProcessorMutation {
  arrived: boolean;
  needsReplan: boolean;
  events: TransitNavigationEvent[];
}

export interface ProcessTransitBatchInput {
  session: TransitMobileSession;
  /** Empty for a wake-up that carried no usable position. */
  fixes: readonly FixInput[];
  nowMs: number;
  cache: TransitItineraryCache;
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

  let tickState = session.payload.tickState;
  let confidence = session.payload.confidence;
  let needsReplan = false;
  const allEvents: TransitNavigationEvent[] = [];

  // A wake-up with no fix still ticks, so schedule fallback can advance.
  const ticks: Array<FixInput | undefined> = fixes.length > 0 ? [...fixes] : [undefined];

  for (const fix of ticks) {
    const result = processTransitFix({
      itinerary: startPackage.itinerary as never,
      captures: startPackage.captures,
      state: tickState as never,
      ...(fix ? { fix } : {}),
      nowMs,
      options,
      prepared,
    });
    tickState = result.state as never;
    confidence = result.confidence;
    if (result.needsReplan) needsReplan = true;
    allEvents.push(...result.events);
  }

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

  const next: TransitMobileSession = {
    ...session,
    revision: session.revision + 1,
    updatedAtMs: nowMs,
    status: arrived ? "arrived" : session.status,
    cueLedger: {
      spoken: appendBounded(session.cueLedger.spoken, spokenCueIds),
      events: appendBounded(session.cueLedger.events, eventIds),
    },
    ...(tickState.lastAcceptedFix ? { lastAcceptedFix: tickState.lastAcceptedFix } : {}),
    payload: { ...session.payload, tickState, confidence },
  };

  // The cadence follows the phase, and a change is a profile update on the one
  // existing stream — never a second one.
  const profile = transitProfileForTime(next, nowMs);
  const previousProfile = transitProfileForTime(session, nowMs);
  if (profile !== previousProfile) {
    effects.push({ kind: "update-location-profile", profile });
  }

  effects.push({ kind: "publish-snapshot", immediate: arrived || enqueue.length > 0 });

  return {
    session: next,
    effects,
    ...(enqueue.length > 0 ? { enqueue } : {}),
    arrived,
    needsReplan,
    events: allEvents,
  };
}

function appendBounded(existing: readonly string[], additions: readonly string[]): string[] {
  const next = [...existing];
  for (const id of additions) if (!next.includes(id)) next.push(id);
  return next.length > 512 ? next.slice(next.length - 512) : next;
}
