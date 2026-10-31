import type { PrivacyAdminDetail } from "@openmapx/core/api-contracts";
export const CASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const CASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const TASK_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export function privacyDetail(
  id = CASE_A,
  registrationId = "registration-for-case-a",
): PrivacyAdminDetail {
  return {
    request: {
      id,
      kind: "access_and_portability",
      channel: "email",
      state: "identity_pending",
      userId: null,
      locale: "en",
      timeZone: "UTC",
      receivedAt: "2026-09-01T00:00:00.000Z",
      registeredAt: "2026-09-01T00:00:00.000Z",
      dueAt: "2026-10-01T00:00:00.000Z",
      originalDueAt: "2026-10-01T00:00:00.000Z",
      extension: null,
      identityState: "pending",
      locatorType: "email",
      accountState: "inaccessible",
      refusalCode: null,
      deliveryState: "not_delivered",
      version: id === CASE_A ? 3 : 7,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    tasks: [
      {
        id: TASK_A,
        taskKey: "collect",
        registrationId,
        source: "operator",
        required: 1,
        status: "operator_review",
        attempts: 0,
        assignedTo: null,
        cutoffAt: null,
        collectedAt: null,
        recordCount: null,
        exceptionCode: null,
        redactionCode: null,
        actions: ["complete", "not_applicable", "operator_review", "retryable", "canceled"],
      },
    ],
    identities: [
      {
        party: "subject",
        state: "pending",
        method: null,
        authorityState: "not_required",
        deliveryAuthorized: 0,
        verifiedAt: null,
      },
    ],
    attachments: [],
    artifacts: [],
    events: [],
    capabilities: {
      identityReview: true,
      taskDecision: true,
      taskAssignment: true,
      extendDeadline: true,
      caseDecision: true,
      attachmentWrite: true,
      backupReview: true,
      generate: false,
      assistedDelivery: false,
      representativeDelivery: false,
      reasons: { generate: "case-sources-not-ready" },
    },
  };
}
export function privacyReadiness() {
  return {
    version: 1,
    ready: false,
    checkedAt: "2026-09-05T00:00:00.000Z",
    evidenceVersion: "v1",
    keyRing: null,
    checks: [
      { id: "controller-contact", status: "fail", detailCode: "controller-contact-missing" },
    ],
    approvals: [],
  };
}
