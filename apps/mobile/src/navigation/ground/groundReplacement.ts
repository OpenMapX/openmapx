import type { GroundMobileSession, GroundNavigationStartPackage } from "@openmapx/core/navigation";
import type { ProcessorMutation } from "../processor";
import { type GroundPackageError, validateGroundStartPackage } from "./groundSession";

/**
 * Replacing the route a session is following.
 *
 * One shape covers all three ways it happens — the user picks a captured
 * alternative, adds a stop and gets a freshly planned route, or a reroute
 * returns one — because they differ only in where the route came from, and
 * treating them differently is how one of them ends up resetting less than it
 * should.
 *
 * The rule that makes replacement safe: **everything indexed by geometry resets
 * together.** Progress, the off-route score, the step gate, the coasting anchor,
 * the current speed limit and the cue namespace all describe positions along a
 * specific line. Carrying any of them onto a new line would place the user
 * somewhere they are not.
 */

export type GroundReplacementResult =
  | { ok: true; startPackage: GroundNavigationStartPackage }
  | { ok: false; code: GroundPackageError | "mode-changed" | "not-active" };

export function validateGroundReplacement(
  session: GroundMobileSession,
  replacement: unknown,
): GroundReplacementResult {
  if (session.status !== "active" && session.status !== "preparing") {
    return { ok: false, code: "not-active" };
  }

  const validated = validateGroundStartPackage(replacement);
  if (!validated.ok) return { ok: false, code: validated.code };

  // Changing mode mid-session would change the location cadence, the off-route
  // sensitivity and the voice schedule at once. That is a new session, not a
  // replacement.
  if (validated.startPackage.mode !== session.payload.startPackage.mode) {
    return { ok: false, code: "mode-changed" };
  }

  return validated;
}

/**
 * Commits the new route and resets every value that belonged to the old one.
 *
 * The cue ledger is deliberately *not* cleared: its entries are namespaced by
 * route fingerprint, so entries for the old route are already unreachable, and
 * keeping them costs nothing while clearing them would lose the arrival and
 * off-route events the page may not have acknowledged yet.
 */
export function applyGroundReplacement(
  session: GroundMobileSession,
  startPackage: GroundNavigationStartPackage,
  nowMs: number,
): ProcessorMutation {
  const next: GroundMobileSession = {
    ...session,
    revision: session.revision + 1,
    updatedAtMs: nowMs,
    // A replacement is the moment a stale last fix would be most misleading, so
    // it goes with the route it was snapped against.
    lastAcceptedFix: undefined,
    payload: {
      startPackage: structuredClone(startPackage),
      tickState: {
        offRouteScore: 0,
        lastRerouteAtMs: session.payload.tickState.lastRerouteAtMs,
        rerouteBackoffMs: session.payload.tickState.rerouteBackoffMs,
        spokenCues: [],
      },
      progress: null,
      weakGps: false,
      offRoute: false,
      coasting: false,
      currentSpeedLimit: null,
      reroute: { status: "idle", attempts: session.payload.reroute.attempts },
    },
  };
  // `lastAcceptedFix` is optional in the schema, and an explicit `undefined`
  // would fail a strict parse, so the key is removed rather than blanked.
  delete (next as { lastAcceptedFix?: unknown }).lastAcceptedFix;

  return {
    session: next,
    effects: [{ kind: "publish-snapshot", immediate: true }],
  };
}
