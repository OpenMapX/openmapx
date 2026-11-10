import { type MobileNavigationSession, TRANSIT_UNDO_WINDOW_MS } from "@openmapx/core/navigation";

/**
 * When an arrived session stops needing the location stream.
 *
 * Arrival keeps the session row so the page can show the outcome, but nothing
 * left to do needs a position, and high-accuracy GPS with its foreground service
 * would otherwise run until the user opens the app again. A road trip releases
 * the stream at the arrival itself. A transit trip keeps it for as long as the
 * rider can still undo the tap that ended the trip, measured the way the engine
 * measures undo, so an undo resumes a trip that is still being tracked; an
 * arrival with nothing to undo releases at once.
 *
 * Returns null for a session that is not arrived, and a time at or before now
 * when the stream should already be stopped.
 */
export function locationReleaseAtMs(session: MobileNavigationSession): number | null {
  if (session.status !== "arrived") return null;
  if (session.kind === "ground") return session.updatedAtMs;
  const undoable = session.payload.tickState.lastAction;
  // The engine still accepts an undo at exactly the end of the window.
  return undoable ? undoable.atMs + TRANSIT_UNDO_WINDOW_MS + 1 : session.updatedAtMs;
}
