import type { NotificationCategory } from "./notificationIds";

/**
 * The local-notification boundary.
 *
 * Deliberately not a "post this text" method. The bridge can reach the
 * coordinator, and the coordinator reaches this — so an arbitrary-content
 * scheduler would let a same-origin script in the page post any notification it
 * liked under the app's name. Instead the operations are a closed set of
 * OpenMapX event categories, and the content is composed by trusted code from
 * the localised catalogs.
 *
 * Everything here is local. There is no push token, no remote credential, and no
 * path that could acquire one.
 */

export interface ScheduledNotification {
  id: string;
  category: NotificationCategory;
  triggerAtMs: number;
  title: string;
  body: string;
}

export interface NotificationScheduler {
  /** Ensures the Android channel exists. No-op elsewhere. */
  prepare(): Promise<void>;
  scheduleAlight(request: ScheduledNotification): Promise<void>;
  /** A notification that must interrupt Do Not Disturb, e.g. a missed connection. */
  scheduleCriticalInterruption(request: ScheduledNotification): Promise<void>;
  cancel(id: string): Promise<void>;
  cancelSession(ids: readonly string[]): Promise<void>;
  /** Identifiers the operating system currently holds, for reconciliation. */
  pending(): Promise<string[]>;
  /**
   * Makes the operating system's set match `records` exactly, and reports what
   * it had to change. Called on start-up and after every committed mutation.
   */
  reconcile(records: readonly ScheduledNotification[]): Promise<ReconcileResult>;
}

export interface ReconcileResult {
  scheduled: number;
  cancelled: number;
  /** Identifiers the shell no longer knows about; always removed. */
  orphans: number;
}

/**
 * Decides what has to change, without touching the operating system.
 *
 * Split out so the reconciliation rules — which are where duplicated and
 * orphaned notifications come from — can be tested without a device.
 */
export function planReconciliation(
  desired: readonly ScheduledNotification[],
  pending: readonly string[],
  isOurs: (id: string) => boolean,
): { toSchedule: ScheduledNotification[]; toCancel: string[]; orphans: string[] } {
  const pendingSet = new Set(pending);
  const desiredIds = new Set(desired.map((record) => record.id));

  const toSchedule = desired.filter((record) => !pendingSet.has(record.id));
  // Only OpenMapX identifiers are ever cancelled: another app's notification is
  // none of this app's business, even if it somehow appeared in the list.
  const ours = pending.filter(isOurs);
  const toCancel = ours.filter((id) => !desiredIds.has(id));

  return { toSchedule, toCancel, orphans: toCancel };
}
