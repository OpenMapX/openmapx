import type { MobileNavigationSession } from "@openmapx/core/navigation";
import type { LocationPermissionState } from "../location/LocationDriver";
import type { LocationProfileKind } from "../location/profiles";
import { locationProfileForMode } from "../navigation/ground/groundSession";
import type { SerialExecutor } from "../navigation/serialExecutor";
import { transitProfileForTime } from "../navigation/transit/transitSession";
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
  terminate(sessionId: string, nowMs: number): Promise<boolean>;
}

export interface RecoveryDriver {
  permission(): Promise<LocationPermissionState>;
  running(): Promise<boolean>;
  start(profile: LocationProfileKind): Promise<void>;
  stop(): Promise<void>;
}

export interface NavigationRecoveryDeps {
  store: RecoverySessionStore;
  driver: RecoveryDriver;
  stopAudio(): Promise<void>;
  clearAlerts(): Promise<void>;
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
 * or terminate it and release device resources. Keeping that boundary narrow
 * lets recovery be truthful without advertising native navigation to the web
 * application prematurely.
 */
export class NavigationRecoveryController {
  constructor(private readonly deps: NavigationRecoveryDeps) {}

  reconcile(visibility: AppVisibility): Promise<RecoveryEvent> {
    return this.deps.executor.run(() => this.reconcileNow(visibility));
  }

  resume(): Promise<RecoveryEvent> {
    return this.deps.executor.run<RecoveryEvent>(async () => {
      const inspected = await this.deps.store.inspect(this.deps.now());
      if (inspected.kind !== "active" || inspected.session.status !== "active") {
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
      return "session-started";
    });
  }

  end(): Promise<RecoveryEvent> {
    return this.deps.executor.run<RecoveryEvent>(async () => {
      const inspected = await this.deps.store.inspect(this.deps.now());
      if (inspected.kind === "active") {
        await this.deps.store.terminate(inspected.session.sessionId, this.deps.now());
      }
      await this.cleanupDeviceWork();
      return "session-ended" as const;
    });
  }

  private async reconcileNow(visibility: AppVisibility): Promise<RecoveryEvent> {
    const now = this.deps.now();
    const inspected = await this.deps.store.inspect(now);
    if (inspected.kind !== "active") {
      await this.cleanupDeviceWork();
      return inspected.kind === "quarantined" ? "session-quarantined" : "session-ended";
    }

    const { session } = inspected;
    if (session.status !== "active" || session.expiresAtMs <= now) {
      await this.deps.store.terminate(session.sessionId, now);
      await this.cleanupDeviceWork();
      return "session-ended";
    }

    const permission = await this.deps.driver.permission();
    if (!permissionAllows(session, permission)) {
      await this.cleanupDeviceWork();
      return "permission-lost";
    }

    const running = await this.deps.driver.running();
    if (session.permissionMode === "foreground-only" && visibility !== "active") {
      if (running) await this.deps.driver.stop();
      return "resume-required";
    }
    return running ? "session-started" : "resume-required";
  }

  private async cleanupDeviceWork(): Promise<void> {
    // Every cleanup is idempotent and independently attempted. A broken audio
    // module must never prevent location from stopping, and vice versa.
    await Promise.allSettled([
      this.deps.driver.stop(),
      this.deps.stopAudio(),
      this.deps.clearAlerts(),
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

export function profileForSession(
  session: MobileNavigationSession,
  nowMs: number,
): LocationProfileKind {
  return session.kind === "ground"
    ? locationProfileForMode(session.payload.startPackage.mode)
    : transitProfileForTime(session, nowMs);
}
