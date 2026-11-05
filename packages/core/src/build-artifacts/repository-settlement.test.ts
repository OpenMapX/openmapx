import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "../ops";
import {
  beginControlEffect,
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  verifyControlEffectSettlement,
} from "./control-authority";

it.each(["commit", "rollback", "release"] as const)(
  "records actual awaited repository %s as a known finite filesystem settlement",
  async (outcome) => {
    const root = mkdtempSync(join(tmpdir(), "repository-settle-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await provisionControlInstallation(root);
    const installation = openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    try {
      const operation = {
        kind: "serviceRepository.settle" as const,
        repository: "a".repeat(16),
        transactionId: `txn1_${"b".repeat(24)}`,
        outcome,
      };
      const deadlineAt = Date.now() + 60000,
        operationFingerprint = opsOperationFingerprint(operation);
      const execution = {
        executor: "ops-agent" as const,
        principal: "api" as const,
        executionId: `job1_${randomUUID().replaceAll("-", "")}`,
        operationKey: createControlRootOperationKey({
          notAfter: deadlineAt,
          nonce: randomBytes(16),
        }),
        operationFingerprint,
        deadlineAt,
        fingerprint: executionFingerprint({
          kind: operation.kind,
          operationFingerprint,
          deadlineAt,
        }),
      };
      const authority = retainAdmittedControlExecution(installation, {
        execution,
        operation,
        kind: operation.kind,
        admittedAt: Date.now(),
        requestedDeadlineAt: deadlineAt,
        serviceIds: ["motis"],
      });
      beginControlEffect(authority);
      expect(() =>
        retainControlEffectReceipt(authority, {
          outcome: "committed",
          publication: "committed",
          receipt: {
            kind: "ops-result",
            result: { repository: operation.repository, outcome, changed: true },
          },
        }),
      ).not.toThrow();
      expect(verifyControlEffectSettlement(installation, execution)).toBeTruthy();
    } finally {
      closeControlInstallation(installation);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
