import type {
  FixInput,
  GroundMobileSession,
  GroundNavigationStartPackage,
} from "@openmapx/core/navigation";
import type { NavigationProcessor, ProcessorMutation, ProcessorPreparation } from "../processor";
import { GroundRouteCache, processGroundBatch } from "./groundBatch";
import { applyGroundReplacement, validateGroundReplacement } from "./groundReplacement";
import { createGroundPreparingSession, validateGroundStartPackage } from "./groundSession";
import {
  canRequestReroute,
  EMPTY_CHURN,
  onBackOnRoute,
  onRerouteOffline,
  onRerouteRequested,
} from "./rerouteState";

/**
 * Ground navigation, as the coordinator sees it.
 *
 * The processor owns no storage, performs no I/O and speaks to nothing. It
 * receives a session and returns the next one, which is what lets the same code
 * run against a recorded trace and a moving car and produce identical results.
 *
 * The one piece of mutable state it does hold is the prepared route index — a
 * single-entry cache of the active session's geometry, reused while the
 * coordinates are exactly unchanged, rebuilt after a process restart and
 * invalidated by any replacement.
 */
export class GroundNavigationProcessor implements NavigationProcessor<"ground"> {
  readonly kind = "ground" as const;
  // Position is the only evidence a road journey has.
  readonly needsScheduleTicks = false;

  private readonly cache = new GroundRouteCache();

  prepare(
    startPackage: GroundNavigationStartPackage,
    context: { sessionId: string; nowMs: number; permissionMode: "background" | "foreground-only" },
  ): ProcessorPreparation {
    const validated = validateGroundStartPackage(startPackage);
    if (!validated.ok) return { ok: false, code: validated.code };

    return {
      ok: true,
      session: createGroundPreparingSession(
        validated.startPackage,
        {
          sessionId: context.sessionId,
          locale: validated.startPackage.locale,
          units: validated.startPackage.units,
          permissionMode: context.permissionMode,
        },
        context.nowMs,
      ),
    };
  }

  processFixes(
    session: GroundMobileSession,
    fixes: readonly FixInput[],
    nowMs: number,
  ): ProcessorMutation {
    const outcome = processGroundBatch({ session, fixes, nowMs, cache: this.cache });
    const { arrived, needsReroute, ...mutation } = outcome;
    const advanced = mutation.session as GroundMobileSession;
    const current = advanced.payload.reroute;

    if (arrived) return mutation;
    if (!needsReroute) {
      const settled = advanced.payload.offRoute ? current : onBackOnRoute(current);
      if (settled === current) return mutation;
      return { ...mutation, session: withReroute(advanced, settled) };
    }

    // The engine asked for a reroute; the guards decide whether one is sent.
    // A refusal costs nothing: the engine has already started its own backoff
    // and asks again if the user is still off route.
    const decision = canRequestReroute(
      current,
      advanced.payload.rerouteChurn ?? EMPTY_CHURN,
      advanced.connectivity,
      nowMs,
    );
    if (!decision.allow) {
      if (decision.reason !== "offline" || current.status === "unavailable") return mutation;
      // Waiting for the network, which `onConnectivityRestored` retries.
      return { ...mutation, session: withReroute(advanced, onRerouteOffline(current)) };
    }

    // Recording the intent is all that happens here: the request itself is
    // network I/O, and running it inside the coordinator's queue would block
    // every later fix behind a socket.
    const requestId = `${session.sessionId}:reroute:${advanced.revision}`;
    return {
      ...mutation,
      session: withReroute(advanced, onRerouteRequested(current, requestId, nowMs)),
      effects: [...(mutation.effects ?? []), { kind: "request-reroute", requestId }],
    };
  }

  replace(
    session: GroundMobileSession,
    replacement: unknown,
    nowMs: number,
  ): ProcessorMutation | { ok: false; code: string } {
    const validated = validateGroundReplacement(session, replacement);
    if (!validated.ok) return { ok: false, code: validated.code };

    // Every geometry-indexed value belongs to the route that produced it, so the
    // cache is dropped along with them rather than left to answer for a road the
    // user is no longer on.
    this.cache.invalidate();
    return applyGroundReplacement(session, validated.startPackage, nowMs);
  }

  async onConnectivityRestored(
    session: GroundMobileSession,
    nowMs: number,
  ): Promise<ProcessorMutation | null> {
    const { reroute } = session.payload;
    // Only a reroute the network prevented is worth retrying. An idle or
    // in-flight one needs nothing, and a failed one waits for a later fix.
    if (reroute.status !== "unavailable") return null;
    const decision = canRequestReroute(
      reroute,
      session.payload.rerouteChurn ?? EMPTY_CHURN,
      "online",
      nowMs,
    );
    if (!decision.allow) return null;

    const revision = session.revision + 1;
    const requestId = `${session.sessionId}:reroute:${revision}`;
    return {
      session: {
        ...withReroute(session, onRerouteRequested(reroute, requestId, nowMs)),
        revision,
        updatedAtMs: nowMs,
        connectivity: "online",
      },
      effects: [{ kind: "request-reroute", requestId }],
    };
  }
}

function withReroute(
  session: GroundMobileSession,
  reroute: GroundMobileSession["payload"]["reroute"],
): GroundMobileSession {
  return { ...session, payload: { ...session.payload, reroute } };
}
