import type { NavStatus } from "./types";

/**
 * True while ground navigation is actively under way: mid-route or
 * recovering from an off-route reroute. Deliberately excludes `"arrived"` —
 * the arrival card and the navigation session stay on screen after arrival,
 * but the live GPS watch, background polling and per-fix rendering behind
 * them are terminal at that point and must stop, not linger.
 */
export function isLiveNavigationStatus(status: NavStatus): boolean {
  return status === "navigating" || status === "rerouting";
}
