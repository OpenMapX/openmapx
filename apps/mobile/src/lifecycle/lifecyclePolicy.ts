import type { MobileNavigationSession } from "@openmapx/core/navigation";

/**
 * What the shell should do when the app's visibility changes, or when it starts
 * and finds a session already recorded.
 *
 * Pure, because every interesting case here is one that a device reproduces
 * only occasionally and a test reproduces every time: a process recreated under
 * memory pressure, a force-stop, a session left running overnight, a
 * foreground-only grant while the user switches apps.
 *
 * The rule that shapes all of it: **the shell never silently resumes tracking.**
 * Continuing something the operating system is already doing is fine; starting
 * it again after the system stopped it is a decision only the user can make.
 */

export type AppVisibility = "active" | "inactive" | "background";

export interface LifecycleInput {
  session: MobileNavigationSession | null;
  visibility: AppVisibility;
  /** Whether the operating system still has the location task registered. */
  driverRunning: boolean;
  nowMs: number;
}

export type LifecycleAction =
  /** The system is already tracking and should continue. */
  | { kind: "keep-tracking" }
  /** Foreground-only grant, app no longer visible: delivery stops now. */
  | { kind: "pause-foreground-only" }
  /** A foreground-only session became visible again. */
  | { kind: "offer-resume-foreground-only" }
  /** Past its 24-hour lifetime: end it and clear location-bearing data. */
  | { kind: "expire" }
  /** A recorded session whose driver is gone — most likely force-stop or reboot. */
  | { kind: "offer-resume" }
  /** Tracking with nothing to track: stop, rather than leave it running. */
  | { kind: "stop-orphan-driver" }
  /** Keep the screen on while a session is visible and the setting allows it. */
  | { kind: "keep-awake"; active: boolean };

export interface LifecyclePlan {
  actions: LifecycleAction[];
}

const LIVE_STATUSES = new Set(["preparing", "active"]);

function isLive(session: MobileNavigationSession): boolean {
  return LIVE_STATUSES.has(session.status);
}

export function decideLifecycle(input: LifecycleInput): LifecyclePlan {
  const { session, visibility, driverRunning, nowMs } = input;
  const visible = visibility === "active";

  if (!session || !isLive(session)) {
    // Nothing to track. A driver still running here is the dangerous case —
    // the user has no session on screen and no obvious way to stop it.
    const actions: LifecycleAction[] = [{ kind: "keep-awake", active: false }];
    if (driverRunning) actions.unshift({ kind: "stop-orphan-driver" });
    return { actions };
  }

  if (nowMs >= session.expiresAtMs) {
    return { actions: [{ kind: "expire" }, { kind: "keep-awake", active: false }] };
  }

  if (session.permissionMode === "foreground-only") {
    if (!visible) {
      // The user allowed location only while the app is open, so honouring that
      // means stopping delivery the moment it is not — not "soon", not on the
      // next callback.
      return {
        actions: [{ kind: "pause-foreground-only" }, { kind: "keep-awake", active: false }],
      };
    }
    return driverRunning
      ? { actions: [{ kind: "keep-tracking" }, { kind: "keep-awake", active: true }] }
      : {
          actions: [
            { kind: "offer-resume-foreground-only" },
            { kind: "keep-awake", active: false },
          ],
        };
  }

  if (driverRunning) {
    // The operating system is still delivering. The recorded session is the
    // authority for *what* is being navigated, and this is the authority for
    // whether it is running — so nothing needs restarting.
    return { actions: [{ kind: "keep-tracking" }, { kind: "keep-awake", active: visible }] };
  }

  // A live session with no driver behind it. The process was force-stopped, the
  // device rebooted, or the task was killed. Resuming without asking would start
  // tracking the user did not initiate in this session of the app.
  return { actions: [{ kind: "offer-resume" }, { kind: "keep-awake", active: false }] };
}

/** Convenience for callers that only need to know whether one action was planned. */
export function planIncludes(plan: LifecyclePlan, kind: LifecycleAction["kind"]): boolean {
  return plan.actions.some((action) => action.kind === kind);
}
