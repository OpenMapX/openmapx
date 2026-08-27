import {
  isMobileSessionExpired,
  type MobileNavigationSession,
  type NativeToWebMessage,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import { type RawLocation, sanitiseFixes } from "../location/sanitiseFixes";
import type { CommitResult, SessionEffect, SessionRepository } from "../storage/SessionRepository";
import type { DiagnosticSink, EffectRunner } from "./effects";
import type { AnyNavigationProcessor, ProcessorMutation, ProcessorRegistry } from "./processor";
import { SerialExecutor } from "./serialExecutor";
import { groundFullSnapshot } from "./snapshots/groundSnapshot";
import { transitFullSnapshot } from "./snapshots/transitSnapshot";

/**
 * The single authority over an active navigation session.
 *
 * Every mutating path — a command from the page, a location batch from the
 * operating system, a connectivity change — enters the same FIFO queue and
 * leaves through the same three steps: check preconditions, commit, then run
 * effects. Nothing observable happens before the commit, so a process killed
 * mid-flight loses a prompt rather than repeating one or, worse, speaking a cue
 * for a state that was never persisted.
 */

export interface CommandResponse {
  type: NativeToWebMessage["type"];
  payload: unknown;
  sessionId?: string;
  revision?: number;
}

export interface BridgePort {
  send(
    type: NativeToWebMessage["type"],
    payload: unknown,
    options?: { sessionId?: string; revision?: number; forMessageId?: string },
  ): unknown;
}

export interface PermissionPort {
  /** The OS permission as last observed. Never triggers a prompt. */
  state(): Promise<"not-determined" | "foreground" | "background" | "denied" | "limited">;
  /** Whether the app is foregrounded, which Android requires to start a service. */
  isAppActive(): boolean;
  /** The disclosure-and-request flow. Resolves once the user has decided. */
  requestForStart(): Promise<"background" | "foreground-only" | "denied">;
}

export interface DriverPort {
  isRunning(): Promise<boolean>;
}

export interface CoordinatorDeps {
  repository: SessionRepository;
  processors: ProcessorRegistry;
  effects: EffectRunner;
  bridge: BridgePort;
  permissions: PermissionPort;
  driver: DriverPort;
  diagnostics: DiagnosticSink;
  clock: () => number;
  newSessionId: () => string;
  /**
   * Handles commands that are not about a navigation session —
   * a one-off location fix, opening OS settings, a system-browser sign-in.
   *
   * Optional so focused session tests need no stand-in. When absent the command
   * is refused rather than dropped: a page waiting on a reply that never comes
   * cannot tell "unsupported" from "broken".
   */
  auxiliary?: AuxiliaryCommandHandler;
}

/** Answers an auxiliary command the coordinator does not own, or declines it. */
export type AuxiliaryCommandHandler = (
  command: WebToNativeMessage,
) => Promise<CommandResponse | null>;

/** Commands whose response must survive a replay unchanged. */
const MUTATING = new Set<WebToNativeMessage["type"]>([
  "session.prepare",
  "session.start",
  "session.replace",
  "settings.update",
  "session.stop",
  "session.complete",
]);

function errorResponse(code: string, forMessageId?: string): CommandResponse {
  return {
    type: "native.error",
    payload: forMessageId ? { code, forMessageId } : { code },
  };
}

export class NavigationCoordinator {
  constructor(
    private readonly deps: CoordinatorDeps,
    private readonly queue = new SerialExecutor(),
  ) {}

  // Commands from the page.

  async dispatch(command: WebToNativeMessage): Promise<CommandResponse | null> {
    return this.queue.run(() => this.handleCommand(command));
  }

  private async handleCommand(command: WebToNativeMessage): Promise<CommandResponse | null> {
    const { repository, clock } = this.deps;
    const now = clock();

    if (MUTATING.has(command.type)) {
      // A page that retried after a timeout must get the same answer, not a
      // second execution. The durable table is what makes that survive a
      // restart; the channel's in-memory set only covers one document.
      const cached = await repository.lookupCommand(command.messageId, now);
      if (cached) {
        const response = cached as CommandResponse;
        this.reply(response, command.messageId);
        return response;
      }
    }

    let response: CommandResponse | null;
    try {
      response = await this.route(command, now);
    } catch {
      this.deps.diagnostics.record("typed.error", { scope: "command", type: command.type });
      response = errorResponse("internal-error", command.messageId);
    }

    if (response && MUTATING.has(command.type)) {
      await repository.rememberCommand(
        command.messageId,
        response.sessionId ?? null,
        response,
        now,
      );
    }
    if (response) this.reply(response, command.messageId);
    return response;
  }

  private reply(response: CommandResponse, forMessageId: string): void {
    this.deps.bridge.send(response.type, response.payload, {
      ...(response.sessionId === undefined ? {} : { sessionId: response.sessionId }),
      ...(response.revision === undefined ? {} : { revision: response.revision }),
      forMessageId,
    });
  }

  private async route(command: WebToNativeMessage, now: number): Promise<CommandResponse | null> {
    switch (command.type) {
      case "web.hello":
        // Answered by the bridge during the handshake; nothing to coordinate.
        return null;
      case "session.prepare":
        return this.prepare(command, now);
      case "session.start":
        return this.start(command, now);
      case "session.replace":
        return this.replace(command, now);
      case "settings.update":
        return this.updateSettings(command, now);
      case "snapshot.request":
        return this.snapshot(now);
      case "session.stop":
        return this.terminate(command, "stopped", now);
      case "session.complete":
        return this.terminate(command, "arrived", now);
      case "event.ack":
        await this.deps.repository.ackEvents(command.payload.eventIds);
        return null;
      case "location.request":
      case "settings.open":
      case "auth.open": {
        const handled = await this.deps.auxiliary?.(command);
        return handled ?? errorResponse("unsupported-capability", command.messageId);
      }
    }
  }

  // Preparing a session.

  private async prepare(
    command: Extract<WebToNativeMessage, { type: "session.prepare" }>,
    now: number,
  ): Promise<CommandResponse> {
    const { repository, processors, newSessionId } = this.deps;
    const kind = command.payload.startPackage.kind;
    const processor = processors.get(kind);
    if (!processor) return errorResponse("mode-unsupported", command.messageId);

    const existing = await repository.loadActive(now);
    if (existing && !this.isTerminal(existing) && !isMobileSessionExpired(existing, now)) {
      return errorResponse("session-active", command.messageId);
    }

    const prepared = processor.prepare(command.payload.startPackage as never, {
      sessionId: newSessionId(),
      nowMs: now,
      // Upgraded to `background` only once the user has actually granted it.
      permissionMode: "foreground-only",
    });
    if (!prepared.ok) return errorResponse(prepared.code, command.messageId);

    const created = await repository.createPreparing(prepared.session);
    if (!created.ok) return errorResponse(created.code, command.messageId);

    return {
      type: "session.prepared",
      payload: { sessionId: prepared.session.sessionId, revision: prepared.session.revision },
      sessionId: prepared.session.sessionId,
      revision: prepared.session.revision,
    };
  }

  // Starting a prepared session.

  /**
   * Turns a prepared session into a running one.
   *
   * The order matters: consent, then commit, then start the driver. Starting
   * first would mean a crash between the two left the operating system tracking
   * a session no record mentions — precisely the state a user cannot discover
   * or stop.
   */
  private async start(
    command: Extract<WebToNativeMessage, { type: "session.start" }>,
    now: number,
  ): Promise<CommandResponse> {
    const { repository, permissions } = this.deps;
    const current = await repository.loadActive(now);
    if (!current) return errorResponse("no-session", command.messageId);
    if (!this.matches(command, current))
      return errorResponse("revision-conflict", command.messageId);
    if (current.status !== "preparing") return errorResponse("invalid-state", command.messageId);
    if (!this.deps.processors.supports(current.kind)) {
      return errorResponse("mode-unsupported", command.messageId);
    }
    // Android refuses to start a location foreground service from the
    // background, and asking for permission while invisible is a prompt the user
    // cannot connect to anything they did.
    if (!permissions.isAppActive()) return errorResponse("app-not-visible", command.messageId);

    const decision = await permissions.requestForStart();
    if (decision === "denied") {
      await repository.terminate(current.sessionId, "error", now);
      return errorResponse("permission-denied", command.messageId);
    }

    const committed = await repository.compareAndSwap(
      current.sessionId,
      current.revision,
      (session) => ({
        session: {
          ...session,
          revision: session.revision + 1,
          status: "active",
          updatedAtMs: now,
          permissionMode: decision,
        },
        effects: [
          { kind: "start-location", permissionMode: decision },
          { kind: "publish-snapshot", immediate: true },
        ],
      }),
      now,
    );
    if (!committed.ok) return errorResponse(committed.code, command.messageId);

    const { failed } = await this.deps.effects.run(committed.effects);
    if (failed > 0) {
      // The driver could not be started, so the session must not claim it is
      // tracking. Terminalise atomically rather than leaving a phantom.
      const cleanup = await repository.terminate(committed.session.sessionId, "error", now);
      await this.deps.effects.run(cleanup.effects);
      return errorResponse("driver-start-failed", command.messageId);
    }

    return {
      type: "session.started",
      payload: { sessionId: committed.session.sessionId, revision: committed.session.revision },
      sessionId: committed.session.sessionId,
      revision: committed.session.revision,
    };
  }

  // Swapping the followed route or itinerary.

  private async replace(
    command: Extract<WebToNativeMessage, { type: "session.replace" }>,
    now: number,
  ): Promise<CommandResponse> {
    const current = await this.deps.repository.loadActive(now);
    if (!current) return errorResponse("no-session", command.messageId);
    if (!this.matches(command, current))
      return errorResponse("revision-conflict", command.messageId);
    if (current.status !== "active") return errorResponse("invalid-state", command.messageId);

    const processor = this.deps.processors.get(current.kind);
    if (!processor) return errorResponse("mode-unsupported", command.messageId);
    if (command.payload.startPackage.kind !== current.kind) {
      // Switching mode mid-session is a new session, not a replacement.
      return errorResponse("mode-mismatch", command.messageId);
    }

    const outcome = processor.replace(current as never, command.payload.startPackage, now);
    if ("ok" in outcome && outcome.ok === false)
      return errorResponse(outcome.code, command.messageId);

    const committed = await this.commit(current, outcome as ProcessorMutation, now);
    if (!committed.ok) return errorResponse(committed.code, command.messageId);

    return {
      type: "session.replaced",
      payload: { sessionId: committed.session.sessionId, revision: committed.session.revision },
      sessionId: committed.session.sessionId,
      revision: committed.session.revision,
    };
  }

  // Settings changes.

  private async updateSettings(
    command: Extract<WebToNativeMessage, { type: "settings.update" }>,
    now: number,
  ): Promise<CommandResponse> {
    const current = await this.deps.repository.loadActive(now);
    if (!current) return errorResponse("no-session", command.messageId);
    if (!this.matches(command, current))
      return errorResponse("revision-conflict", command.messageId);

    const { locale, units } = command.payload;
    const committed = await this.deps.repository.compareAndSwap(
      current.sessionId,
      current.revision,
      (session) => ({
        session: {
          ...session,
          revision: session.revision + 1,
          updatedAtMs: now,
          ...(locale === undefined ? {} : { locale }),
          ...(units === undefined ? {} : { units }),
        },
        effects: [{ kind: "publish-snapshot", immediate: true }],
      }),
      now,
    );
    if (!committed.ok) return errorResponse(committed.code, command.messageId);
    await this.deps.effects.run(committed.effects);

    return {
      type: "snapshot.update",
      payload: { snapshot: this.snapshotOf(committed.session) },
      sessionId: committed.session.sessionId,
      revision: committed.session.revision,
    };
  }

  // Snapshot requests.

  private async snapshot(now: number): Promise<CommandResponse> {
    const current = await this.deps.repository.loadActive(now);
    if (!current) return { type: "snapshot.update", payload: { snapshot: {} } };
    return {
      type: "snapshot.update",
      payload: { snapshot: this.snapshotOf(current) },
      sessionId: current.sessionId,
      revision: current.revision,
    };
  }

  /**
   * The one projection every response uses.
   *
   * It delegates to the mode-specific snapshot builders rather than reshaping
   * the session here. An earlier version blanked `payload.refreshToken` and
   * looked correct — but the transit token also lives *inside* the itinerary the
   * server shaped, so the reply still carried it. Anything leaving native goes
   * through the builders, which strip by key at every depth.
   */
  private snapshotOf(session: MobileNavigationSession): Record<string, unknown> {
    return session.kind === "ground"
      ? (groundFullSnapshot(session) as unknown as Record<string, unknown>)
      : (transitFullSnapshot(session) as unknown as Record<string, unknown>);
  }

  // Ending a session.

  private async terminate(
    command: WebToNativeMessage,
    finalStatus: "stopped" | "arrived",
    now: number,
  ): Promise<CommandResponse> {
    const { repository } = this.deps;
    const current = await repository.loadActive(now);
    if (!current) {
      // Stopping nothing is success, not an error: a retry after the process
      // died must not surface as a failure the user has to act on.
      const sessionId = command.sessionId;
      const ack = sessionId ? await repository.readTerminalAck(sessionId) : null;
      return {
        type: "session.stopped",
        payload: {
          sessionId: sessionId ?? "",
          finalStatus: ack?.finalStatus ?? finalStatus,
          revision: ack?.finalRevision ?? 0,
        },
        ...(sessionId ? { sessionId } : {}),
      };
    }
    if (command.sessionId !== undefined && command.sessionId !== current.sessionId) {
      return errorResponse("revision-conflict", command.messageId);
    }

    const { ack, effects } = await repository.terminate(current.sessionId, finalStatus, now);
    await this.deps.effects.run(effects);
    return {
      type: "session.stopped",
      payload: {
        sessionId: current.sessionId,
        finalStatus: ack?.finalStatus ?? finalStatus,
        revision: ack?.finalRevision ?? current.revision,
      },
      sessionId: current.sessionId,
    };
  }

  // Location input from the driver.

  /**
   * The one entry point for fixes, used identically by the foreground app and
   * the headless background task.
   *
   * A revision conflict here means a command committed while the batch was in
   * flight. Reloading and retrying once is safe precisely because a batch is
   * commutative with respect to the newer state — unlike a user's stop or route
   * replacement, which is never replayed against a revision it did not see.
   */
  async handleLocationBatch(batch: {
    locations: readonly RawLocation[];
    errorCode?: string;
  }): Promise<void> {
    await this.queue.run(async () => {
      try {
        await this.processBatch(batch, true);
      } catch {
        // A throwing OS task callback is retried aggressively; swallowing keeps
        // a transient failure from becoming a wake-up loop.
        this.deps.diagnostics.record("typed.error", { scope: "location-batch" });
      }
    });
  }

  private async processBatch(
    batch: { locations: readonly RawLocation[]; errorCode?: string },
    mayRetry: boolean,
  ): Promise<void> {
    const { repository, processors, clock, diagnostics } = this.deps;
    const now = clock();
    const session = await repository.loadActive(now);
    if (!session) return;

    if (isMobileSessionExpired(session, now)) {
      const expired = await repository.terminate(session.sessionId, "expired", now);
      await this.deps.effects.run(expired.effects);
      return;
    }
    if (session.status !== "active") return;

    const processor = processors.get(session.kind);
    if (!processor) return;

    const { accepted, rejectedCount } = sanitiseFixes(
      batch.locations ?? [],
      now,
      session.lastAcceptedFix?.timestampMs ?? null,
    );
    diagnostics.record("location.batch", {
      accepted: accepted.length,
      rejected: rejectedCount,
      ...(batch.errorCode ? { errorCode: batch.errorCode.slice(0, 64) } : {}),
    });
    // A wake-up that carried no usable position is not always nothing to do. A
    // transit rider underground produces no fix for twenty minutes, and the
    // engine still has to advance the leg from the schedule or the banner
    // freezes on a stop the train left long ago. Ground has no such fallback, so
    // an empty batch there really is nothing.
    if (accepted.length === 0 && !processor.needsScheduleTicks) return;

    const mutation = (processor as AnyNavigationProcessor).processFixes(
      session as never,
      accepted,
      now,
    );
    const committed = await this.commit(session, mutation, now);
    if (committed.ok) {
      await this.deps.effects.run(committed.effects);
      return;
    }
    if (committed.code === "revision-conflict" && mayRetry) {
      await this.processBatch(batch, false);
    }
  }

  // Internals.

  private async commit(
    current: MobileNavigationSession,
    mutation: ProcessorMutation,
    now: number,
  ): Promise<CommitResult> {
    return this.deps.repository.compareAndSwap(
      current.sessionId,
      current.revision,
      () => ({
        session: mutation.session,
        effects: mutation.effects ?? [],
        ...(mutation.enqueue ? { enqueue: mutation.enqueue } : {}),
        ...(mutation.alerts ? { alerts: mutation.alerts } : {}),
      }),
      now,
    );
  }

  private matches(command: WebToNativeMessage, session: MobileNavigationSession): boolean {
    if (command.sessionId !== undefined && command.sessionId !== session.sessionId) return false;
    if (command.revision !== undefined && command.revision !== session.revision) return false;
    return true;
  }

  private isTerminal(session: MobileNavigationSession): boolean {
    return ["arrived", "stopped", "expired", "error"].includes(session.status);
  }

  /** Effects awaiting nothing; exposed so lifecycle code can run cleanup intents. */
  async runEffects(effects: readonly SessionEffect[]): Promise<void> {
    await this.queue.run(() => this.deps.effects.run(effects));
  }

  /** Resolves once every queued operation has settled. */
  async settle(): Promise<void> {
    await this.queue.drain();
  }
}
