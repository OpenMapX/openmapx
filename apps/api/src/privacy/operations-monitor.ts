import { and, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import {
  dataExportArtifact,
  dataSubjectRequest,
  dataSubjectRequestAttachment,
  dataSubjectRequestEvent,
  dataSubjectRequestNotification,
  dataSubjectRequestSourceSnapshot,
  dataSubjectRequestTask,
} from "../db/schema.js";
import { getMetrics, type PrivacyOperationalMetricSnapshot } from "../services/metrics/index.js";
import type { MasterKeyRingMetadata } from "./crypto.js";

const TASK_STATUSES = [
  "pending",
  "running",
  "complete",
  "not_applicable",
  "retryable",
  "operator_review",
  "canceled",
] as const;
const DUE_SOON_MS = 72 * 60 * 60 * 1_000;
const MAX_ROWS = 50_000;

export interface PrivacyOperationsHealth {
  monitorHealthy: boolean;
  cleanupHealthy: boolean;
  notificationHealthy: boolean;
  keyReady: boolean;
  keyRing?: MasterKeyRingMetadata | null;
  storageHealthy: boolean;
  backupCapability: boolean;
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
  keyReady: PrivacyOperationalProbe;
  /** Metadata for the exact ring loaded by the running process. */
  keyRing?: MasterKeyRingMetadata | null;
  storageHealthy?: PrivacyOperationalProbe;
  backupCapability?: PrivacyOperationalProbe;
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

/** Record one generation failure without putting request/user identifiers in
 * the event payload or in telemetry labels. */
export async function recordPrivacyGenerationFailure(input: {
  requestId: string;
  reasonCode: string;
  database?: typeof defaultDb;
  now?: Date;
}): Promise<void> {
  const database = input.database ?? defaultDb;
  const reasonCode = /^[a-z0-9][a-z0-9._-]{0,127}$/.test(input.reasonCode)
    ? input.reasonCode
    : "generation-failed";
  await database.insert(dataSubjectRequestEvent).values({
    requestId: input.requestId,
    eventType: "generation_failed",
    actorKind: "system",
    actorId: "privacy-generator",
    payloadVersion: 1,
    payload: { reasonCode },
    createdAt: input.now ?? new Date(),
  });
}

async function collectSnapshot(
  options: PrivacyOperationsMonitorOptions,
  keyReady: boolean,
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
    .where(
      sql`${dataSubjectRequest.state} not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired')`,
    )
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
    TASK_STATUSES.map((status) => [status, 0]),
  );
  for (const row of taskRows)
    sourceTasksByStatus[row.status] = (sourceTasksByStatus[row.status] ?? 0) + 1;

  const failureRows = await database
    .select({ id: dataSubjectRequestEvent.id })
    .from(dataSubjectRequestEvent)
    .where(
      and(
        eq(dataSubjectRequestEvent.eventType, "generation_failed"),
        gte(dataSubjectRequestEvent.createdAt, new Date(now.getTime() - 24 * 60 * 60 * 1_000)),
      ),
    )
    .limit(MAX_ROWS);
  const artifactRows = await database
    .select({ createdAt: dataExportArtifact.createdAt, revokedAt: dataExportArtifact.revokedAt })
    .from(dataExportArtifact)
    .where(
      and(
        sql`${dataExportArtifact.state} in ('expired', 'failed', 'revoked')`,
        isNull(dataExportArtifact.deletedAt),
      ),
    )
    .limit(MAX_ROWS);
  let artifactCleanupLagSeconds = 0;
  for (const row of artifactRows)
    artifactCleanupLagSeconds = Math.max(
      artifactCleanupLagSeconds,
      Math.max(0, (now.getTime() - (row.revokedAt?.getTime() ?? row.createdAt.getTime())) / 1_000),
    );
  const sourceSnapshotRows = await database
    .select({ id: dataSubjectRequestSourceSnapshot.id })
    .from(dataSubjectRequestSourceSnapshot)
    .where(
      and(
        inArray(dataSubjectRequestSourceSnapshot.state, ["captured", "delete_failed"]),
        or(
          lte(dataSubjectRequestSourceSnapshot.expiresAt, now),
          sql`exists (
            select 1 from data_subject_request source_request
            where source_request.id = ${dataSubjectRequestSourceSnapshot.requestId}
              and source_request.state in ('delivered', 'artifact_expired', 'withdrawn', 'refused', 'closed')
          )`,
        ),
      ),
    )
    .limit(MAX_ROWS);
  const attachmentRows = await database
    .select({ id: dataSubjectRequestAttachment.id })
    .from(dataSubjectRequestAttachment)
    .where(
      and(
        isNull(dataSubjectRequestAttachment.deletedAt),
        lte(dataSubjectRequestAttachment.expiresAt, now),
      ),
    )
    .limit(MAX_ROWS);

  const backupReviewRows = await database
    .select({ status: dataSubjectRequestTask.status })
    .from(dataSubjectRequestTask)
    .where(
      and(
        eq(dataSubjectRequestTask.registrationId, "backup-retained-copies"),
        sql`${dataSubjectRequestTask.status} in ('pending', 'running', 'retryable', 'operator_review')`,
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
    generationFailures: failureRows.length,
    artifactCleanupLagSeconds,
    artifactCleanupBacklog: artifactRows.length,
    attachmentCleanupBacklog: attachmentRows.length,
    sourceSnapshotCleanupBacklog: sourceSnapshotRows.length,
    keyReady,
    backupReviewBacklog: backupReviewRows.length,
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
    keyReady: false,
    storageHealthy: false,
    backupCapability: false,
    cleanupHealthy: false,
    notificationHealthy: false,
  };
  const runOnce = async (): Promise<PrivacyOperationsSnapshot> => {
    if (running) throw new Error("privacy monitor already running");
    running = true;
    try {
      const now = (options.now ?? (() => new Date()))();
      dependencyHealth = {
        keyReady: await probe(options.keyReady, now, probeFreshnessMs),
        storageHealthy: await probe(options.storageHealthy, now, probeFreshnessMs),
        backupCapability: await probe(options.backupCapability, now, probeFreshnessMs),
        cleanupHealthy: await probe(options.cleanupHealthy, now, probeFreshnessMs),
        notificationHealthy: await probe(options.notificationHealthy, now, probeFreshnessMs),
      };
      const snapshot = await collectSnapshot(options, dependencyHealth.keyReady);
      if (
        snapshot.artifactCleanupBacklog > 0 ||
        snapshot.attachmentCleanupBacklog > 0 ||
        snapshot.sourceSnapshotCleanupBacklog > 0
      )
        dependencyHealth.cleanupHealthy = false;
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
        keyReady: dependencyHealth.keyReady,
        keyRing: options.keyRing
          ? {
              activeVersion: options.keyRing.activeVersion,
              availableVersions: [...options.keyRing.availableVersions],
            }
          : null,
        storageHealthy: dependencyHealth.storageHealthy,
        backupCapability: dependencyHealth.backupCapability,
        lastRunAt,
        lastErrorCode,
      };
    },
  };
}

export function privacyOperationsHealthFromEnvironment(): Pick<
  PrivacyOperationsHealth,
  "backupCapability"
> {
  return {
    backupCapability:
      process.env.OPS_PRIVACY_BACKUP_COLLECTOR_ENABLED === "true" &&
      Boolean(process.env.OPS_PRIVACY_BACKUP_CAPABILITY_KEY_FILE),
  };
}
