/**
 * Every state the native shell can be in, and the only actions each one offers.
 *
 * The constraint that shapes this file: **there is no second navigation UI.**
 * The product is the web app; native renders only what the web app cannot —
 * because it has not loaded, cannot load, or is suspended while guidance
 * continues. So the action vocabulary is deliberately tiny, and a state that
 * offers something it should not is a test failure rather than a design review.
 */

export type ShellAction =
  | "retry"
  | "open-network-settings"
  | "resume"
  | "end"
  | "dismiss"
  | "open-app-settings";

export type ShellState =
  /** Before the first document has finished loading. */
  | { kind: "loading" }
  /** The product is rendering; native shows nothing. */
  | { kind: "web" }
  /** The page could not load and no session is running. */
  | { kind: "load-error"; offline: boolean }
  /** The page could not load, but native guidance is still active. */
  | { kind: "offline-navigating" }
  /** The page negotiated no compatible protocol version. */
  | { kind: "incompatible-shell" }
  /** A recorded session could not be read and was quarantined. */
  | { kind: "corrupt-session" }
  /** Location access was lost while a session was running. */
  | { kind: "permission-lost" }
  /** A live session exists whose driver is gone. */
  | { kind: "resume-offer" }
  /** The compiled configuration is invalid; nothing can be done in-app. */
  | { kind: "fatal-config" };

export const SHELL_ACTIONS: Record<ShellState["kind"], readonly ShellAction[]> = {
  loading: [],
  web: [],
  // Retrying is the only thing that can help, and it is safe: no session exists.
  "load-error": ["retry"],
  // Guidance is running, so ending it must be reachable even though the page is
  // not. Network settings help; a retry is offered because the page may recover.
  "offline-navigating": ["retry", "open-network-settings", "end"],
  // Nothing native can fix a version mismatch, so the only honest action is to
  // return to the page, which still works as an ordinary browser.
  "incompatible-shell": ["dismiss"],
  "corrupt-session": ["dismiss"],
  // Re-prompting is exactly what must not happen; system settings is the route.
  "permission-lost": ["open-app-settings", "end"],
  "resume-offer": ["resume", "end"],
  // Deliberately empty: offering a button that cannot work would be a lie.
  "fatal-config": [],
};

export function actionsFor(state: ShellState): readonly ShellAction[] {
  return SHELL_ACTIONS[state.kind];
}

/** Whether this state hides the WebView entirely rather than overlaying it. */
export function isBlocking(state: ShellState): boolean {
  return state.kind === "fatal-config";
}
