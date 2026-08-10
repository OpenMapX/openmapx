import { actionsFor, SHELL_ACTIONS, type ShellState } from "./ShellState";
import { INITIAL_SHELL, type ShellEvent, type ShellSnapshot, shellReducer } from "./shellReducer";

function drive(events: readonly ShellEvent[], from: ShellSnapshot = INITIAL_SHELL): ShellSnapshot {
  return events.reduce(shellReducer, from);
}

const LOADED: ShellEvent[] = [
  { type: "document-load-started" },
  { type: "document-load-succeeded" },
];

describe("shellReducer", () => {
  it("starts by loading, showing no native chrome once the page arrives", () => {
    expect(INITIAL_SHELL.state).toEqual({ kind: "loading" });
    expect(drive(LOADED).state).toEqual({ kind: "web" });
  });

  it("shows a retryable error when the page fails with no session running", () => {
    const { state } = drive([{ type: "document-load-failed", offline: false }]);

    expect(state).toEqual({ kind: "load-error", offline: false });
    expect(actionsFor(state)).toEqual(["retry"]);
  });

  it("records that a failure was caused by being offline", () => {
    const { state } = drive([{ type: "document-load-failed", offline: true }]);

    expect(state).toEqual({ kind: "load-error", offline: true });
  });

  it("explains that guidance continues when the page fails mid-session", () => {
    const { state } = drive([
      ...LOADED,
      { type: "session-started" },
      { type: "document-load-failed", offline: true },
    ]);

    expect(state).toEqual({ kind: "offline-navigating" });
    expect(actionsFor(state)).toEqual(["retry", "open-network-settings", "end"]);
  });

  it("keeps explaining during the reload that follows the failure", () => {
    const { state } = drive([
      ...LOADED,
      { type: "session-started" },
      { type: "document-load-failed", offline: true },
      { type: "document-load-started" },
    ]);

    // A plain loading spinner here would suggest guidance had stopped.
    expect(state).toEqual({ kind: "offline-navigating" });
  });

  it("returns to the page once a retry loads, without restarting anything", () => {
    const { state, context } = drive([
      ...LOADED,
      { type: "session-started" },
      { type: "document-load-failed", offline: true },
      ...LOADED,
    ]);

    expect(state).toEqual({ kind: "web" });
    expect(context.navigating).toBe(true);
  });

  it("ignores the load-end both platforms report after an error", () => {
    // `onError` and `onLoadEnd` both fire for the same failed navigation, so a
    // success that was never preceded by a new attempt is not a recovery.
    const { state } = drive([
      { type: "document-load-failed", offline: false },
      { type: "document-load-succeeded" },
    ]);

    expect(state).toEqual({ kind: "load-error", offline: false });
  });

  it("clears the offline explanation when the session ends", () => {
    const { state } = drive([
      ...LOADED,
      { type: "session-started" },
      { type: "document-load-failed", offline: true },
      { type: "session-ended" },
    ]);

    expect(state).toEqual({ kind: "load-error", offline: true });
  });

  describe("states a page event must not overwrite", () => {
    it.each<[string, ShellEvent, ShellState]>([
      ["permission loss", { type: "permission-lost" }, { kind: "permission-lost" }],
      ["a quarantined session", { type: "session-quarantined" }, { kind: "corrupt-session" }],
      ["a resume offer", { type: "resume-required" }, { kind: "resume-offer" }],
      ["a fatal configuration", { type: "config-invalid" }, { kind: "fatal-config" }],
    ])("survives a reload after %s", (_label, event, expected) => {
      const { state } = drive([...LOADED, event, ...LOADED]);

      expect(state).toEqual(expected);
    });

    it.each<[string, ShellEvent]>([
      ["permission loss", { type: "permission-lost" }],
      ["a quarantined session", { type: "session-quarantined" }],
    ])("survives connectivity coming back after %s", (_label, event) => {
      const before = drive([...LOADED, event]).state;

      const after = drive(
        [{ type: "connectivity-changed", online: true }],
        drive([...LOADED, event]),
      );

      expect(after.state).toEqual(before);
    });
  });

  it("offers only settings and end after permission loss", () => {
    const { state } = drive([...LOADED, { type: "session-started" }, { type: "permission-lost" }]);

    expect(actionsFor(state)).toEqual(["open-app-settings", "end"]);
    // Re-prompting is the one thing this state must never do.
    expect(actionsFor(state)).not.toContain("retry");
  });

  it("marks a session as no longer running when permission is lost", () => {
    const { context } = drive([
      ...LOADED,
      { type: "session-started" },
      { type: "permission-lost" },
    ]);

    expect(context.navigating).toBe(false);
  });

  it("offers resume or end after a force-stop, and nothing else", () => {
    const { state } = drive([...LOADED, { type: "resume-required" }]);

    expect(state).toEqual({ kind: "resume-offer" });
    expect(actionsFor(state)).toEqual(["resume", "end"]);
  });

  it("returns to the page when the user resumes", () => {
    const { state, context } = drive([
      ...LOADED,
      { type: "resume-required" },
      { type: "resume-accepted" },
    ]);

    expect(state).toEqual({ kind: "web" });
    expect(context.navigating).toBe(true);
  });

  it("returns to the page when the user ends a recovered session", () => {
    const { state, context } = drive([
      ...LOADED,
      { type: "resume-required" },
      { type: "session-ended" },
    ]);

    expect(state).toEqual({ kind: "web" });
    expect(context.navigating).toBe(false);
  });

  it("reports an incompatible protocol without offering a fix it does not have", () => {
    const { state } = drive([...LOADED, { type: "protocol-incompatible" }]);

    expect(state).toEqual({ kind: "incompatible-shell" });
    expect(actionsFor(state)).toEqual(["dismiss"]);
  });

  it("lets the user dismiss an explanation and go back to the page", () => {
    const { state } = drive([...LOADED, { type: "protocol-incompatible" }, { type: "dismissed" }]);

    expect(state).toEqual({ kind: "web" });
  });

  it("offers nothing at all for a fatal configuration, and cannot be dismissed", () => {
    const fatal = drive([{ type: "config-invalid" }]);

    expect(actionsFor(fatal.state)).toEqual([]);
    expect(drive([{ type: "dismissed" }], fatal).state).toEqual({ kind: "fatal-config" });
  });

  it("never offers a navigation control from any state", () => {
    const forbidden = ["start", "reroute", "next-step", "mute", "recenter"];

    for (const actions of Object.values(SHELL_ACTIONS)) {
      for (const action of actions) expect(forbidden).not.toContain(action);
    }
  });

  it("keeps every state's action list within the declared vocabulary", () => {
    const allowed = new Set([
      "retry",
      "open-network-settings",
      "resume",
      "end",
      "dismiss",
      "open-app-settings",
    ]);

    for (const actions of Object.values(SHELL_ACTIONS)) {
      for (const action of actions) expect(allowed.has(action)).toBe(true);
    }
  });
});
