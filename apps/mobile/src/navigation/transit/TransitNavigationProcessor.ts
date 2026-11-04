import {
  type FixInput,
  freshTransitTickState,
  prepareTransitProgress,
  type Route,
  repairTransitWalk,
  type TransitMobileSession,
  type TransitNavigationStartPackage,
  type TransitRiderAction,
  transitProgressFromTick,
} from "@openmapx/core/navigation";
import type { NavigationProcessor, ProcessorMutation, ProcessorPreparation } from "../processor";
import { onRefreshRequested, shouldRefresh } from "./refreshState";
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
  // Wake-ups update freshness while retaining physical leg ownership.
  readonly needsScheduleTicks = true;

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
    const { arrived, needsReplan: _needsReplan, events, ...mutation } = outcome;
    void events;

    const next = mutation.session as TransitMobileSession;
    const refresh = next.payload.refresh;
    if (refresh.status === "in-flight" && nowMs >= (refresh.nextAttemptAtMs ?? Infinity)) {
      next.payload.refresh = { ...refresh, status: "broken" };
    } else if (
      !arrived &&
      shouldRefresh({
        runtime: refresh,
        hasToken: !!next.payload.refreshToken,
        connectivity: next.connectivity,
        status: next.status,
        nowMs,
      }).refresh
    ) {
      const requestId = `${next.sessionId}:refresh:${refresh.generation + 1}`;
      next.payload.refresh = onRefreshRequested(refresh, requestId, nowMs);
      mutation.effects = [
        ...(mutation.effects ?? []),
        { kind: "request-transit-refresh", requestId },
      ];
    }
    return mutation;
  }

  repairTransitWalk(
    session: TransitMobileSession,
    legIndex: number,
    route: Route,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string } {
    if (
      session.payload.tickState.currentLegIndex !== legIndex ||
      session.payload.tickState.phase !== "walking"
    )
      return { ok: false, code: "invalid-state" };
    const itinerary = repairTransitWalk(
      session.payload.startPackage.itinerary as never,
      legIndex,
      route,
    );
    if (!itinerary) return { ok: false, code: "invalid-route" };
    const tickState = {
      ...session.payload.tickState,
      currentWalkStepIndex: 0,
      walkRevision: (session.payload.tickState.walkRevision ?? 0) + 1,
      reachedStepEnd: false,
      distanceToNextStepMeters: route.steps[0]?.distance,
      offPlan: false,
    };
    const progress = transitProgressFromTick(
      {
        ...tickState,
        ...(session.lastAcceptedFix ? { lastAcceptedFix: session.lastAcceptedFix } : {}),
      },
      prepareTransitProgress(itinerary),
    );
    return {
      session: {
        ...session,
        revision: session.revision + 1,
        updatedAtMs: nowMs,
        payload: {
          ...session.payload,
          navigationDataRevision: (session.payload.navigationDataRevision ?? 0) + 1,
          startPackage: { ...session.payload.startPackage, itinerary: itinerary as never },
          tickState,
          progress: progress as unknown as Record<string, unknown>,
        },
      },
      effects: [{ kind: "publish-snapshot", immediate: true }],
    };
  }

  transitAction(
    session: TransitMobileSession,
    action: TransitRiderAction,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string } {
    const mutation = processTransitBatch({ session, fixes: [], nowMs, cache: this.cache, action });
    if (mutation.actionRejected) return { ok: false, code: "invalid-action" };
    mutation.effects = [
      ...(mutation.effects ?? []),
      { kind: "reconcile-alerts", sessionId: session.sessionId },
    ];
    return mutation;
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
    const { refresh } = session.payload;

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
          refresh: onRefreshRequested(refresh, requestId, nowMs),
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
      tickState: freshTransitTickState(nowMs, startPackage.itinerary as never),
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
