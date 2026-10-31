import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { OpsJobStatus } from "./contract";
import {
  controlTerminalReceiptDigest,
  signApiRetentionProof,
  verifyApiRetentionProof,
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
