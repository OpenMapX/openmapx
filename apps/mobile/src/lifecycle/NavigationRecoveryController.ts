import type { MobileNavigationSession } from "@openmapx/core/navigation";
import type { LocationPermissionState } from "../location/LocationDriver";
import type { LocationProfileKind } from "../location/profiles";
import type { SerialExecutor } from "../navigation/serialExecutor";
import { profileForSession } from "../navigation/sessionProfile";
import type { AppVisibility } from "./lifecyclePolicy";

export type RecoveryEvent =
  | "session-started"
  | "session-ended"
  | "session-quarantined"
  | "permission-lost"
  | "resume-required";

export type RecoveryInspection =
  | { kind: "none" }
  | { kind: "quarantined" }
  | { kind: "active"; session: MobileNavigationSession };

export interface RecoverySessionStore {
  inspect(nowMs: number): Promise<RecoveryInspection>;
}

/**
 * How recovery ends a session: through the coordinator's one terminal path,
 * so the page, the shell state and keep-awake hear about it like any other
 * end. Each call takes the coordinator's queue, so it is made between, never
 * inside, this controller's own steps on the shared executor.
 */
export interface RecoverySessions {
  /** Ends the session if it is finished; keeps an arrival for the page until it is completed or expires. */
  closeFinished(sessionId: string): Promise<"ended" | "kept" | "active" | "gone">;
  /** Ends the session the user chose to end. */
  stop(sessionId: string): Promise<boolean>;
}

export interface RecoveryDriver {
  permission(): Promise<LocationPermissionState>;
  running(): Promise<boolean>;
  start(profile: LocationProfileKind): Promise<void>;
  stop(): Promise<void>;
}

export interface NavigationRecoveryDeps {
  store: RecoverySessionStore;
  sessions: RecoverySessions;
  driver: RecoveryDriver;
  stopAudio(): Promise<void>;
  clearAlerts(): Promise<void>;
  clearSurface?(): Promise<void>;
  reconcileSurface?(): Promise<void>;
  isAppActive(): boolean;
  now(): number;
  executor: SerialExecutor;
}

/**
 * Owns the small recovery surface that must work before the full foreground
 * navigation graph is shippable.
 *
 * This controller cannot create or mutate a route. It can only reconcile an
 * already-active durable session, explicitly restart its one location stream,
 * ask the coordinator to end it, and release device resources nothing owns.
 * Keeping that boundary narrow lets recovery be truthful without advertising
 * native navigation to the web application prematurely.
 */
export class NavigationRecoveryController {
  constructor(private readonly deps: NavigationRecoveryDeps) {}

  async reconcile(visibility: AppVisibility): Promise<RecoveryEvent> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const step = await this.deps.executor.run(() => this.reconcileNow(visibility));
      if (typeof step === "string") return step;
      // Undone back to an active trip since it was read: look again, once.
      if ((await this.deps.sessions.closeFinished(step.close)) !== "active") break;
    }
    // Ended, kept as an arrival for the page, or already gone: guidance is over.
    return "session-ended";
  }

  resume(): Promise<RecoveryEvent> {
    return this.deps.executor.run<RecoveryEvent>(async () => {
      const inspected = await this.deps.store.inspect(this.deps.now());
      // An arrival owns its location until its release window closes.
      if (inspected.kind === "active" && inspected.session.status !== "active") {
        return "session-ended";
      }
      if (inspected.kind !== "active") {
        await this.cleanupDeviceWork();
        return inspected.kind === "quarantined" ? "session-quarantined" : "session-ended";
      }
      if (!this.deps.isAppActive()) return "resume-required";

      const permission = await this.deps.driver.permission();
      if (!permissionAllows(inspected.session, permission)) {
        await this.cleanupDeviceWork();
        return "permission-lost";
      }

      await this.deps.driver.start(profileForSession(inspected.session, this.deps.now()));
      await this.deps.reconcileSurface?.().catch(() => undefined);
      return "session-started";
    });
  }

  async end(): Promise<RecoveryEvent> {
    const inspected = await this.deps.executor.run(() => this.deps.store.inspect(this.deps.now()));
    if (inspected.kind === "active") await this.deps.sessions.stop(inspected.session.sessionId);
    await this.deps.executor.run(async () => {
      // Whatever is still running belongs to no session now.
      if ((await this.deps.store.inspect(this.deps.now())).kind !== "active") {
        await this.cleanupDeviceWork();
      }
    });
    return "session-ended";
  }

  /** One step on the executor: an outcome, or a session the coordinator has to close. */
  private async reconcileNow(
    visibility: AppVisibility,
  ): Promise<RecoveryEvent | { close: string }> {
    const now = this.deps.now();
    const inspected = await this.deps.store.inspect(now);
    if (inspected.kind !== "active") {
      await this.cleanupDeviceWork();
      return inspected.kind === "quarantined" ? "session-quarantined" : "session-ended";
    }

    const { session } = inspected;
    if (session.status !== "active" || session.expiresAtMs <= now) {
      return { close: session.sessionId };
    }

    const permission = await this.deps.driver.permission();
    if (!permissionAllows(session, permission)) {
      await this.cleanupDeviceWork();
      return "permission-lost";
    }

    const running = await this.deps.driver.running();
    if (session.permissionMode === "foreground-only" && visibility !== "active") {
      if (running) await this.deps.driver.stop();
      await this.deps.clearSurface?.().catch(() => undefined);
      return "resume-required";
    }
    if (running) await this.deps.reconcileSurface?.().catch(() => undefined);
    else await this.deps.clearSurface?.().catch(() => undefined);
    return running ? "session-started" : "resume-required";
  }

  private async cleanupDeviceWork(): Promise<void> {
    // Every cleanup is idempotent and independently attempted. A broken audio
    // module must never prevent location from stopping, and vice versa.
    await Promise.allSettled([
      this.deps.driver.stop(),
      this.deps.stopAudio(),
      this.deps.clearAlerts(),
      this.deps.clearSurface?.(),
    ]);
  }
}

function permissionAllows(
  session: MobileNavigationSession,
  permission: LocationPermissionState,
): boolean {
  if (session.permissionMode === "background") return permission === "background";
  return permission === "foreground" || permission === "background";
}
