import type { db as defaultDb } from "../db/index.js";
import { dataSubjectRequestApproval } from "../db/schema.js";
import { catalogueAvailability } from "./catalogue.js";
import type { PrivacyOperationsHealth } from "./operations-monitor.js";
import {
  evaluateGdprExportReadiness,
  type GdprExportReadiness,
  type ReadinessApproval,
  type ReadinessImplementationCapabilities,
  type ReadinessReleaseContractChecks,
} from "./readiness.js";
import type { PrivacyReleaseEvidence } from "./release-evidence.js";

export interface RuntimeGdprReadinessInput {
  database: typeof defaultDb;
  evidence: PrivacyReleaseEvidence;
  implementationActorIds: readonly string[];
  capabilities: ReadinessImplementationCapabilities;
  health: PrivacyOperationsHealth;
  artifactStorageBackupDisabled: boolean;
  managedDawarichConfigured: boolean;
  managedDawarichAvailable: boolean;
  contractChecks: ReadinessReleaseContractChecks;
  now?: Date;
}

/** The single production composition used by both the status route and every
 * archive-generation boundary. It reads immutable approvals each time, so a
 * new rejection or evidence fingerprint change closes generation immediately. */
export async function loadRuntimeGdprExportReadiness(
  input: RuntimeGdprReadinessInput,
): Promise<GdprExportReadiness> {
  const rows = await input.database.select().from(dataSubjectRequestApproval);
  const approvals: ReadinessApproval[] = rows
    .filter((row) => row.approverUserId !== null)
    .map((row) => ({
      scope: row.scope as ReadinessApproval["scope"],
      version: row.version,
      approverUserId: row.approverUserId ?? "",
      approverRole: row.approverRole as ReadinessApproval["approverRole"],
      decision: row.decision as ReadinessApproval["decision"],
      findingsDigest: row.findingsDigest,
      reviewedAt: row.reviewedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }));
  return evaluateGdprExportReadiness({
    evidenceVersion: input.evidence.version,
    implementationActorIds: input.implementationActorIds,
    ...input.capabilities,
    now: input.now,
    keyAvailable: input.health.keyReady,
    keyRing: input.health.keyRing ?? null,
    storageHealthy: input.health.storageHealthy,
    artifactStorageBackupDisabled: input.artifactStorageBackupDisabled,
    cleanupHealthy: input.health.cleanupHealthy,
    backupCapability: input.health.backupCapability,
    slaMonitorHealthy: input.health.monitorHealthy,
    notificationHealthy: input.health.notificationHealthy,
    controllerContactConfigured: input.evidence.controllerContactConfigured,
    ...input.contractChecks,
    catalogueAvailable: (registration) => {
      if (registration.strategy === "not_personal") return true;
      if (registration.strategy === "operator_task")
        return input.capabilities.operatorTaskWorkflowAvailable;
      if (catalogueAvailability(registration) !== "available") return false;
      return (
        registration.id !== "managed-dawarich" ||
        !input.managedDawarichConfigured ||
        input.managedDawarichAvailable
      );
    },
    approvals,
  });
}
