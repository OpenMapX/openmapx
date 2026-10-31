import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OPS_KIND_POLICIES } from "./contract";
import {
  normalizeExecutionAdmission,
  opsExecutionBudget,
  verifiedApiJobParentBinding,
  verifyApiJobParentExecution,
} from "./execution-identity";

const admittedAt = 1_000_000;
const base = {
  kind: "service.build",
  operationKey: "opk1_abcdefghijklmnop",
  operationFingerprint: "a".repeat(64),
  admittedAt,
};
describe("immutable execution admission", () => {
  it("retains long per-kind budgets without the old CLI/observer clamps", () => {
    expect(OPS_KIND_POLICIES["service.build"].timeoutMs).toBe(12 * 3600_000);
    expect(OPS_KIND_POLICIES["services.buildAll"].timeoutMs).toBe(24 * 3600_000);
    expect(OPS_KIND_POLICIES["system.update"].timeoutMs).toBe(48 * 3600_000);
    expect(opsExecutionBudget("artifactTransfer.import")).toEqual({
      processMs: 72 * 3600_000,
      settlementMs: 30_000,
    });
    expect(opsExecutionBudget("catalog.validate").processMs).toBe(72 * 3600_000);
    expect(opsExecutionBudget("platform.config.apply").processMs).toBe(3600_000);
    expect(
      normalizeExecutionAdmission({ ...base, kind: "artifactTransfer.import" }).deadlineAt,
    ).toBe(admittedAt + 72 * 3600_000);
    expect(
      normalizeExecutionAdmission({
        ...base,
        kind: "artifactTransfer.import",
        requestedDeadlineAt: admittedAt + 8 * 24 * 3600_000,
        deploymentBudgetMs: 7 * 24 * 3600_000,
      }).deadlineAt,
    ).toBe(admittedAt + 7 * 24 * 3600_000);
  });
  it("normalizes from original admission, body, deadline and parent, never today's clock", () => {
    const first = normalizeExecutionAdmission(base);
    expect(first.deadlineAt).toBe(admittedAt + 12 * 3600_000);
    expect(normalizeExecutionAdmission(base)).toEqual(first);
    expect(
      normalizeExecutionAdmission({ ...base, requestedDeadlineAt: first.deadlineAt + 1 }),
    ).toEqual(first);
    expect(
      normalizeExecutionAdmission({ ...base, requestedDeadlineAt: first.deadlineAt - 1 })
        .fingerprint,
    ).not.toBe(first.fingerprint);
    expect(normalizeExecutionAdmission({ ...base, deploymentBudgetMs: 100 }).deadlineAt).toBe(
      admittedAt + 100,
    );
    expect(() =>
      normalizeExecutionAdmission({ ...base, requestedDeadlineAt: admittedAt }),
    ).toThrow();
  });
  it("clamps a late child to the authenticated parent and rejects invented authority", () => {
    const fields = {
      version: 1,
      apiJobId: "123e4567-e89b-42d3-a456-426614174000",
      apiOwnerVersion: 1,
      parentOperationKey: "opk1_parentabcdefghij",
      parentFingerprint: "b".repeat(64),
      parentDeadlineAt: admittedAt + 100,
      childOperationKey: base.operationKey,
      childOperationFingerprint: base.operationFingerprint,
      requestedDeadlineAt: admittedAt + 1000,
      attemptId: "123e4567-e89b-42d3-a456-426614174001",
    };
    const payload = Buffer.from(JSON.stringify(fields)).toString("base64url");
    const signature = createHmac("sha256", "test-token")
      .update("openmapx-api-job-parent-v1\0")
      .update(payload)
      .digest("base64url");
    const assertion = `${payload}.${signature}`;
    const parent = verifyApiJobParentExecution(assertion, "test-token", {
      operationKey: base.operationKey,
      operationFingerprint: base.operationFingerprint,
      requestedDeadlineAt: fields.requestedDeadlineAt,
    });
    expect(verifiedApiJobParentBinding(parent)).toEqual(fields);
    expect(Object.isFrozen(verifiedApiJobParentBinding(parent))).toBe(true);
    expect(() => verifiedApiJobParentBinding({ ...parent })).toThrow(
      "Actual verified API job parent binding required",
    );
    const result = normalizeExecutionAdmission({
      ...base,
      requestedDeadlineAt: fields.requestedDeadlineAt,
      parent,
    });
    expect(result.deadlineAt).toBe(admittedAt + 100);
    expect(() => normalizeExecutionAdmission({ ...base, parent })).toThrow();
    expect(() =>
      normalizeExecutionAdmission({ ...base, parent: { deadlineAt: admittedAt + 10 } as never }),
    ).toThrow();
    expect(() =>
      verifyApiJobParentExecution(assertion, "other-token", {
        operationKey: base.operationKey,
        operationFingerprint: base.operationFingerprint,
        requestedDeadlineAt: fields.requestedDeadlineAt,
      }),
    ).toThrow();
  });
});
