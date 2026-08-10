import type { ShellState } from "./ShellState";

/**
 * How the shell moves between its states.
 *
 * Two orderings matter, and both are easy to get wrong by accident:
 *
 *  - **A running session outranks a page failure.** If guidance is active and
 *    the page cannot load, the user must be told that guidance continues — not
 *    shown a generic "could not load" screen that implies everything stopped.
 *  - **A load succeeding does not clear a session problem.** Permission loss and
 *    a quarantined session survive a reload, because reloading the page does not
 *    grant permission or repair a record.
 */

export type ShellEvent =
  | { type: "document-load-started" }
  | { type: "document-load-succeeded" }
  | { type: "document-load-failed"; offline: boolean }
  | { type: "connectivity-changed"; online: boolean }
  | { type: "session-started" }
  | { type: "session-ended" }
  | { type: "session-quarantined" }
  | { type: "permission-lost" }
  | { type: "resume-required" }
  | { type: "resume-accepted" }
  | { type: "protocol-incompatible" }
  | { type: "config-invalid" }
  | { type: "dismissed" };

/**
 * Where the document is.
 *
 * `initial` is distinct from `loading` and from `failed` because the shell must
 * not show a failure it has not observed: at startup nothing has been attempted
 * yet, and "could not load" would be a lie.
 */
export type PageState = "initial" | "loading" | "loaded" | "failed";

export interface ShellContext {
  /** Whether native guidance is currently running. */
  navigating: boolean;
  page: PageState;
  online: boolean;
}

export interface ShellSnapshot {
  state: ShellState;
  context: ShellContext;
}

export const INITIAL_SHELL: ShellSnapshot = {
  state: { kind: "loading" },
  context: { navigating: false, page: "initial", online: true },
};

/** States a routine page or connectivity event must not overwrite. */
const STICKY = new Set<ShellState["kind"]>([
  "fatal-config",
  "permission-lost",
  "corrupt-session",
  "resume-offer",
]);

function settle(context: ShellContext, current: ShellState): ShellState {
  if (STICKY.has(current.kind)) return current;
  if (current.kind === "incompatible-shell") return current;

  if (context.page === "loaded") return { kind: "web" };
  // Guidance running behind a page that will not load is the case the user most
  // needs explained, and the one a generic error screen gets wrong.
  if (context.navigating) return { kind: "offline-navigating" };
  if (context.page === "failed") return { kind: "load-error", offline: !context.online };
  return { kind: "loading" };
}

export function shellReducer(snapshot: ShellSnapshot, event: ShellEvent): ShellSnapshot {
  const { state, context } = snapshot;

  // An invalid compiled configuration is terminal from any state: continuing
  // would mean guessing which server to trust.
  if (event.type === "config-invalid") {
    return { state: { kind: "fatal-config" }, context };
  }

  switch (event.type) {
    case "document-load-started": {
      const next: ShellContext = { ...context, page: "loading" };
      if (STICKY.has(state.kind)) return { state, context: next };
      return { state: settle(next, { kind: "loading" }), context: next };
    }

    case "document-load-succeeded": {
      // Both platforms report load-end after an error for the same navigation,
      // so a success cannot clear a failure the shell has already observed.
      // Only a new load attempt does that.
      if (context.page === "failed") return snapshot;
      const next: ShellContext = { ...context, page: "loaded" };
      return { state: settle(next, state), context: next };
    }

    case "document-load-failed": {
      const next: ShellContext = { ...context, page: "failed", online: !event.offline };
      return { state: settle(next, state), context: next };
    }

    case "connectivity-changed": {
      const next = { ...context, online: event.online };
      return { state: settle(next, state), context: next };
    }

    case "session-started": {
      const next = { ...context, navigating: true };
      // Starting a session clears a stale resume offer: it has been answered.
      const base = state.kind === "resume-offer" ? { kind: "loading" as const } : state;
      return { state: settle(next, base), context: next };
    }

    case "session-ended": {
      const next = { ...context, navigating: false };
      // Ending resolves every session-scoped problem state.
      const base =
        STICKY.has(state.kind) && state.kind !== "fatal-config"
          ? { kind: "loading" as const }
          : state;
      return { state: settle(next, base), context: next };
    }

    case "session-quarantined":
      return { state: { kind: "corrupt-session" }, context: { ...context, navigating: false } };

    case "permission-lost":
      return { state: { kind: "permission-lost" }, context: { ...context, navigating: false } };

    case "resume-required":
      return { state: { kind: "resume-offer" }, context: { ...context, navigating: false } };

    case "resume-accepted": {
      const next = { ...context, navigating: true };
      return { state: settle(next, { kind: "loading" }), context: next };
    }

    case "protocol-incompatible":
      return { state: { kind: "incompatible-shell" }, context };

    case "dismissed": {
      // Dismissing an explanatory state returns to whatever the page is doing.
      if (state.kind === "fatal-config") return snapshot;
      return { state: settle(context, { kind: "loading" }), context };
    }
  }
}
