import type { MobileNavigationSession } from "@openmapx/core/navigation";
import type { NotificationScheduler } from "../../notifications/NotificationScheduler";
import type { SessionRepository } from "../../storage/SessionRepository";
import type { AlertPort } from "../effects";
import { type AlightAlertCopy, alertHasChanged, computeAlightAlert } from "./AlightAlertPolicy";

/**
 * Keeping the operating system's scheduled alerts in step with the session.
 *
 * Reconciliation is a three-way comparison — what the session says should be
 * scheduled, what the repository recorded, and what the operating system
 * actually still holds — because those three drift apart for different reasons.
 * The session changes as the rider travels. The repository survives a crash. The
 * operating system forgets on reinstall and keeps things across a force-stop.
 *
 * Rescheduling only when something meaningfully changed matters more than it
 * looks: a cancel-and-re-add on every tick is churn that platforms rate-limit,
 * and it opens a window where no alert is scheduled at all.
 */

export interface AlertPortDeps {
  repository: SessionRepository;
  scheduler: NotificationScheduler;
  copy: AlightAlertCopy;
  now: () => number;
  /** False when the rider declined the notification permission. */
  isAvailable: () => boolean;
}

export function createAlertPort(deps: AlertPortDeps): AlertPort {
  return {
    reconcile: async (sessionId) => {
      const session = await deps.repository.loadActive(deps.now());
      if (!session || session.sessionId !== sessionId) return;
      if (session.kind !== "transit") return;
      if (!deps.isAvailable()) return;

      const desired = computeAlightAlert(session, deps.now(), deps.copy);
      const recorded = await deps.repository.listScheduledAlerts(sessionId);
      const current = recorded.find((entry) => entry.state === "scheduled");

      if (!alertHasChanged(current, desired)) {
        // Even when nothing changed, the operating system may have lost the
        // request across a reinstall, so the scheduler still reconciles.
        await deps.scheduler.reconcile(desired ? [desired] : []);
        return;
      }

      await deps.repository.replaceScheduledAlerts(
        sessionId,
        desired
          ? [{ alertId: desired.id, legIndex: desired.legIndex, triggerAtMs: desired.triggerAtMs }]
          : [],
        deps.now(),
      );
      await deps.scheduler.reconcile(desired ? [desired] : []);
    },

    cancelSession: async (sessionId) => {
      const recorded = await deps.repository.listScheduledAlerts(sessionId);
      // Cancelled at the operating system first, then forgotten. The other order
      // would leave an alert nothing knows how to cancel if this crashed between
      // the two.
      await deps.scheduler.cancelSession(recorded.map((entry) => entry.alertId));
      await deps.repository.replaceScheduledAlerts(sessionId, [], deps.now());
    },
  };
}

/**
 * Removes alerts belonging to sessions that no longer exist.
 *
 * Runs at start-up. A force-stop can leave the operating system holding a
 * request for a trip that ended, and without this it would fire hours later
 * telling the rider to get off a train they are not on.
 */
export async function cancelOrphanedAlerts(deps: {
  repository: SessionRepository;
  scheduler: NotificationScheduler;
  now: () => number;
}): Promise<number> {
  const active: MobileNavigationSession | null = await deps.repository.loadActive(deps.now());
  const known = active ? await deps.repository.listScheduledAlerts(active.sessionId) : [];
  const keep = new Set(known.map((entry) => entry.alertId));

  const pending = await deps.scheduler.pending();
  const orphans = pending.filter((id) => !keep.has(id));
  if (orphans.length > 0) await deps.scheduler.cancelSession(orphans);
  return orphans.length;
}
