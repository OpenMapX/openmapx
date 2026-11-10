import type { MobileNavigationSession } from "@openmapx/core/navigation";
import type { LocationProfileKind } from "../location/profiles";
import { locationProfileForMode } from "./ground/groundSession";
import { transitProfileForTime } from "./transit/transitSession";

/**
 * The cadence a session wants now, derived from what is committed.
 *
 * Derived rather than remembered, so any process, including one the system
 * started for a single batch, can work it out again.
 */
export function profileForSession(
  session: MobileNavigationSession,
  nowMs: number,
): LocationProfileKind {
  return session.kind === "ground"
    ? locationProfileForMode(session.payload.startPackage.mode)
    : transitProfileForTime(session, nowMs);
}
