import {
  type FixInput,
  type GroundMobileSession,
  matchSpeedLimitsByPoint,
  type NavTickResult,
  navOptionsForMode,
  type PreparedRouteMatcher,
  pickSpeedLimit,
  prepareRouteMatcher,
  processFix,
  routeFingerprint,
} from "@openmapx/core/navigation";
import type { ScheduledAlertInput, SessionEffect } from "../../storage/SessionRepository";
import type { ProcessorMutation } from "../processor";
import {
  arrivalCueId,
  groundCueEffect,
  MAX_CUE_AGE_MS,
  offRouteEpisodeId,
  statusCueEffect,
} from "./groundCue";
import { announceMultiplierFor } from "./groundSession";

/**
 * One batch of fixes becomes one committed revision.
 *
 * The operating system delivers fixes in clumps, sometimes long after they were
 * taken. Processing each one and committing each one would multiply writes,
 * multiply snapshots, and — worst — speak a queue of maneuvers the user has
 * already driven past. So every fix runs through the engine, all of the engine's
 * state changes are kept, and only the *effects* are filtered by whether they
 * still describe the present.
 */

/**
 * A prepared route index, kept in memory and keyed by the array it indexes.
 *
 * The key is the geometry array *itself*, not its fingerprint. The engine binds
 * a prepared matcher to the exact array it was built from and rejects it against
 * any other — and a session reloaded from storage produces a new array with
 * identical values every time, so a fingerprint would match while the matcher no
 * longer belonged to the geometry it was handed.
 *
 * What this buys is therefore per-batch reuse: one preparation for a batch of
 * fixes, which is the case that matters, since the batch shares one loaded
 * session. A replacement or a restart simply rebuilds.
 */
export class GroundRouteCache {
  private geometry: readonly unknown[] | null = null;
  private matcher: PreparedRouteMatcher | null = null;

  matcherFor(session: GroundMobileSession): PreparedRouteMatcher {
    const geometry = session.payload.startPackage.route.geometry;
    if (this.geometry !== geometry || !this.matcher) {
      this.matcher = prepareRouteMatcher(geometry);
      this.geometry = geometry;
    }
    return this.matcher;
  }

  invalidate(): void {
    this.geometry = null;
    this.matcher = null;
  }
}

export interface GroundBatchOutcome extends ProcessorMutation {
  /** Whether the engine reported arrival, so the caller can terminalise. */
  arrived: boolean;
  /** Whether a reroute is wanted; the service decides if one is actually sent. */
  needsReroute: boolean;
}

interface CueCandidate {
  cueId: string;
  effect: Extract<SessionEffect, { kind: "speak" }>;
  atMs: number;
}

/**
 * Which limit applies where the user actually is.
 *
 * Captured live limits win over the route's own, because they were fetched for
 * this journey; both are indexed by segment, which is why a mismatched captured
 * array is rejected at preparation rather than silently misattributed here.
 */
function speedLimitAt(session: GroundMobileSession, segmentIndex: number): number | null {
  const { startPackage } = session.payload;
  const captured = startPackage.capturedLiveSpeedLimits;
  if (captured && segmentIndex >= 0 && segmentIndex < captured.length) {
    const limit = captured[segmentIndex];
    if (typeof limit === "number") return limit;
  }
  const routeLimits = startPackage.route.segmentSpeedLimits;
  if (routeLimits && segmentIndex >= 0 && segmentIndex < routeLimits.length) {
    return routeLimits[segmentIndex] ?? null;
  }
  return null;
}

export interface ProcessGroundBatchInput {
  session: GroundMobileSession;
  fixes: readonly FixInput[];
  nowMs: number;
  cache: GroundRouteCache;
}

/**
 * Runs a batch through the engine and returns one complete mutation.
 *
 * Every accepted fix advances the engine, so tick state, the off-route score
 * and the step gate all see the whole history. Cues are collected as candidates
 * and filtered afterwards: a batch that arrived thirty seconds late has real
 * cues in it, but speaking them now would direct the user to turns already
 * behind them.
 */
export function processGroundBatch(input: ProcessGroundBatchInput): GroundBatchOutcome {
  const { session, fixes, nowMs, cache } = input;
  const { startPackage } = session.payload;
  const fingerprint = routeFingerprint(startPackage.route.geometry);
  const matcher = cache.matcherFor(session);

  const options = {
    ...navOptionsForMode(startPackage.mode),
    announceMultiplier: announceMultiplierFor(startPackage.settings.voiceTiming),
  };

  let tickState = session.payload.tickState;
  let progress = session.payload.progress;
  let weakGps = session.payload.weakGps;
  let offRoute = session.payload.offRoute;
  let currentSpeedLimit = session.payload.currentSpeedLimit;
  let lastAcceptedFix = session.lastAcceptedFix;
  let arrived = false;
  let needsReroute = false;
  let offRouteEpisodeStart: number | null = null;

  const cueCandidates: CueCandidate[] = [];
  const spokenCueIds: string[] = [];
  const eventIds: string[] = [];
  const enqueue: Array<{ eventId: string; critical: boolean; payload: unknown }> = [];

  for (const fix of fixes) {
    // The wire schema is deliberately looser than the engine's `Route` — it
    // passes engine-specific extras through — so the shape is asserted once
    // here rather than at every field.
    const result: NavTickResult = processFix(
      startPackage.route as unknown as Parameters<typeof processFix>[0],
      fix,
      tickState as never,
      options,
      matcher,
    );
    tickState = result.nextState as never;
    weakGps = result.weakGps;

    if (result.accuracyRejected) {
      // A rejected fix says the signal is poor; it says nothing about where the
      // user is. Progress and the coasting anchor are left exactly as they were.
      continue;
    }

    if (result.progress) {
      progress = result.progress as never;
      currentSpeedLimit = speedLimitAt(session, result.progress.segmentIndex);
      lastAcceptedFix = {
        coords: fix.coords,
        accuracy: fix.accuracy,
        timestampMs: fix.timestampMs,
        ...(fix.coasted ? { coasted: true } : {}),
        ...(typeof fix.heading === "number" ? { heading: fix.heading } : {}),
        ...(typeof fix.speed === "number" ? { speed: fix.speed } : {}),
      };
    }

    // A new off-route episode starts when the flag flips, not on every fix.
    if (result.offRoute && !offRoute) offRouteEpisodeStart = fix.timestampMs;
    offRoute = result.offRoute;
    if (result.needsReroute) needsReroute = true;

    if (result.voiceCue) {
      const built = groundCueEffect(session, fingerprint, result.voiceCue);
      if (built && !session.cueLedger.spoken.includes(built.cueId)) {
        spokenCueIds.push(built.cueId);
        cueCandidates.push({ ...built, atMs: fix.timestampMs });
      }
    }

    if (result.arrived) {
      arrived = true;
      // Nothing after arrival can matter, and continuing would announce turns
      // beyond a journey that has ended.
      break;
    }
  }

  const effects: SessionEffect[] = [];

  // Speak at most the newest cue, and only while it still describes something
  // ahead. An older cue in the same batch is already recorded as spoken, so it
  // will not be re-announced later either.
  if (startPackage.settings.voiceEnabled && cueCandidates.length > 0) {
    const newest = cueCandidates[cueCandidates.length - 1];
    if (nowMs - newest.atMs <= MAX_CUE_AGE_MS) effects.push(newest.effect);
  }

  if (offRouteEpisodeStart !== null) {
    const episodeId = offRouteEpisodeId(session.sessionId, fingerprint, offRouteEpisodeStart);
    if (!session.cueLedger.events.includes(episodeId)) {
      eventIds.push(episodeId);
      enqueue.push({ eventId: episodeId, critical: true, payload: { type: "off-route" } });
      // A turn prompt while off route would be worse than silence, so the
      // engine's own cue is already suppressed; this is the one thing to say.
      if (startPackage.settings.voiceEnabled) {
        const spoken = statusCueEffect(session, episodeId, "off-route");
        if (spoken) effects.push(spoken);
      }
    }
  }

  if (arrived) {
    const cueId = arrivalCueId(session.sessionId, fingerprint);
    if (!session.cueLedger.events.includes(cueId)) {
      eventIds.push(cueId);
      enqueue.push({ eventId: cueId, critical: true, payload: { type: "arrived" } });
      if (startPackage.settings.voiceEnabled) {
        const spoken = statusCueEffect(session, cueId, "arrival");
        if (spoken) effects.push(spoken);
      }
    }
  }

  // One snapshot for the batch, not one per historical fix.
  effects.push({ kind: "publish-snapshot", immediate: arrived || offRouteEpisodeStart !== null });

  const alerts: ScheduledAlertInput[] | undefined = undefined;

  return {
    session: {
      ...session,
      revision: session.revision + 1,
      updatedAtMs: nowMs,
      status: arrived ? "arrived" : session.status,
      cueLedger: {
        spoken: appendBounded(session.cueLedger.spoken, spokenCueIds),
        events: appendBounded(session.cueLedger.events, eventIds),
      },
      ...(lastAcceptedFix ? { lastAcceptedFix } : {}),
      payload: {
        ...session.payload,
        tickState,
        progress,
        weakGps,
        offRoute,
        // A real accepted fix ends coasting; a synthetic one keeps it.
        coasting: fixes.some((fix) => !fix.coasted && !isRejected(fix, options.accuracyCapMeters))
          ? false
          : session.payload.coasting,
        currentSpeedLimit,
      },
    },
    effects,
    ...(enqueue.length > 0 ? { enqueue } : {}),
    ...(alerts ? { alerts } : {}),
    arrived,
    needsReroute,
  };
}

function isRejected(fix: FixInput, accuracyCapMeters: number): boolean {
  return fix.accuracy > accuracyCapMeters;
}

/** Appends without duplicates, trimming the oldest past the shared cap. */
function appendBounded(existing: readonly string[], additions: readonly string[]): string[] {
  const next = [...existing];
  for (const id of additions) if (!next.includes(id)) next.push(id);
  return next.length > 512 ? next.slice(next.length - 512) : next;
}

/** Exposed so the speed-limit helpers stay reachable to later plans. */
export const groundSpeedLimitHelpers = { matchSpeedLimitsByPoint, pickSpeedLimit };
