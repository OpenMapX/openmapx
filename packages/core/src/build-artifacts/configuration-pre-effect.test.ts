import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  provisionControlInstallation,
  requireControlJournalRetention,
  restoreConfigurationPreEffectTerminal,
  retainAdmittedControlExecution,
  retainConfigurationPreEffectRefusal,
  retainControlTerminalCommitment,
  verifyControlEffectSettlement,
} from "./control-authority";
import {
  acquireArtifactTargetLease,
  releaseArtifactTargetLease,
  settleArtifactTargetLeaseChild,
  verifyRetainedArtifactTargetRootRelease,
} from "./target-lease";

let root: string, installation: ReturnType<typeof openControlInstallation>;
const targets = ["data-manager", "motis"],
  revision = `cfg1_${"a".repeat(43)}`;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-configuration-pre-effect-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
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
      dataRoot: join(root, "data"),
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
  verifyRetainedArtifactTargetRootRelease(owner);
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
        dataRoot: join(root, "data"),
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
          childPublicKey: prepareFixedControlChild(owner, randomUUID()),
        });
    }
    expect(() => retainConfigurationPreEffectRefusal(owner)).toThrow();
    expect(() => inspectConfigurationPreEffectRefusal(owner)).toThrow();
    expect(() => verifyRetainedArtifactTargetRootRelease(owner)).toThrow();
    expect(existsSync(join(root, "data/.admin-target-control/locks/data-manager"))).toBe(true);
  },
);
it("rejects a byte-identical not-started effect copied to a replacement inode", () => {
  const owner = start();
  retainConfigurationPreEffectRefusal(owner);
  const path = join(
      root,
      "control-private/ops-agent/effects",
      `${owner.execution.operationKey}.json`,
    ),
    bytes = readFileSync(path);
  renameSync(path, `${path}.original`);
  writeFileSync(path, bytes, { mode: 0o600 });
  expect(() => inspectConfigurationPreEffectRefusal(owner)).toThrow();
});
it.each(["retain", "inspect"])(
  "rejects a replaced indexed admission before pre-effect %s",
  (phase) => {
    const owner = start();
    if (phase === "inspect") retainConfigurationPreEffectRefusal(owner);
    const path = join(
        root,
        "control-private/ops-agent/executions",
        `${owner.execution.operationKey}.json`,
      ),
      bytes = readFileSync(path);
    renameSync(path, `${path}.original`);
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(() =>
      phase === "retain"
        ? retainConfigurationPreEffectRefusal(owner)
        : inspectConfigurationPreEffectRefusal(owner),
    ).toThrow();
  },
);

it.each(["exact", "different error", "missing", "copied commitment"] as const)(
  "restores original pre-effect whole tuple only from %s commitment",
  async (mode) => {
    const owner = start();
    requireControlJournalRetention(owner);
    retainConfigurationPreEffectRefusal(owner);
    const admission = JSON.parse(
        readFileSync(
          join(
            root,
            "control-private/ops-agent/executions",
            `${owner.execution.operationKey}.json`,
          ),
          "utf8",
        ),
      ).payload,
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
    if (mode === "copied commitment") {
      const path = join(
          root,
          "control-private/ops-agent/observations",
          `terminal-${owner.execution.operationKey}.json`,
        ),
        bytes = readFileSync(path);
      renameSync(path, `${path}.original`);
      writeFileSync(path, bytes, { mode: 0o600 });
    }
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
