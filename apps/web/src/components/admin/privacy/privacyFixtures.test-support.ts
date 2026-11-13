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
      state: "open",
      userId: null,
      locale: "en",
      timeZone: "UTC",
      receivedAt: "2026-09-01T00:00:00.000Z",
      registeredAt: "2026-09-01T00:00:00.000Z",
      dueAt: "2026-10-01T00:00:00.000Z",
      originalDueAt: "2026-10-01T00:00:00.000Z",
      extension: null,
      identityMethod: null,
      identityVerifiedAt: null,
      locatorType: "email",
      accountState: "inaccessible",
      refusalCode: null,
      completedAt: null,
      closedAt: null,
      version: id === CASE_A ? 3 : 7,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    },
    tasks: [
      {
        id: TASK_A,
        registrationId,
        source: "operator",
        status: "open",
        publicCode: "operator-preservation-action-required",
        resolutionCode: null,
        resolvedAt: null,
      },
    ],
    events: [],
    capabilities: {
      verifyIdentity: true,
      resolveTasks: true,
      extendDeadline: true,
      caseDecision: true,
      export: false,
      reasons: { export: "identity-required" },
    },
  };
}
