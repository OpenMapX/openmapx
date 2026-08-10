import type {
  FixInput,
  GroundMobileSession,
  GroundNavigationStartPackage,
} from "@openmapx/core/navigation";
import type { NavigationProcessor, ProcessorMutation, ProcessorPreparation } from "../processor";
import { GroundRouteCache, processGroundBatch } from "./groundBatch";
import { applyGroundReplacement, validateGroundReplacement } from "./groundReplacement";
import { createGroundPreparingSession, validateGroundStartPackage } from "./groundSession";

/**
 * Ground navigation, as the coordinator sees it.
 *
 * The processor owns no storage, performs no I/O and speaks to nothing. It
 * receives a session and returns the next one, which is what lets the same code
 * run against a recorded trace and a moving car and produce identical results.
 *
 * The one piece of mutable state it does hold is the prepared route index — a
 * cache, keyed by the route it indexes, rebuilt in microseconds after a process
 * restart and invalidated by any replacement.
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

    if (!needsReroute || arrived) return mutation;

    // The engine asked for a reroute. Recording the intent is all that happens
    // here: the request itself is network I/O, and running it inside the
    // coordinator's queue would block every later fix behind a socket.
    const requestId = `${session.sessionId}:reroute:${mutation.session.revision}`;
    const advanced = mutation.session as GroundMobileSession;
    return {
      ...mutation,
      session: {
        ...advanced,
        payload: {
          ...advanced.payload,
          reroute: {
            status: "pending",
            requestId,
            attempts: session.payload.reroute.attempts,
          },
        },
      },
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

    const requestId = `${session.sessionId}:reroute:${session.revision + 1}`;
    return {
      session: {
        ...session,
        revision: session.revision + 1,
        updatedAtMs: nowMs,
        connectivity: "online",
        payload: {
          ...session.payload,
          reroute: { status: "pending", requestId, attempts: reroute.attempts },
        },
      },
      effects: [{ kind: "request-reroute", requestId }],
    };
  }
}
