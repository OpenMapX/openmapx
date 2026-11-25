import { expect, it } from "vitest";
import type { OpsJobStatus } from "./contract";
import { controlTerminalReceiptDigest } from "./control-terminal-receipt";

const status: OpsJobStatus = {
  version: 1,
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
  expect(() =>
    controlTerminalReceiptDigest({ ...status, version: 2 } as unknown as OpsJobStatus),
  ).toThrow();
});
