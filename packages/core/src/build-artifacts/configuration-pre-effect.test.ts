import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpsOperation } from "../ops/contract";
import { createControlRootOperationKey } from "../ops/control-root-key";
import { executionFingerprint } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  bindControlChildPhase,
  type ControlChildReservation,
  issueControlChildPhase,
} from "./child-phase";
import {
  beginControlEffect,
  closeControlInstallation,
  controlChildOperationKey,
  inspectConfigurationPreEffectRefusal,
  openControlInstallation,
  prepareFixedControlChild,
  provisionControlDirectories,
  reserveControlTerminal,
  restoreConfigurationPreEffectTerminal,
  retainAdmittedControlExecution,
  retainConfigurationPreEffectRefusal,
  retainControlTerminalCommitment,
  verifyControlEffectSettlement,
} from "./control-authority";
import { leaseStoreDirectory, openLeaseStore } from "./lease-store";
import {
  acquireArtifactTargetLease,
  releaseArtifactTargetLease,
  settleArtifactTargetLeaseChild,
  verifyLocalArtifactTargetRootRelease,
} from "./target-lease";

let root: string, installation: ReturnType<typeof openControlInstallation>;
const targets = ["data-manager", "motis"],
  revision = `cfg1_${"a".repeat(43)}`;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-configuration-pre-effect-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlDirectories(root);
  installation = openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: targets,
  });
});
afterEach(() => {
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});
function admit(operation: OpsOperation, reserve = false, serviceIds = targets) {
  const admittedAt = Date.now(),
    deadlineAt = admittedAt + 120000,
    operationFingerprint = opsOperationFingerprint(operation),
    operationKey = createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    execution = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: `job1_${randomBytes(18).toString("base64url")}`,
      operationKey,
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    },
    reservations: ControlChildReservation[] = reserve
      ? [
          {
            version: 1,
            phase: "lifecycle",
            ordinal: 0,
            kind: "service.update",
            recipient: "fixed-cli",
            serviceIds,
            operationFingerprint,
            execution: {
              executor: "host-cli",
              principal: "host-cli",
              executionId: randomUUID(),
              operationKey: controlChildOperationKey(operationKey, "lifecycle", 0),
            },
          },
        ]
      : [];
  return retainAdmittedControlExecution(installation, {
    operation,
    kind: operation.kind,
    execution,
    admittedAt,
    requestedDeadlineAt: deadlineAt,
    serviceIds,
    reservations,
  });
}
function start() {
  return admit({
    kind: "service.start",
    serviceId: "motis",
    expectedConfigurationRevisionId: revision,
  });
}
it("settles the actual unissued root and consumes only its indexed not-started effect", async () => {
  const owner = start(),
    lease = await acquireArtifactTargetLease({
      serviceIds: targets,
      owner,
    });
  retainConfigurationPreEffectRefusal(owner);
  inspectConfigurationPreEffectRefusal(owner);
  await settleArtifactTargetLeaseChild(
    lease,
    verifyControlEffectSettlement(installation, owner.execution),
  );
  await releaseArtifactTargetLease(lease);
  verifyLocalArtifactTargetRootRelease(owner);
  expect(() => beginControlEffect(owner)).toThrow();
});
it.each(["begun", "bound", "issued"])(
  "keeps an actual %s root fenced rather than claiming not-started",
  async (boundary) => {
    const owner =
        boundary === "begun"
          ? start()
          : admit(
              {
                kind: "service.update",
                serviceId: "motis",
                expectedConfigurationRevisionId: revision,
              },
              true,
            ),
      lease = await acquireArtifactTargetLease({
        serviceIds: targets,
        owner,
      });
    if (boundary === "begun") beginControlEffect(owner);
    else {
      await bindControlChildPhase(owner, { phase: "lifecycle", ordinal: 0 });
      if (boundary === "issued")
        await issueControlChildPhase(owner, {
          phase: "lifecycle",
          ordinal: 0,
          lease,
          childId: prepareFixedControlChild(owner, randomUUID()),
        });
    }
    expect(() => retainConfigurationPreEffectRefusal(owner)).toThrow();
    expect(() => inspectConfigurationPreEffectRefusal(owner)).toThrow();
    expect(() => verifyLocalArtifactTargetRootRelease(owner)).toThrow();
    expect(
      openLeaseStore({ directory: leaseStoreDirectory(root), purpose: "test" })
        .list()
        .map((value) => value.leaseId),
    ).toEqual([lease.leaseId]);
  },
);
it.each(["exact", "different error", "missing"] as const)(
  "restores original pre-effect whole tuple only from %s commitment",
  async (mode) => {
    const owner = start();
    reserveControlTerminal(owner);
    retainConfigurationPreEffectRefusal(owner);
    const admission = JSON.parse(
        readFileSync(
          join(root, "state/ops-agent/control/executions", `${owner.execution.operationKey}.json`),
          "utf8",
        ),
      ),
      terminalAt = Date.now(),
      status = {
        version: 2 as const,
        admittedAt: admission.admittedAt,
        deadlineAt: owner.execution.deadlineAt,
        fingerprint: owner.execution.fingerprint,
        operationId: owner.execution.executionId,
        operationKey: owner.execution.operationKey,
        kind: "service.start" as const,
        resourceId: "motis",
        state: "failed" as const,
        submittedAt: new Date(admission.admittedAt).toISOString(),
        updatedAt: new Date(terminalAt).toISOString(),
        errorClass:
          mode === "different error"
            ? ("runtime" as const)
            : ("configuration_prerequisite" as const),
        failureResult: {},
      };
    if (mode !== "missing") retainControlTerminalCommitment(owner, status, terminalAt);
    const observed = {
      ...status,
      errorClass: "recovery_required" as const,
      updatedAt: new Date(terminalAt + 1000).toISOString(),
    };
    if (mode === "exact")
      expect(
        restoreConfigurationPreEffectTerminal(installation, owner.execution, observed),
      ).toEqual({ status, terminalAt });
    else
      expect(() =>
        restoreConfigurationPreEffectTerminal(installation, owner.execution, observed),
      ).toThrow();
  },
);
