import type {
  FixInput,
  TransitMobileSession,
  TransitNavigationStartPackage,
} from "@openmapx/core/navigation";
import type { NavigationProcessor, ProcessorMutation, ProcessorPreparation } from "../processor";
import { processTransitBatch, TransitItineraryCache } from "./transitBatch";
import { createTransitPreparingSession, validateTransitStartPackage } from "./transitSession";

/**
 * Transit navigation, as the coordinator sees it.
 *
 * Same contract as ground: no storage, no I/O, no speech. It receives a session
 * and returns the next one, which is what lets a recorded trace and a real
 * journey produce identical results.
 *
 * Two things differ from ground, and both come from the nature of the mode. A
 * rider underground produces no position for twenty minutes, so a tick with no
 * fix is normal rather than exceptional. And the itinerary can change under the
 * rider — a delay, a platform change, a cancellation — so the session carries a
 * rotating token whose only consumer is native.
 */
export class TransitNavigationProcessor implements NavigationProcessor<"transit"> {
  readonly kind = "transit" as const;

  private readonly cache = new TransitItineraryCache();

  prepare(
    startPackage: TransitNavigationStartPackage,
    context: { sessionId: string; nowMs: number; permissionMode: "background" | "foreground-only" },
  ): ProcessorPreparation {
    const validated = validateTransitStartPackage(startPackage);
    if (!validated.ok) return { ok: false, code: validated.code };

    return {
      ok: true,
      session: createTransitPreparingSession(
        validated.startPackage,
        { sessionId: context.sessionId, permissionMode: context.permissionMode },
        context.nowMs,
      ),
    };
  }

  processFixes(
    session: TransitMobileSession,
    fixes: readonly FixInput[],
    nowMs: number,
  ): ProcessorMutation {
    const outcome = processTransitBatch({ session, fixes, nowMs, cache: this.cache });
    const { arrived, needsReplan, events, ...mutation } = outcome;
    void events;

    if (!needsReplan || arrived) return mutation;

    // The engine wants a replacement itinerary. Recording the intent is all that
    // happens here: the plan request is network work, and holding the
    // coordinator's queue open for it would stall every later fix.
    const advanced = mutation.session as TransitMobileSession;
    if (advanced.payload.replan.status === "in-flight") return mutation;

    const generation = advanced.payload.replan.generation + 1;
    const requestId = `${session.sessionId}:replan:${generation}`;
    return {
      ...mutation,
      session: {
        ...advanced,
        payload: {
          ...advanced.payload,
          replan: {
            status: "pending",
            requestId,
            generation,
            attempts: advanced.payload.replan.attempts,
          },
        },
      },
      effects: [...(mutation.effects ?? []), { kind: "request-transit-replan", requestId }],
    };
  }

  replace(
    session: TransitMobileSession,
    replacement: unknown,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string } {
    if (session.status !== "active" && session.status !== "preparing") {
      return { ok: false, code: "not-active" };
    }
    const validated = validateTransitStartPackage(replacement);
    if (!validated.ok) return { ok: false, code: validated.code };

    // Everything indexed by the old itinerary goes with it, including the
    // prepared index and — critically — the rotating token, which belongs to the
    // journey that produced it and is useless against a different one.
    this.cache.invalidate();
    return applyTransitReplacement(session, validated.startPackage, nowMs);
  }

  async onConnectivityRestored(
    session: TransitMobileSession,
    nowMs: number,
  ): Promise<ProcessorMutation | null> {
    const { refresh, replan } = session.payload;

    // A replan the network prevented outranks a refresh: the itinerary itself is
    // wrong, and refreshing times on a trip the rider can no longer make would
    // only make the wrong plan look current.
    if (replan.status === "unavailable" || replan.status === "pending") {
      const generation = replan.generation + 1;
      const requestId = `${session.sessionId}:replan:${generation}`;
      return {
        session: {
          ...session,
          revision: session.revision + 1,
          updatedAtMs: nowMs,
          connectivity: "online",
          payload: {
            ...session.payload,
            replan: { status: "pending", requestId, generation, attempts: replan.attempts },
          },
        },
        effects: [{ kind: "request-transit-replan", requestId }],
      };
    }

    if (refresh.status !== "stale" || !session.payload.refreshToken) return null;

    const generation = refresh.generation + 1;
    const requestId = `${session.sessionId}:refresh:${generation}`;
    return {
      session: {
        ...session,
        revision: session.revision + 1,
        updatedAtMs: nowMs,
        connectivity: "online",
        payload: {
          ...session.payload,
          refresh: { status: "ready", generation, requestId, attempts: refresh.attempts },
        },
      },
      effects: [{ kind: "request-transit-refresh", requestId }],
    };
  }
}

/**
 * Commits a replacement itinerary and resets everything the old one owned.
 *
 * The whole package is adopted or none of it: combining a new itinerary with an
 * old capture set, or a new capture set with an old token, produces a session
 * that describes a journey that never existed.
 */
export function applyTransitReplacement(
  session: TransitMobileSession,
  startPackage: TransitNavigationStartPackage,
  nowMs: number,
): ProcessorMutation {
  const itinerary = startPackage.itinerary as { refreshToken?: unknown };
  const refreshToken = typeof itinerary.refreshToken === "string" ? itinerary.refreshToken : null;

  const next: TransitMobileSession = {
    ...session,
    revision: session.revision + 1,
    updatedAtMs: nowMs,
    payload: {
      startPackage: structuredClone(startPackage),
      tickState: {
        currentLegIndex: 0,
        currentWalkStepIndex: 0,
        phase: "walking",
        legEnteredAtMs: nowMs,
        spokenCueIds: [],
        emittedEventIds: [],
        scheduleFallback: "inactive",
      },
      progress: null,
      confidence: "gps",
      refreshToken,
      // A new generation invalidates every request the old itinerary started,
      // so a reply that was already in flight cannot land on this session.
      refresh: {
        status: refreshToken ? "ready" : "broken",
        generation: session.payload.refresh.generation + 1,
        attempts: 0,
      },
      replan: {
        status: "idle",
        generation: session.payload.replan.generation + 1,
        attempts: 0,
      },
      scheduledAlerts: [],
    },
  };
  delete (next as { lastAcceptedFix?: unknown }).lastAcceptedFix;

  return {
    session: next,
    effects: [
      // Superseded alerts are cancelled before anything new is scheduled: an
      // alighting alert for a train the rider is no longer on is worse than none.
      { kind: "cancel-session-alerts", sessionId: session.sessionId },
      { kind: "reconcile-alerts", sessionId: session.sessionId },
      { kind: "publish-snapshot", immediate: true },
    ],
  };
}
