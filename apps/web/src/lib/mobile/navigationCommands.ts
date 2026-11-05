/**
 * The only way the page mutates a native navigation session.
 *
 * Two properties matter here and neither is negotiable.
 *
 * First, mutations are serialized. Two `session.start` calls racing each other
 * produce two sessions, one of which nobody is watching but which is still
 * holding a location subscription. Every mutation therefore queues behind the
 * previous one, and a failed mutation does not poison the queue.
 *
 * Second, start is native-first. The page builds a bounded package, asks the
 * shell to prepare it, waits for the permission flow, then starts — and only
 * enters the navigation UI once the shell has answered with an authoritative
 * revision. The alternative (start the browser store optimistically and roll
 * back on failure) means the UI has already told the driver they are navigating
 * when they are not.
 */

import type { BridgeClient } from "./bridgeClient";
import { BridgeError } from "./bridgeClient";

/** How long a prepare may take, matching the client's slow-path budget. */
export const PREPARE_TIMEOUT_MS = 15_000;
/** Native may wait ten minutes for a settings round trip; allow its reply time. */
const START_TIMEOUT_MS = 10 * 60_000 + PREPARE_TIMEOUT_MS;

export interface StartedSession {
  sessionId: string;
  revision: number;
}

export type CommandFailure =
  | "unavailable"
  | "incompatible"
  | "permission-denied"
  | "rejected"
  | "timeout";

export class CommandError extends Error {
  readonly code: CommandFailure;

  constructor(code: CommandFailure) {
    super(`navigation command failed: ${code}`);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface NavigationSettingsPatch {
  voiceEnabled?: boolean;
  keepScreenOn?: boolean;
  voiceTiming?: "early" | "normal" | "late";
  alightAlertsEnabled?: boolean;
  locale?: "en" | "de";
  units?: "metric" | "imperial";
}

/** What the commands need to know about the session the page is rendering. */
export interface AcknowledgedRevision {
  sessionId: string | null;
  revision: number | null;
}

/**
 * Translates a transport failure into something a caller can act on.
 *
 * A timeout and a refusal are genuinely different: one means try again, the
 * other means this shell will never do it.
 */
function asCommandError(error: unknown): CommandError {
  if (error instanceof BridgeError) {
    if (error.code === "incompatible") return new CommandError("incompatible");
    if (error.code === "timeout") return new CommandError("timeout");
    if (error.code === "no-transport" || error.code === "channel-reset") {
      return new CommandError("unavailable");
    }
  }
  if (error instanceof CommandError) return error;
  return new CommandError("rejected");
}

export class NativeNavigationCommands {
  /** Mutations queue behind this; reads deliberately do not. */
  private queue: Promise<unknown> = Promise.resolve();
  private pendingMutations = 0;
  get isMutating(): boolean {
    return this.pendingMutations > 0;
  }

  constructor(
    private readonly client: BridgeClient,
    private readonly acknowledged: () => AcknowledgedRevision,
  ) {}

  /**
   * Runs `task` after every mutation queued before it.
   *
   * The queue is advanced with a swallowed rejection so one failed command does
   * not strand every later one, while the caller still sees its own failure.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    this.pendingMutations++;
    const result = this.queue.then(task, task).finally(() => {
      this.pendingMutations--;
    });
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Prepares and then starts a session.
   *
   * `onPrepared` runs after the shell accepts the package and before start is
   * requested. Native start can then show its own permission screens, so it has
   * a separate budget from ordinary reads.
   */
  start(startPackage: unknown, onPrepared?: () => Promise<void> | void): Promise<StartedSession> {
    return this.serialize(async () => {
      let startRequested = false;
      try {
        const prepared = await this.client.request(
          "session.prepare",
          { startPackage },
          { timeoutMs: PREPARE_TIMEOUT_MS },
        );
        if (prepared.type !== "session.prepared") throw new CommandError("rejected");

        await onPrepared?.();

        startRequested = true;
        const started = await this.client.request(
          "session.start",
          {},
          { timeoutMs: START_TIMEOUT_MS },
        );
        if (started.type !== "session.started") throw new CommandError("rejected");
        const payload = started.payload as { sessionId: string; revision: number };
        return { sessionId: payload.sessionId, revision: payload.revision };
      } catch (error) {
        const failure = asCommandError(error);
        // A deadline is not proof that native stopped. Its eventual snapshot
        // remains authoritative, including a start completed after permission UI.
        if (startRequested && failure.code === "timeout") void this.requestSnapshot();
        throw failure;
      }
    });
  }

  /** Swaps the followed route or itinerary on the running session. */
  replace(startPackage: unknown, expectedItineraryFingerprint?: string): Promise<StartedSession> {
    return this.serialize(async () => {
      try {
        const replaced = await this.client.request(
          "session.replace",
          {
            startPackage,
            ...(expectedItineraryFingerprint ? { expectedItineraryFingerprint } : {}),
          },
          { ...this.stamp(), timeoutMs: PREPARE_TIMEOUT_MS },
        );
        if (replaced.type !== "session.replaced") throw new CommandError("rejected");
        const payload = replaced.payload as { sessionId: string; revision: number };
        return { sessionId: payload.sessionId, revision: payload.revision };
      } catch (error) {
        throw asCommandError(error);
      }
    });
  }

  repairTransitWalk(itineraryFingerprint: string, legIndex: number, route: unknown): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.client.request(
          "transit.walk-route",
          { itineraryFingerprint, legIndex, route },
          { sessionId: this.acknowledged().sessionId ?? undefined },
        );
      } catch (error) {
        throw asCommandError(error);
      }
    });
  }

  transitAction(payload: {
    actionId: string;
    itineraryFingerprint: string;
    expectedPhase: "walking" | "waiting-to-board" | "riding" | "transferring" | "arrived";
    type: "board" | "alight" | "continue" | "undo";
    legIndex: number;
  }): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.client.request("transit.action", payload, {
          sessionId: this.acknowledged().sessionId ?? undefined,
        });
      } catch (error) {
        throw asCommandError(error);
      }
    });
  }

  /** Ends the session. `arrived` reports a trip that finished on its own. */
  stop(arrived = false): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.client.request(arrived ? "session.complete" : "session.stop", {}, this.stamp());
      } catch (error) {
        throw asCommandError(error);
      }
    });
  }

  /** Applies a settings change to the native session. */
  updateSettings(patch: NavigationSettingsPatch): Promise<void> {
    return this.serialize(async () => {
      try {
        await this.client.request("settings.update", patch, this.stamp());
      } catch (error) {
        throw asCommandError(error);
      }
    });
  }

  /**
   * Asks for the whole session state.
   *
   * Not serialized: it mutates nothing, and making it wait behind a slow prepare
   * is exactly the case where the page most needs to know where it stands.
   */
  requestSnapshot(): Promise<void> {
    return this.client.request("snapshot.request", {}, {}).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Acknowledges rendered events so a reconnect does not replay them. */
  acknowledgeEvents(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return Promise.resolve();
    try {
      this.client.send("event.ack", { eventIds: [...eventIds] }, {});
    } catch {
      // A reconnect replays unacknowledged events, so a failed acknowledgement
      // is safe to abandon and must not create a request that can only time out.
    }
    return Promise.resolve();
  }

  /**
   * The session and revision this page has actually rendered.
   *
   * Sent with every mutation so the shell can refuse a command issued against a
   * state the user was no longer looking at.
   */
  private stamp(): { sessionId?: string; revision?: number } {
    const { sessionId, revision } = this.acknowledged();
    return {
      ...(sessionId === null ? {} : { sessionId }),
      ...(revision === null ? {} : { revision }),
    };
  }
}
