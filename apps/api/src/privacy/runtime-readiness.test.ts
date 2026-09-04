import { describe, expect, it } from "vitest";
import { createDbMock } from "../test/db.js";
import { loadRuntimeGdprExportReadiness } from "./runtime-readiness.js";

describe("runtime GDPR export readiness", () => {
  it("loads exact independent approvals and accepts implemented operator workflows", async () => {
    const database = createDbMock();
    database.queueSelect(
      (["legal-content", "dsar-process", "security-review"] as const).map((scope) => ({
        scope,
        version: "fixture",
        approverUserId: `${scope}-reviewer`,
        approverRole: "admin",
        decision: "approved",
        findingsDigest: null,
        reviewedAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2027-01-01T00:00:00Z"),
      })),
    );
    const report = await loadRuntimeGdprExportReadiness({
      database: database.db as never,
      evidence: {
        version: "fixture",
        controllerContactConfigured: true,
        sourceBuildFingerprint: "1".repeat(64),
      },
      implementationActorIds: ["implementer"],
      capabilities: {
        preservationEnforced: true,
        boundedSourceStreaming: true,
        assistedWorkflowComplete: true,
        operatorTaskWorkflowAvailable: true,
      },
      health: {
        monitorHealthy: true,
        cleanupHealthy: true,
        notificationHealthy: true,
        keyReady: true,
        storageHealthy: true,
        backupCapability: true,
        lastRunAt: "2026-03-01T00:00:00Z",
        lastErrorCode: null,
        keyRing: { activeVersion: 5, availableVersions: [2, 5] },
      },
      artifactStorageBackupDisabled: true,
      managedDawarichConfigured: true,
      managedDawarichAvailable: true,
      contractChecks: {
        translationsConsistent: true,
        openApiConsistent: true,
        policyConsistent: true,
      },
      now: new Date("2026-03-01T00:00:00Z"),
    });
    expect(report.ready).toBe(true);
    expect(report.keyRing).toEqual({ activeVersion: 5, availableVersions: [2, 5] });
  });

  it.each([
    { configured: false, available: false, expected: "pass" },
    { configured: true, available: true, expected: "pass" },
    { configured: true, available: false, expected: "fail" },
  ])(
    "distinguishes absent managed Dawarich from an unavailable configured service",
    async ({ configured, available, expected }) => {
      const database = createDbMock();
      database.queueSelect([]);
      const report = await loadRuntimeGdprExportReadiness({
        database: database.db as never,
        evidence: {
          version: "fixture",
          controllerContactConfigured: true,
          sourceBuildFingerprint: "1".repeat(64),
        },
        implementationActorIds: ["implementer"],
        capabilities: {
          preservationEnforced: true,
          boundedSourceStreaming: true,
          assistedWorkflowComplete: true,
          operatorTaskWorkflowAvailable: true,
        },
        health: {
          monitorHealthy: true,
          cleanupHealthy: true,
          notificationHealthy: true,
          keyReady: true,
          storageHealthy: true,
          backupCapability: true,
          lastRunAt: "2026-03-01T00:00:00Z",
          lastErrorCode: null,
        },
        artifactStorageBackupDisabled: true,
        managedDawarichConfigured: configured,
        managedDawarichAvailable: available,
        contractChecks: {
          translationsConsistent: true,
          openApiConsistent: true,
          policyConsistent: true,
        },
        now: new Date("2026-03-01T00:00:00Z"),
      });
      expect(report.checks.find((check) => check.id === "registry-completeness")?.status).toBe(
        expected,
      );
    },
  );
});
