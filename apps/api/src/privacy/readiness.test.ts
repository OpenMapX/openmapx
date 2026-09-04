import { describe, expect, it } from "vitest";
import { evaluateGdprExportReadiness, type ReadinessApproval } from "./readiness.js";

const approved: ReadinessApproval = {
  scope: "security-review",
  version: "fixture",
  approverUserId: "reviewer",
  approverRole: "security_reviewer",
  decision: "approved",
  findingsDigest: null,
  reviewedAt: "2026-01-01T00:00:00Z",
  expiresAt: "2027-01-01T00:00:00Z",
};
function status(approvals: ReadinessApproval[]) {
  return evaluateGdprExportReadiness({
    evidenceVersion: "fixture",
    now: new Date("2026-03-01T00:00:00Z"),
    approvals,
    implementationActorIds: ["implementer"],
    keyAvailable: true,
    storageHealthy: true,
    artifactStorageBackupDisabled: true,
    cleanupHealthy: true,
    backupCapability: true,
    slaMonitorHealthy: true,
    notificationHealthy: true,
    translationsConsistent: true,
    openApiConsistent: true,
    policyConsistent: true,
  }).checks.find((check) => check.id === "approval-security-review")?.status;
}
function allApprovals(): ReadinessApproval[] {
  return (["legal-content", "dsar-process", "security-review"] as const).map((scope) => ({
    ...approved,
    scope,
  }));
}
describe("privacy release approvals", () => {
  it("requires attributable independent owners before an approval can count", () => {
    const base = {
      evidenceVersion: "fixture",
      now: new Date("2026-03-01T00:00:00Z"),
      approvals: [approved],
      keyAvailable: true,
      storageHealthy: true,
      artifactStorageBackupDisabled: true,
      cleanupHealthy: true,
      backupCapability: true,
      slaMonitorHealthy: true,
      notificationHealthy: true,
      controllerContactConfigured: true,
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    };
    const check = (implementationActorIds?: string[]) =>
      evaluateGdprExportReadiness({ ...base, implementationActorIds }).checks.find(
        (entry) => entry.id === "approval-security-review",
      )?.status;
    expect(check()).toBe("fail");
    expect(check(["reviewer"])).toBe("fail");
    expect(check(["implementer"])).toBe("pass");
  });
  it("keeps incomplete design capabilities blocked even with current approvals", () => {
    const report = evaluateGdprExportReadiness({
      evidenceVersion: "fixture",
      now: new Date("2026-03-01T00:00:00Z"),
      approvals: (["legal-content", "dsar-process", "security-review"] as const).map((scope) => ({
        ...approved,
        scope,
      })),
      implementationActorIds: ["implementer"],
      catalogueAvailable: () => true,
      keyAvailable: true,
      storageHealthy: true,
      artifactStorageBackupDisabled: true,
      cleanupHealthy: true,
      backupCapability: true,
      slaMonitorHealthy: true,
      notificationHealthy: true,
      controllerContactConfigured: true,
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    });
    expect(report.ready).toBe(false);
    expect(
      report.checks.filter((check) => check.status === "fail").map((check) => check.id),
    ).toEqual(["preservation-enforcement", "source-streaming", "assisted-workflow"]);
  });

  it("is ready only for a fully healthy synthetic deployment with independent approvals", () => {
    const report = evaluateGdprExportReadiness({
      evidenceVersion: "fixture",
      now: new Date("2026-03-01T00:00:00Z"),
      approvals: allApprovals(),
      implementationActorIds: ["implementer"],
      preservationEnforced: true,
      boundedSourceStreaming: true,
      assistedWorkflowComplete: true,
      operatorTaskWorkflowAvailable: true,
      keyAvailable: true,
      storageHealthy: true,
      artifactStorageBackupDisabled: true,
      cleanupHealthy: true,
      backupCapability: true,
      slaMonitorHealthy: true,
      notificationHealthy: true,
      controllerContactConfigured: true,
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    });
    expect(report.ready).toBe(true);
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
  });

  it("treats the implemented manual operator workflow as available without resolving a case task", () => {
    const report = evaluateGdprExportReadiness({
      evidenceVersion: "fixture",
      operatorTaskWorkflowAvailable: true,
      keyAvailable: true,
      artifactStorageBackupDisabled: true,
      cleanupHealthy: true,
      backupCapability: true,
      slaMonitorHealthy: true,
      notificationHealthy: true,
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    });
    expect(report.checks.find((check) => check.id === "registry-completeness")).toMatchObject({
      status: "pass",
      detailCode: "complete",
    });
  });

  it("does not treat key availability as evidence of healthy artifact storage", () => {
    const report = evaluateGdprExportReadiness({
      evidenceVersion: "fixture",
      keyAvailable: true,
      storageHealthy: false,
      artifactStorageBackupDisabled: true,
      cleanupHealthy: true,
      backupCapability: true,
      slaMonitorHealthy: true,
      notificationHealthy: true,
      translationsConsistent: true,
      openApiConsistent: true,
      policyConsistent: true,
    });
    expect(report.checks.find((entry) => entry.id === "artifact-storage")).toMatchObject({
      status: "fail",
      detailCode: "storage-unhealthy",
    });
  });

  it("does not resurrect an older approval after a rejection", () => {
    const rejected: ReadinessApproval = {
      ...approved,
      decision: "rejected",
      findingsDigest: "a".repeat(64),
      reviewedAt: "2026-02-01T00:00:00Z",
    };
    expect(status([approved, rejected])).toBe("fail");
    expect(status([rejected, approved])).toBe("fail");
  });
  it("rejects future approval evidence and expired replacement reviews", () => {
    expect(status([{ ...approved, reviewedAt: "2026-04-01T00:00:00Z" }])).toBe("fail");
    expect(
      status([
        approved,
        { ...approved, reviewedAt: "2026-02-01T00:00:00Z", expiresAt: "2026-02-15T00:00:00Z" },
      ]),
    ).toBe("fail");
    expect(status([approved])).toBe("pass");
  });
});
