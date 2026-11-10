import { type MobileNavigationSession, TRANSIT_UNDO_WINDOW_MS } from "@openmapx/core/navigation";

/**
 * How long the location stream outlives an arrival with nothing to undo.
 *
 * The arrival announcement is spoken by the same commit that ends the need for
 * a position, and speech is only queued when the effect returns. On iOS a
 * backgrounded app declares only the location background mode, so stopping the
 * stream lets the system suspend it, possibly before "You have arrived" plays.
 * Ten seconds covers a cold Android engine's three-second bind plus the longest
 * arrival phrase, in either language, with margin, and still stops
 * high-accuracy GPS and the foreground service within seconds.
 */
export const ARRIVAL_CUE_GRACE_MS = 10_000;

/**
 * When an arrived session stops needing the location stream.
 *
 * Arrival keeps the session row so the page can show the outcome, but nothing
 * left to do needs a position, and high-accuracy GPS with its foreground service
 * would otherwise run until the user opens the app again. Every arrival keeps
 * the stream for `ARRIVAL_CUE_GRACE_MS` so its announcement can finish. A
 * transit trip keeps it for as long as the rider can still undo the tap that
 * ended the trip, measured the way the engine measures undo, if that is longer,
 * so an undo resumes a trip that is still being tracked.
 *
 * Returns null for a session that is not arrived, and a time at or before now
 * when the stream should already be stopped.
 */
export function locationReleaseAtMs(session: MobileNavigationSession): number | null {
  if (session.status !== "arrived") return null;
  const afterCue = session.updatedAtMs + ARRIVAL_CUE_GRACE_MS;
  if (session.kind === "ground") return afterCue;
  const undoable = session.payload.tickState.lastAction;
  // The engine still accepts an undo at exactly the end of the window.
  return undoable ? Math.max(afterCue, undoable.atMs + TRANSIT_UNDO_WINDOW_MS + 1) : afterCue;
}
