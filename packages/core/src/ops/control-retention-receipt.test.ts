import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { OpsJobStatus } from "./contract";
import {
  controlTerminalReceiptDigest,
  signApiRetentionProof,
  signMaintenanceRecoveryProof,
  verifyApiRetentionProof,
  verifyMaintenanceRecoveryProof,
} from "./control-retention-receipt";

const status: OpsJobStatus = {
  version: 2,
  operationId: "job1_abcdefghijklmnop",
  operationKey: "opk1_abcdefghijklmnop",
  kind: "backup.delete",
  resourceId: "daily",
  state: "succeeded",
  result: { backupId: "daily" },
  admittedAt: 1,
  deadlineAt: 60001,
  fingerprint: "a".repeat(64),
  submittedAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:01.000Z",
};
it("binds exact safe terminal evidence while excluding observation-only timestamps", () => {
  expect(controlTerminalReceiptDigest({ ...status, updatedAt: "2026-10-26T00:00:00.000Z" })).toBe(
    controlTerminalReceiptDigest(status),
  );
  expect(controlTerminalReceiptDigest({ ...status, result: { backupId: "different" } })).not.toBe(
    controlTerminalReceiptDigest(status),
  );
  expect(() =>
    controlTerminalReceiptDigest({ ...status, state: "running", result: undefined }),
  ).toThrow();
  expect(() =>
    controlTerminalReceiptDigest({
      ...status,
      result: { backupId: "daily", unexpected: "secret" },
    }),
  ).toThrow();
  expect(() => controlTerminalReceiptDigest({ ...status, version: 1 })).toThrow();
});

it("authenticates a bounded recovery observation independently of the unchanged failed canonical", () => {
  const fields = {
      version: 1 as const,
      kind: "configuration-maintenance-contained" as const,
      operationId: "job1_abcdefghijklmnop",
      operationKey: "opk1_abcdefghijklmnop",
      fingerprint: "a".repeat(64),
      terminalDigest: "b".repeat(64),
      maintenanceId: "b877b2e3-4d00-42a3-84ca-0d76a0f28964",
      candidateId: "cc051823-df8e-49ed-94cd-9ee294ae3535",
      closureDigest: "c".repeat(64),
      receiverEvidenceDigest: "d".repeat(64),
      releasedAt: 123456,
    },
    proof = signMaintenanceRecoveryProof("original-token", fields),
    [payload, mac] = proof.split(".") as [string, string];
  expect(verifyMaintenanceRecoveryProof("original-token", proof)).toEqual(fields);
  expect(() => verifyMaintenanceRecoveryProof("other-token", proof)).toThrow();
  expect(() =>
    verifyMaintenanceRecoveryProof(
      "original-token",
      `${payload}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`,
    ),
  ).toThrow();
  expect(() => verifyApiRetentionProof("original-token", proof)).toThrow();
  expect(
    controlTerminalReceiptDigest({
      ...status,
      diagnostics: { tail: [], truncated: false, maintenanceRecovery: proof },
    }),
  ).toBe(controlTerminalReceiptDigest(status));
});
it("requires the fixed token, canonical fields and distinct acknowledgement domain", () => {
  const fields = {
    version: 1 as const,
    apiJobId: randomUUID(),
    originalApiOwnerVersion: 1,
    attemptId: randomUUID(),
    checkpointOwnerVersion: 2,
    terminalCopyId: randomUUID(),
    operationKey: status.operationKey,
    fingerprint: "a".repeat(64),
    terminalDigest: controlTerminalReceiptDigest(status),
  };
  const proof = signApiRetentionProof("token", fields);
  expect(verifyApiRetentionProof("token", proof)).toEqual(fields);
  expect(() => verifyApiRetentionProof("wrong", proof)).toThrow();
  expect(() => verifyApiRetentionProof("token", `${proof}=`)).toThrow();
});
