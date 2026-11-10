import {
  isMobileSessionExpired,
  type MobileNavigationSession,
  mergeTransitRefresh,
  type NativeToWebMessage,
  prepareTransitProgress,
  refreshTransitCaptures,
  transitProgressFromTick,
  transitStartPackageSchema,
  type WebToNativeMessage,
} from "@openmapx/core/navigation";
import type { SendOutcome } from "../bridge/nativeBridge";
import type { ConnectivityState } from "../connectivity/ConnectivityDriver";
import { type RawLocation, sanitiseFixes } from "../location/sanitiseFixes";
import type { CommitResult, SessionEffect, SessionRepository } from "../storage/SessionRepository";
import { locationReleaseAtMs } from "./arrival";
import type { DiagnosticSink, EffectRunner } from "./effects";
import type { RerouteOutcome } from "./ground/GroundRerouteService";
import { onRerouteFailed, onRerouteSucceeded, type RerouteRuntime } from "./ground/rerouteState";
import type { AnyNavigationProcessor, ProcessorMutation, ProcessorRegistry } from "./processor";
import { SerialExecutor } from "./serialExecutor";
import { profileForSession } from "./sessionProfile";
import { applySettingsPatch } from "./sessionSettings";
import { groundFullSnapshot } from "./snapshots/groundSnapshot";
import { transitFullSnapshot } from "./snapshots/transitSnapshot";
import { allowsNavigationStart, type NavigationStartContext } from "./startContext";
import { onRefreshFailed, onRefreshSucceeded } from "./transit/refreshState";
import type { RefreshOutcome } from "./transit/TransitRefreshService";

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
  /** `invalid` means the message failed its schema and was not sent. */
  send(
    type: NativeToWebMessage["type"],
    payload: unknown,
    options?: { sessionId?: string; revision?: number; forMessageId?: string },
  ): SendOutcome;
}

export interface PermissionPort {
  /** The OS permission as last observed. Never triggers a prompt. */
  state(): Promise<"not-determined" | "foreground" | "background" | "denied" | "limited">;
  /** Whether the app is foregrounded, which Android requires to start a service. */
  isAppActive(): boolean;
  startContext?(): NavigationStartContext;
  /** The disclosure-and-request flow. Resolves once the user has decided. */
  requestForStart(): Promise<"background" | "foreground-only" | "denied">;
}

export interface DriverPort {
  isRunning(): Promise<boolean>;
}

/** The connectivity state that has held long enough to act on. */
export interface ConnectivityPort {
  confirmed(): ConnectivityState;
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
  /** Runs `callback` once after `delayMs`; returns a cancel function. Defaults to `setTimeout`. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  newSessionId: () => string;
  /**
   * Confirmed connectivity. Optional so focused session tests need no stand-in;
   * without it a session's connectivity stays as it was committed.
   */
  connectivity?: ConnectivityPort;
}

/** Commands whose response must survive a replay unchanged. */
const MUTATING = new Set<WebToNativeMessage["type"]>([
  "session.prepare",
  "session.start",
  "session.replace",
  "transit.action",
  "transit.walk-route",
  "settings.update",
  "session.stop",
  "session.complete",
]);

function scheduleWithTimer(callback: () => void, delayMs: number): () => void {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
}

function errorResponse(code: string, forMessageId?: string): CommandResponse {
  return {
    type: "native.error",
    payload: forMessageId ? { code, forMessageId } : { code },
  };
}

export class NavigationCoordinator {
  private readonly remoteTasks = new Set<Promise<void>>();
  trackRemoteWork(work: Promise<void>): void {
    this.remoteTasks.add(work);
    void work.then(
      () => this.remoteTasks.delete(work),
      () => this.remoteTasks.delete(work),
    );
  }
  async settleRemoteWork(): Promise<void> {
    while (this.remoteTasks.size > 0) await Promise.allSettled([...this.remoteTasks]);
  }

  private cancelLocationRelease: (() => void) | null = null;

  constructor(
    private readonly deps: CoordinatorDeps,
    private readonly queue = new SerialExecutor(),
  ) {}

  /** A confirmed OS action cannot act on whichever trip happens to be current. */
  stopFromSurface(expectedSessionId: string): Promise<boolean> {
    return this.queue.run(async () => {
      const current = await this.deps.repository.loadActive(this.deps.clock());
      if (!current || current.sessionId !== expectedSessionId) return false;
      const response = await this.terminate(
        { sessionId: expectedSessionId, messageId: "native-surface" },
        "stopped",
        this.deps.clock(),
      );
      this.deps.bridge.send(response.type, response.payload, { sessionId: expectedSessionId });
      return true;
    });
  }

  // Commands from the page.

  async dispatch(command: WebToNativeMessage): Promise<CommandResponse | null> {
    return this.queue.run(() => this.handleCommand(command));
  }

  /** Car starts enter the same executor; authorization is checked again after planning. */
  startCarTrip(
    startPackage: import("@openmapx/core/navigation").GroundNavigationStartPackage,
    context: () => NavigationStartContext,
    valid: () => boolean,
    replaceSessionId?: string,
  ): Promise<CommandResponse | null> {
    return this.queue.run(async () => {
      if (!valid()) return errorResponse("invalid-state");
      const now = this.deps.clock();
      if (!allowsNavigationStart(context(), await this.deps.permissions.state()))
        return errorResponse("app-not-visible");
      const current = await this.deps.repository.loadActive(now);
      const base = {
        protocolVersion: 3,
        messageId: `car-start-${this.deps.newSessionId()}`,
        channelNonce: "car-native",
        sentAtMs: now,
      };
      if (current && !this.isTerminal(current)) {
        if (current.sessionId !== replaceSessionId) return errorResponse("session-active");
        await this.terminate(
          { messageId: base.messageId, sessionId: current.sessionId },
          "stopped",
          now,
        );
      }
      if (!valid()) return errorResponse("invalid-state");
      const prepared = await this.prepare(
        { ...base, type: "session.prepare", payload: { startPackage } },
        now,
      );
      if (prepared.type !== "session.prepared") return prepared;
      if (!valid()) {
        await this.terminate(
          { messageId: base.messageId, sessionId: prepared.sessionId },
          "stopped",
          now,
        );
        return errorResponse("invalid-state");
      }
      const response = await this.start(
        {
          ...base,
          type: "session.start",
          payload: {},
          sessionId: prepared.sessionId,
          revision: prepared.revision,
        },
        now,
        context(),
        valid,
      );
      this.reply(response, base.messageId);
      return response;
    });
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
    const outcome = this.deps.bridge.send(response.type, response.payload, {
      ...(response.sessionId === undefined ? {} : { sessionId: response.sessionId }),
      ...(response.revision === undefined ? {} : { revision: response.revision }),
      forMessageId,
    });
    // A reply that fails its schema never leaves; the page would otherwise wait
    // out its deadline for an answer that was refused here.
    if (outcome === "invalid" && response.type !== "native.error") {
      this.deps.bridge.send("native.error", { code: "internal-error" }, { forMessageId });
    }
  }

  private async route(command: WebToNativeMessage, now: number): Promise<CommandResponse | null> {
    switch (command.type) {
      case "destinations.update":
        return null;
      case "voice.probe":
      case "voice.start":
      case "voice.stop":
      case "voice.cancel":
        // Voice commands are intercepted by the shell, outside this serial queue.
        return null;
      case "web.hello":
        // Answered by the bridge during the handshake; nothing to coordinate.
        return null;
      case "intake.list":
      case "intake.read":
      case "intake.complete":
        // Intake is composed by the visible shell, never the headless navigator.
        return errorResponse("unsupported-capability", command.messageId);
      case "session.prepare":
        return this.prepare(command, now);
      case "session.start":
        return this.start(command, now);
      case "session.replace":
        return this.replace(command, now);
      case "transit.walk-route":
        return this.repairTransitWalk(command, now);
      case "transit.action":
        return this.transitAction(command, now);
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
      case "auth.open":
        // Answered by the composition beside this queue (`isAuxiliaryCommand`):
        // a prompt or a sign-in must not hold up location batches. One that
        // reaches a coordinator with no such handler is refused, not dropped.
        return errorResponse("unsupported-capability", command.messageId);
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
    authorizedContext?: NavigationStartContext,
    valid: () => boolean = () => true,
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
    const startContext = authorizedContext ??
      permissions.startContext?.() ?? {
        kind: "phone",
        activityVisible: permissions.isAppActive(),
      };
    if (!allowsNavigationStart(startContext, await permissions.state()))
      return errorResponse("app-not-visible", command.messageId);

    const decision =
      startContext.kind === "car" ? "background" : await permissions.requestForStart();
    if (decision === "denied") {
      await repository.terminate(current.sessionId, "error", now);
      return errorResponse("permission-denied", command.messageId);
    }

    if (!valid()) return errorResponse("invalid-state", command.messageId);
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
    if (
      !(
        current.kind === "transit" &&
        command.sessionId === current.sessionId &&
        command.payload.expectedItineraryFingerprint ===
          current.payload.startPackage.itineraryFingerprint
      ) &&
      !this.matches(command, current)
    )
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

  private async repairTransitWalk(
    command: Extract<WebToNativeMessage, { type: "transit.walk-route" }>,
    now: number,
  ): Promise<CommandResponse> {
    const current = await this.deps.repository.loadActive(now);
    if (
      current?.kind !== "transit" ||
      current.status !== "active" ||
      current.sessionId !== command.sessionId ||
      current.payload.startPackage.itineraryFingerprint !== command.payload.itineraryFingerprint
    )
      return errorResponse("revision-conflict", command.messageId);
    const processor = this.deps.processors.get("transit");
    if (!processor?.repairTransitWalk) return errorResponse("mode-unsupported", command.messageId);
    const result = processor.repairTransitWalk(
      current as never,
      command.payload.legIndex,
      command.payload.route as never,
      now,
    );
    if ("ok" in result) return errorResponse(result.code, command.messageId);
    const committed = await this.commit(current, result, now);
    if (!committed.ok) return errorResponse(committed.code, command.messageId);
    await this.deps.effects.run(committed.effects);
    return this.snapshot(now);
  }

  private async transitAction(
    command: Extract<WebToNativeMessage, { type: "transit.action" }>,
    now: number,
  ): Promise<CommandResponse> {
    const current = await this.deps.repository.loadActive(now);
    if (current?.kind !== "transit") return errorResponse("no-session", command.messageId);
    const action = command.payload;
    if (
      current.sessionId !== command.sessionId ||
      current.payload.startPackage.itineraryFingerprint !== action.itineraryFingerprint
    )
      return errorResponse("revision-conflict", command.messageId);
    if (current.payload.tickState.lastActionId === action.actionId) return this.snapshot(now);
    // Arriving at the selected platform may race the tap; the processor still
    // validates that this board action targets the same immediately selected ride.
    const boardPhaseRace =
      action.type === "board" &&
      ["walking", "waiting-to-board"].includes(action.expectedPhase) &&
      ["walking", "waiting-to-board"].includes(current.payload.tickState.phase);
    if (
      (current.payload.tickState.phase !== action.expectedPhase && !boardPhaseRace) ||
      (current.status !== "active" && !(current.status === "arrived" && action.type === "undo"))
    )
      return errorResponse("invalid-state", command.messageId);
    const processor = this.deps.processors.get("transit");
    if (!processor?.transitAction) return errorResponse("mode-unsupported", command.messageId);
    const outcome = processor.transitAction(
      current as never,
      { type: action.type, legIndex: action.legIndex },
      now,
    );
    if ("ok" in outcome) return errorResponse(outcome.code, command.messageId);
    if (outcome.session.kind === "transit")
      outcome.session.payload.tickState.lastActionId = action.actionId;
    const committed = await this.commit(current, outcome, now);
    if (!committed.ok) return errorResponse(committed.code, command.messageId);
    await this.deps.effects.run(committed.effects);
    return {
      type: "snapshot.update",
      payload: { snapshot: this.snapshotOf(committed.session) },
      sessionId: committed.session.sessionId,
      revision: committed.session.revision,
    };
  }

  // Settings changes.

  private async updateSettings(
    command: Extract<WebToNativeMessage, { type: "settings.update" }>,
    now: number,
  ): Promise<CommandResponse> {
    // Only the trip is checked, not the revision: progress commits about once a
    // second, so the revision the page last saw is routinely behind, and every
    // field of the patch is an absolute value that is safe on top of newer state.
    let committed: CommitResult = { ok: false, code: "no-active-session" };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.deps.repository.loadActive(now);
      if (!current) return errorResponse("no-session", command.messageId);
      if (command.sessionId !== undefined && command.sessionId !== current.sessionId)
        return errorResponse("revision-conflict", command.messageId);
      committed = await this.deps.repository.compareAndSwap(
        current.sessionId,
        current.revision,
        (session) => applySettingsPatch(session, command.payload, now),
        now,
      );
      // A writer outside this queue may have committed between the read and the
      // swap; the patch is then applied once more on top of that revision.
      if (committed.ok || committed.code !== "revision-conflict") break;
    }
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
    command: { sessionId?: string; messageId: string },
    finalStatus: "stopped" | "arrived",
    now: number,
  ): Promise<CommandResponse> {
    const { repository } = this.deps;
    const current = await repository.loadActive(now);
    if (!current) {
      // Stopping a named trip that already ended is success, not an error: a
      // retry after the process died must not surface as a failure the user has
      // to act on. With no trip named there is nothing to acknowledge, and the
      // page treats `no-session` as already stopped.
      const sessionId = command.sessionId;
      if (!sessionId) return errorResponse("no-session", command.messageId);
      const ack = await repository.readTerminalAck(sessionId);
      return {
        type: "session.stopped",
        payload: {
          sessionId,
          finalStatus: ack?.finalStatus ?? finalStatus,
          revision: ack?.finalRevision ?? 0,
        },
        sessionId,
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
    if (!session) {
      await this.deps.effects.run([{ kind: "reconcile-surface" }]);
      return;
    }

    if (isMobileSessionExpired(session, now)) {
      const expired = await repository.terminate(session.sessionId, "expired", now);
      await this.deps.effects.run(expired.effects);
      return;
    }
    if (session.status !== "active") {
      // A batch closes the release window wherever a timer cannot: a
      // backgrounded Android app, whose profiles have no distance filter so a
      // user standing still still gets one, or a process that did not survive.
      const releaseAt = locationReleaseAtMs(session);
      if (releaseAt !== null && releaseAt <= now) {
        await this.deps.effects.run([{ kind: "stop-location" }, { kind: "reconcile-surface" }]);
        return;
      }
      this.scheduleLocationRelease(session, now);
      await this.deps.effects.run([{ kind: "reconcile-surface" }]);
      return;
    }

    const processor = processors.get(session.kind);
    if (!processor) return;
    // A batch is the one input a backgrounded Android app still receives, so it
    // also carries a connectivity change no timer could deliver.
    const current = await this.applyConnectivity(session, now);
    if (!current) {
      if (mayRetry) await this.processBatch(batch, false);
      return;
    }

    const { accepted, rejectedCount } = sanitiseFixes(
      batch.locations ?? [],
      now,
      current.lastAcceptedFix?.timestampMs ?? null,
    );
    diagnostics.record("location.batch", {
      accepted: accepted.length,
      rejected: rejectedCount,
      ...(batch.errorCode ? { errorCode: batch.errorCode.slice(0, 64) } : {}),
    });
    // A wake-up that carried no usable position is not always nothing to do. A
    // transit rider underground produces no fix for twenty minutes, and the
    // engine still has to update freshness without inferring movement. Ground has no such tick, so
    // an empty batch there really is nothing.
    if (accepted.length === 0 && !processor.needsScheduleTicks) return;

    const mutation = (processor as AnyNavigationProcessor).processFixes(
      current as never,
      accepted,
      now,
    );
    const committed = await this.commit(current, mutation, now);
    if (committed.ok) {
      await this.deps.effects.run(committed.effects);
      return;
    }
    if (committed.code === "revision-conflict" && mayRetry) {
      await this.processBatch(batch, false);
    }
  }

  // Connectivity.

  /**
   * Applies the confirmed connectivity to the active session. Called when the
   * confirmed state changes; a location batch applies it too.
   */
  connectivityChanged(): Promise<void> {
    return this.queue.run(async () => {
      try {
        const now = this.deps.clock();
        const session = await this.deps.repository.loadActive(now);
        if (session) await this.applyConnectivity(session, now);
      } catch {
        this.deps.diagnostics.record("typed.error", { scope: "connectivity" });
      }
    });
  }

  /**
   * Commits a confirmed connectivity change and returns the session to continue
   * from, or null when the commit lost a race and the caller should reload.
   *
   * Offline holds back reroutes and itinerary refreshes, so a rider underground
   * does not spend the refresh token on requests that cannot arrive. Coming back
   * online lets the processor retry what the outage held back. An `unknown`
   * reading is no evidence either way and leaves the committed state alone.
   */
  private async applyConnectivity(
    session: MobileNavigationSession,
    now: number,
  ): Promise<MobileNavigationSession | null> {
    const confirmed = this.deps.connectivity?.confirmed();
    if (
      !confirmed ||
      confirmed === "unknown" ||
      confirmed === session.connectivity ||
      session.status !== "active"
    )
      return session;
    const processor = this.deps.processors.get(session.kind);
    if (!processor) return session;
    this.deps.diagnostics.record("network.transition", {
      from: session.connectivity,
      to: confirmed,
      confirmed: true,
    });
    const marked = { ...session, connectivity: confirmed } as MobileNavigationSession;
    const restored =
      confirmed === "online"
        ? await (processor as AnyNavigationProcessor).onConnectivityRestored(marked as never, now)
        : null;
    const mutation: ProcessorMutation = restored ?? {
      session: { ...marked, revision: session.revision + 1, updatedAtMs: now },
    };
    const committed = await this.commit(
      session,
      {
        ...mutation,
        // Rare, and shown on the page, so the page hears it at once.
        effects: [...(mutation.effects ?? []), { kind: "publish-snapshot", immediate: true }],
      },
      now,
    );
    if (!committed.ok) return null;
    await this.deps.effects.run(committed.effects);
    return committed.session;
  }

  // Answers from remote work.

  /**
   * Applies a reroute answer.
   *
   * The request ran outside the queue, so by now the session may have moved on:
   * fixes advanced the revision, the user stopped, or a newer reroute replaced
   * this one. Only an answer to the session's current request is committed; a
   * stale one is dropped. Fixes that arrived while it was in flight do not make
   * it stale, because the new route starts from where the user actually is.
   */
  async applyReroute(outcome: RerouteOutcome): Promise<void> {
    await this.queue.run(async () => {
      try {
        await this.commitReroute(outcome);
      } catch {
        this.deps.diagnostics.record("typed.error", { scope: "reroute" });
      }
    });
  }

  private async commitReroute(outcome: RerouteOutcome): Promise<void> {
    const { repository, processors, clock } = this.deps;
    const now = clock();
    const session = await repository.loadActive(now);
    if (session?.kind !== "ground" || session.status !== "active") return;
    if (session.sessionId !== outcome.sessionId) return;
    const reroute = session.payload.reroute;
    if (reroute.requestId !== outcome.requestId) return;
    // Aborted means this side gave the request up, for a newer one or a stop.
    if (!outcome.ok && outcome.code === "aborted") return;

    let mutation: ProcessorMutation | null = null;
    if (outcome.ok) {
      const processor = processors.get("ground");
      const replaced = processor?.replace(session as never, outcome.route, now);
      if (replaced && !("ok" in replaced && replaced.ok === false)) {
        const applied = replaced as ProcessorMutation;
        const next = applied.session;
        mutation =
          next.kind === "ground"
            ? {
                ...applied,
                session: {
                  ...next,
                  payload: { ...next.payload, reroute: onRerouteSucceeded() },
                },
              }
            : applied;
      }
    }
    if (!mutation) {
      const code = outcome.ok ? "invalid-response" : outcome.code;
      mutation = {
        session: {
          ...session,
          revision: session.revision + 1,
          updatedAtMs: now,
          payload: {
            ...session.payload,
            reroute: onRerouteFailed(reroute as RerouteRuntime, code, now, Math.random()),
          },
        },
        effects: [{ kind: "publish-snapshot", immediate: false }],
      };
    }

    const committed = await this.commit(session, mutation, now);
    if (committed.ok) await this.deps.effects.run(committed.effects);
  }

  async applyTransitRefresh(outcome: RefreshOutcome): Promise<void> {
    await this.queue.run(async () => {
      const now = this.deps.clock();
      const session = await this.deps.repository.loadActive(now);
      if (
        session?.kind !== "transit" ||
        session.status !== "active" ||
        session.sessionId !== outcome.sessionId
      )
        return;
      const refresh = session.payload.refresh;
      if (
        refresh.status !== "in-flight" ||
        refresh.generation !== outcome.generation ||
        refresh.requestId !== outcome.requestId
      )
        return;
      const parsed = outcome.ok
        ? transitStartPackageSchema.safeParse({
            ...session.payload.startPackage,
            itinerary: outcome.itinerary,
          })
        : null;
      const merged = parsed?.success
        ? mergeTransitRefresh(
            session.payload.startPackage.itinerary as never,
            parsed.data.itinerary as never,
            session.payload.tickState.currentLegIndex,
            session.payload.tickState.walkRevision ?? 0,
          )
        : null;
      const same = !!merged;
      if (merged && parsed?.success) parsed.data.itinerary = merged.itinerary as never;
      const payload =
        same && parsed?.success
          ? {
              ...session.payload,
              startPackage: parsed.data,
              navigationDataRevision: (session.payload.navigationDataRevision ?? 0) + 1,
              refreshToken:
                outcome.ok && outcome.capturesOnly
                  ? session.payload.refreshToken
                  : typeof parsed.data.itinerary.refreshToken === "string"
                    ? parsed.data.itinerary.refreshToken
                    : null,
              refresh: onRefreshSucceeded(refresh, now),
            }
          : {
              ...session.payload,
              refresh: onRefreshFailed(
                refresh,
                outcome.ok
                  ? "rejected"
                  : outcome.failure === "unreachable"
                    ? "retryable"
                    : outcome.failure,
                now,
                !!session.payload.refreshToken,
              ),
            };
      // A terminal itinerary chain must not prevent the same owner polling journey evidence.
      if (payload.refresh.status === "broken") payload.refreshToken = null;
      if (same && outcome.ok) {
        const captured = {
          ...payload.startPackage,
          captures: refreshTransitCaptures(
            session.payload.startPackage.captures,
            (
              session.payload.startPackage.itinerary as unknown as {
                legs: import("@openmapx/core/navigation/api").BuildTransitPackageInput["itinerary"]["legs"];
              }
            ).legs,
            outcome.journeys as never,
            now,
          ),
        };
        const checkedCapture = transitStartPackageSchema.safeParse(captured);
        if (checkedCapture.success) payload.startPackage = checkedCapture.data;
      }
      if (merged?.resetWalk) {
        payload.tickState = {
          ...payload.tickState,
          currentWalkStepIndex: 0,
          reachedStepEnd: false,
          distanceToNextStepMeters: undefined,
          walkRevision: (payload.tickState.walkRevision ?? 0) + 1,
        };
        payload.progress = transitProgressFromTick(
          {
            ...payload.tickState,
            ...(session.lastAcceptedFix ? { lastAcceptedFix: session.lastAcceptedFix } : {}),
          },
          prepareTransitProgress(merged.itinerary),
        ) as unknown as Record<string, unknown>;
      }
      const committed = await this.commit(
        session,
        {
          session: { ...session, revision: session.revision + 1, updatedAtMs: now, payload },
          effects: [
            { kind: "reconcile-alerts", sessionId: session.sessionId },
            { kind: "publish-snapshot", immediate: true },
          ],
        },
        now,
      );
      if (committed.ok) await this.deps.effects.run(committed.effects);
    });
  }

  // Location cadence when the app comes back.

  /**
   * Puts a running stream on the cadence the committed session wants now.
   *
   * On Android a cadence change cannot restart the stream while the app is in
   * the background, so a change asked for then is not applied, and the runtime
   * that asked may be gone by the time the app is opened. Called when the app
   * becomes active, this derives the cadence again from the session, which is
   * the only thing that survives.
   */
  refreshLocationProfile(): Promise<void> {
    return this.queue.run(async () => {
      try {
        const now = this.deps.clock();
        const session = await this.deps.repository.loadActive(now);
        if (session?.status !== "active") return;
        if (!(await this.deps.driver.isRunning())) return;
        await this.deps.effects.run([
          { kind: "update-location-profile", profile: profileForSession(session, now) },
        ]);
      } catch {
        this.deps.diagnostics.record("typed.error", { scope: "location-profile" });
      }
    });
  }

  // Releasing location after a transit arrival.

  /**
   * Arranges for the location stream to stop when an arrived session's release
   * window closes. The timer is the prompt path where JavaScript timers run: in
   * the foreground, and on iOS while background location keeps the app running.
   * Android pauses a backgrounded app's JavaScript timers even under a
   * foreground service, so there the release comes from the next batch, which
   * Android's profiles guarantee by requesting updates on time with no distance
   * filter. A process that dies first is covered the same way, or by recovery
   * when the app opens.
   */
  private scheduleLocationRelease(session: MobileNavigationSession, now: number): void {
    const releaseAt = locationReleaseAtMs(session);
    // An undo made the trip active again, so a pending release has nothing to do.
    if (releaseAt === null && session.status === "active") {
      this.cancelLocationRelease?.();
      this.cancelLocationRelease = null;
    }
    if (releaseAt === null || releaseAt <= now) return;
    this.cancelLocationRelease?.();
    const schedule = this.deps.schedule ?? scheduleWithTimer;
    this.cancelLocationRelease = schedule(() => {
      this.cancelLocationRelease = null;
      void this.releaseLocationIfDue(session.sessionId);
    }, releaseAt - now);
  }

  /**
   * Stops the stream for this arrived session if its window has closed. An undo
   * since then made it active again, and an end or a new trip made it a
   * different row; both leave the stream to whoever owns it now.
   */
  private releaseLocationIfDue(sessionId: string): Promise<void> {
    return this.queue.run(async () => {
      try {
        const now = this.deps.clock();
        const session = await this.deps.repository.loadActive(now);
        if (session?.sessionId !== sessionId) return;
        const releaseAt = locationReleaseAtMs(session);
        if (releaseAt === null) return;
        if (releaseAt > now) {
          this.scheduleLocationRelease(session, now);
          return;
        }
        await this.deps.effects.run([{ kind: "stop-location" }, { kind: "reconcile-surface" }]);
      } catch {
        this.deps.diagnostics.record("typed.error", { scope: "location-release" });
      }
    });
  }

  // Internals.

  private async commit(
    current: MobileNavigationSession,
    mutation: ProcessorMutation,
    now: number,
  ): Promise<CommitResult> {
    const committed = await this.deps.repository.compareAndSwap(
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
    if (committed.ok) this.scheduleLocationRelease(committed.session, now);
    return committed;
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
