import { ACTIVE_REQUEST_STATES } from "@openmapx/core/privacy";
import { and, eq, gte, inArray } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { TASK_STATES } from "../db/privacy-schema.js";
import {
  dataSubjectRequest,
  dataSubjectRequestEvent,
  dataSubjectRequestNotification,
  dataSubjectRequestTask,
} from "../db/schema.js";
import { getMetrics, type PrivacyOperationalMetricSnapshot } from "../services/metrics/index.js";

const DUE_SOON_MS = 72 * 60 * 60 * 1_000;
const MAX_ROWS = 50_000;

export interface PrivacyOperationsHealth {
  monitorHealthy: boolean;
  cleanupHealthy: boolean;
  notificationHealthy: boolean;
  lastRunAt: string | null;
  lastErrorCode: string | null;
}

export interface PrivacyOperationalProbeEvidence {
  healthy: boolean;
  checkedAt: string;
}

type PrivacyOperationalProbe =
  | boolean
  | PrivacyOperationalProbeEvidence
  | (() =>
      | boolean
      | PrivacyOperationalProbeEvidence
      | Promise<boolean | PrivacyOperationalProbeEvidence>);

export interface PrivacyOperationsMonitorOptions {
  database?: typeof defaultDb;
  now?: () => Date;
  cleanupHealthy?: PrivacyOperationalProbe;
  notificationHealthy?: PrivacyOperationalProbe;
  intervalMs?: number;
  probeFreshnessMs?: number;
}

export interface PrivacyOperationsSnapshot extends PrivacyOperationalMetricSnapshot {
  capturedAt: string;
}

export function operationalProbeHealthy(
  value: boolean | PrivacyOperationalProbeEvidence,
  now: Date,
  freshnessMs: number,
): boolean {
  if (typeof value === "boolean") return value;
  const checkedAt = Date.parse(value.checkedAt);
  const age = now.getTime() - checkedAt;
  return value.healthy && Number.isFinite(checkedAt) && age >= 0 && age <= freshnessMs;
}

async function probe(
  value: PrivacyOperationalProbe | undefined,
  now: Date,
  freshnessMs: number,
): Promise<boolean> {
  if (value === undefined) return false;
  const result = typeof value === "function" ? await value() : value;
  return operationalProbeHealthy(result, now, freshnessMs);
}

function safeCode(error: unknown): string {
  const raw = error instanceof Error ? error.name : "monitor_failed";
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .slice(0, 96);
  return normalized || "monitor_failed";
}

async function collectSnapshot(
  options: PrivacyOperationsMonitorOptions,
): Promise<PrivacyOperationsSnapshot> {
  const database = options.database ?? defaultDb;
  const now = (options.now ?? (() => new Date()))();
  const requestRows = await database
    .select({
      state: dataSubjectRequest.state,
      dueAt: dataSubjectRequest.dueAt,
      receivedAt: dataSubjectRequest.receivedAt,
    })
    .from(dataSubjectRequest)
    .where(inArray(dataSubjectRequest.state, [...ACTIVE_REQUEST_STATES]))
    .limit(MAX_ROWS);
  const openRequestsByDueState = { on_track: 0, due_soon: 0, overdue: 0 };
  let oldestRequestAgeSeconds = 0;
  for (const row of requestRows) {
    const due = row.dueAt.getTime();
    const received = row.receivedAt.getTime();
    oldestRequestAgeSeconds = Math.max(
      oldestRequestAgeSeconds,
      Math.max(0, (now.getTime() - received) / 1_000),
    );
    if (due <= now.getTime()) openRequestsByDueState.overdue += 1;
    else if (due <= now.getTime() + DUE_SOON_MS) openRequestsByDueState.due_soon += 1;
    else openRequestsByDueState.on_track += 1;
  }
  const taskRows = await database
    .select({ status: dataSubjectRequestTask.status })
    .from(dataSubjectRequestTask)
    .limit(MAX_ROWS);
  const sourceTasksByStatus: Record<string, number> = Object.fromEntries(
    TASK_STATES.map((status) => [status, 0]),
  );
  for (const row of taskRows)
    sourceTasksByStatus[row.status] = (sourceTasksByStatus[row.status] ?? 0) + 1;

  const failureRows = await database
    .select({ id: dataSubjectRequestEvent.id })
    .from(dataSubjectRequestEvent)
    .where(
      and(
        eq(dataSubjectRequestEvent.eventType, "export_failed"),
        gte(dataSubjectRequestEvent.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1_000)),
      ),
    )
    .limit(MAX_ROWS);
  const notificationRows = await database
    .select({ id: dataSubjectRequestNotification.id })
    .from(dataSubjectRequestNotification)
    .where(eq(dataSubjectRequestNotification.state, "failed"))
    .limit(MAX_ROWS);
  const snapshot: PrivacyOperationsSnapshot = {
    capturedAt: now.toISOString(),
    openRequestsByDueState,
    oldestRequestAgeSeconds,
    sourceTasksByStatus,
    exportFailures: failureRows.length,
    notificationFailures: notificationRows.length,
  };
  getMetrics().recordPrivacyOperationalSnapshot(snapshot);
  return snapshot;
}

export function createPrivacyOperationsMonitor(options: PrivacyOperationsMonitorOptions): {
  runOnce(): Promise<PrivacyOperationsSnapshot>;
  start(): void;
  stop(): void;
  health(): PrivacyOperationsHealth;
} {
  const intervalMs = options.intervalMs ?? 60_000;
  const probeFreshnessMs = options.probeFreshnessMs ?? Math.max(intervalMs * 3, 60_000);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000)
    throw new Error("invalid privacy monitor interval");
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let lastRunAt: string | null = null;
  let lastErrorCode: string | null = null;
  let dependencyHealth = {
    cleanupHealthy: false,
    notificationHealthy: false,
  };
  const runOnce = async (): Promise<PrivacyOperationsSnapshot> => {
    if (running) throw new Error("privacy monitor already running");
    running = true;
    try {
      const now = (options.now ?? (() => new Date()))();
      dependencyHealth = {
        cleanupHealthy: await probe(options.cleanupHealthy, now, probeFreshnessMs),
        notificationHealthy: await probe(options.notificationHealthy, now, probeFreshnessMs),
      };
      const snapshot = await collectSnapshot(options);
      lastRunAt = snapshot.capturedAt;
      lastErrorCode = null;
      return snapshot;
    } catch (error) {
      lastErrorCode = safeCode(error);
      throw error;
    } finally {
      running = false;
    }
  };
  return {
    runOnce,
    start() {
      if (timer) return;
      void runOnce().catch(() => undefined);
      timer = setInterval(() => {
        void runOnce().catch(() => undefined);
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    health() {
      const now = Date.now();
      const monitorFresh = !!lastRunAt && now - Date.parse(lastRunAt) <= intervalMs * 3;
      return {
        monitorHealthy: monitorFresh && !lastErrorCode,
        cleanupHealthy: dependencyHealth.cleanupHealthy,
        notificationHealthy: dependencyHealth.notificationHealthy,
        lastRunAt,
        lastErrorCode,
      };
    },
  };
}
