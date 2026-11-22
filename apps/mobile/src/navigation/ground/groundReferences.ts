import { type MobileNavigationSession, routeFingerprint } from "@openmapx/core/navigation";
import type { SessionEffect } from "../../storage/SessionRepository";
import type { ProcessorMutation } from "../processor";
import type { ReferenceOutcome } from "./GroundReferenceService";
import { validateGroundStartPackage } from "./groundSession";

/**
 * Voice references for the route a native ground session follows: when to ask
 * for them, and how an answer is committed.
 */

const REFERENCE_MODES: ReadonlySet<string> = new Set(["driving", "motorcycle"]);

/**
 * The request for a driving session whose start package carries no traffic
 * signals (landmarks from the page may already be there), keyed by the route's
 * fingerprint; nothing otherwise.
 */
export function referenceRequestEffects(session: MobileNavigationSession): SessionEffect[] {
  if (session.kind !== "ground") return [];
  const { startPackage } = session.payload;
  if (!REFERENCE_MODES.has(startPackage.mode)) return [];
  if (startPackage.signalsAlong !== undefined) return [];
  return [{ kind: "request-references", requestId: routeFingerprint(startPackage.route.geometry) }];
}

/**
 * The mutation that writes an answer into the start package, or null when it
 * is a failure, belongs to another session or route, or does not fit the
 * package's bounds. Prompts stay plain in every null case. Only what the
 * package lacks is filled: evidence the page handed over is kept.
 */
export function applyGroundReferences(
  session: MobileNavigationSession,
  outcome: ReferenceOutcome,
  nowMs: number,
): ProcessorMutation | null {
  if (!outcome.ok || session.kind !== "ground" || session.status !== "active") return null;
  if (session.sessionId !== outcome.sessionId) return null;
  const { startPackage } = session.payload;
  if (routeFingerprint(startPackage.route.geometry) !== outcome.routeFingerprint) return null;

  const validated = validateGroundStartPackage({
    ...startPackage,
    ...(startPackage.signalsAlong === undefined &&
      outcome.signalsAlong &&
      outcome.signalSpans && {
        signalsAlong: outcome.signalsAlong,
        signalSpans: outcome.signalSpans,
      }),
    ...(startPackage.landmarkReferences === undefined &&
      outcome.landmarkReferences && { landmarkReferences: outcome.landmarkReferences }),
  });
  if (!validated.ok) return null;
  return {
    session: {
      ...session,
      revision: session.revision + 1,
      updatedAtMs: nowMs,
      payload: { ...session.payload, startPackage: validated.startPackage },
    },
    effects: [],
  };
}
