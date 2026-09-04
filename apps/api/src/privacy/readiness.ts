import { createHash } from "node:crypto";
import z from "zod/v4";
import { catalogueAvailability, SUBJECT_DATA_CATALOGUE } from "./catalogue.js";
import type { MasterKeyRingMetadata } from "./crypto.js";

export const readinessCheckSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    status: z.enum(["pass", "fail", "warning"]),
    detailCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  })
  .strict();
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

export const approvalSchema = z
  .object({
    scope: z.enum(["legal-content", "dsar-process", "security-review"]),
    version: z.string().min(1).max(128),
    approverUserId: z.string().min(1).max(256),
    approverRole: z.enum(["admin", "privacy_admin", "legal_reviewer", "security_reviewer"]),
    decision: z.enum(["approved", "rejected"]),
    findingsDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    reviewedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const reviewed = Date.parse(value.reviewedAt);
    const expires = Date.parse(value.expiresAt);
    if (!Number.isFinite(reviewed) || !Number.isFinite(expires) || expires <= reviewed) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "approval expiry must be after review",
      });
    }
    if (value.decision === "rejected" && !value.findingsDigest) {
      ctx.addIssue({
        code: "custom",
        path: ["findingsDigest"],
        message: "rejected approvals require findings digest",
      });
    }
  });
export type ReadinessApproval = z.infer<typeof approvalSchema>;

export interface GdprExportReadiness {
  version: 1;
  ready: boolean;
  checkedAt: string;
  evidenceVersion: string;
  keyRing: MasterKeyRingMetadata | null;
  checks: ReadinessCheck[];
  approvals: ReadinessApproval[];
}

export interface ReadinessInputs {
  evidenceVersion: string;
  /** Attributable implementation owners from trusted deployment configuration. */
  implementationActorIds?: readonly string[];
  /** Optional per-scope contract versions.  When omitted, every approval must
   * name the same evidence version exposed by the report. */
  approvalVersions?: Partial<Record<ReadinessApproval["scope"], string>>;
  now?: Date;
  /** Required design capabilities; declarations/approvals cannot substitute for them. */
  preservationEnforced?: boolean;
  boundedSourceStreaming?: boolean;
  assistedWorkflowComplete?: boolean;
  operatorTaskWorkflowAvailable?: boolean;
  keyAvailable: boolean;
  keyRing?: MasterKeyRingMetadata | null;
  storageHealthy?: boolean;
  artifactStorageBackupDisabled: boolean;
  cleanupHealthy: boolean;
  backupCapability: boolean;
  slaMonitorHealthy: boolean;
  notificationHealthy: boolean;
  controllerContactConfigured?: boolean;
  translationsConsistent: boolean;
  openApiConsistent: boolean;
  policyConsistent: boolean;
  approvals?: readonly ReadinessApproval[];
  catalogueAvailable?: (registration: (typeof SUBJECT_DATA_CATALOGUE)[number]) => boolean;
}

export interface ReadinessImplementationCapabilities {
  preservationEnforced: boolean;
  boundedSourceStreaming: boolean;
  assistedWorkflowComplete: boolean;
  operatorTaskWorkflowAvailable: boolean;
}

export interface ReadinessReleaseContractChecks {
  translationsConsistent: boolean;
  openApiConsistent: boolean;
  policyConsistent: boolean;
}

function check(
  id: string,
  ok: boolean,
  passCode: string,
  failCode = "unavailable",
): ReadinessCheck {
  return { id, status: ok ? "pass" : "fail", detailCode: ok ? passCode : failCode };
}

export function evaluateGdprExportReadiness(input: ReadinessInputs): GdprExportReadiness {
  const now = input.now ?? new Date();
  const available =
    input.catalogueAvailable ??
    ((registration) =>
      registration.strategy === "not_personal" ||
      (registration.strategy === "operator_task" && input.operatorTaskWorkflowAvailable === true) ||
      catalogueAvailability(registration) === "available");
  const catalogueOk = SUBJECT_DATA_CATALOGUE.every((registration) => available(registration));
  const checks: ReadinessCheck[] = [
    check(
      "preservation-enforcement",
      input.preservationEnforced === true,
      "enforced",
      "source-retention-not-wired",
    ),
    check(
      "source-streaming",
      input.boundedSourceStreaming === true,
      "bounded",
      "source-buffering-unverified",
    ),
    check(
      "assisted-workflow",
      input.assistedWorkflowComplete === true,
      "complete",
      "assisted-workflow-incomplete",
    ),
    check("registry-completeness", catalogueOk, "complete", "collector-or-review-missing"),
    check("encryption-key", input.keyAvailable, "ready", "key-unavailable"),
    check("artifact-storage", input.storageHealthy === true, "healthy", "storage-unhealthy"),
    check(
      "artifact-storage-backup",
      input.artifactStorageBackupDisabled,
      "excluded",
      "backup-enabled",
    ),
    check("cleanup-retention", input.cleanupHealthy, "healthy", "cleanup-unhealthy"),
    check(
      "backup-review-capability",
      input.backupCapability,
      "available",
      "backup-review-unavailable",
    ),
    check("request-sla-monitor", input.slaMonitorHealthy, "healthy", "sla-monitor-unavailable"),
    check("notification-health", input.notificationHealthy, "healthy", "notification-unavailable"),
    check(
      "controller-contact",
      input.controllerContactConfigured === true,
      "configured",
      "controller-contact-missing",
    ),
    check("translations", input.translationsConsistent, "consistent", "translation-drift"),
    check("openapi", input.openApiConsistent, "consistent", "openapi-drift"),
    check("policy", input.policyConsistent, "consistent", "policy-drift"),
  ];
  const approvals = (input.approvals ?? []).map((value) => approvalSchema.parse(value));
  const current = new Map<string, ReadinessApproval>();
  const latest = new Map<string, ReadinessApproval>();
  for (const approval of approvals) {
    const requiredVersion = input.approvalVersions?.[approval.scope] ?? input.evidenceVersion;
    if (approval.version !== requiredVersion || Date.parse(approval.reviewedAt) > now.getTime())
      continue;
    const previous = latest.get(approval.scope);
    // A newer rejection/expired review supersedes an earlier approval. On
    // equal timestamps prefer rejection rather than depending on row order.
    if (
      !previous ||
      Date.parse(approval.reviewedAt) > Date.parse(previous.reviewedAt) ||
      (approval.reviewedAt === previous.reviewedAt && approval.decision === "rejected")
    ) {
      latest.set(approval.scope, approval);
    }
  }
  for (const [scope, approval] of latest) {
    if (
      approval.decision === "approved" &&
      Date.parse(approval.expiresAt) > now.getTime() &&
      (input.implementationActorIds?.length ?? 0) > 0 &&
      !input.implementationActorIds?.includes(approval.approverUserId)
    )
      current.set(scope, approval);
  }
  const requiredScopes = ["legal-content", "dsar-process", "security-review"] as const;
  for (const scope of requiredScopes)
    checks.push(
      check(`approval-${scope}`, current.has(scope), "current", "approval-missing-or-expired"),
    );
  const ready = checks.every((value) => value.status === "pass");
  return {
    version: 1,
    ready,
    checkedAt: now.toISOString(),
    evidenceVersion: input.evidenceVersion,
    keyRing: input.keyRing ?? null,
    checks,
    approvals,
  };
}

export function approvalFindingsDigest(findings: string): string {
  if (findings.length > 8_192) throw new Error("approval findings are too large");
  return createHash("sha256").update(findings).digest("hex");
}

export function assertApprovalSeparation(
  approval: ReadinessApproval,
  implementationActorId: string,
): void {
  if (
    approval.decision === "approved" &&
    approval.approverUserId === implementationActorId &&
    ["legal-content", "dsar-process", "security-review"].includes(approval.scope)
  )
    throw new Error("approval requires separation of duties");
}
