import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as c from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  executionFingerprint,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { expect, it, vi } from "vitest";
import {
  admittedRoot,
  terminalWithoutEffect,
} from "../../core/src/build-artifacts/test-fixtures/authority";
import {
  cliControlContext,
  collectHostControlRetention,
  completeCliCommand,
  withCliControlContext,
} from "../src/lib/control-context";

it("reclaims an expired host-command family before another standalone command", async () => {
  const root = mkdtempSync(join(tmpdir(), "omx-host-retention-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await c.provisionControlInstallation(root);
  const owner = admittedRoot(root);
  terminalWithoutEffect(owner.authority);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600_000);
  try {
    await collectHostControlRetention(owner.installation);
    expect(() => c.restoreAdmittedControlExecution(owner.installation, owner.execution)).toThrow();
  } finally {
    clock.mockRestore();
    c.closeControlInstallation(owner.installation);
    rmSync(root, { recursive: true, force: true });
  }
});

it.each([0, 1, 130])(
  "settles explicit CLI exit %i once through the real control context",
  async (exitCode) => {
    const repo = mkdtempSync(join(tmpdir(), "omx-fixed-cli-entry-"));
    const infra = join(repo, "infra/docker");
    mkdirSync(join(infra, "data"), { recursive: true, mode: 0o700 });
    await c.provisionControlInstallation(infra);
    const installation = c.openControlInstallation({
      infraDir: infra,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    const operation = {
      kind: "service.start" as const,
      serviceId: "motis",
      expectedConfigurationRevisionId: `cfg1_${"a".repeat(43)}`,
    };
    const operationFingerprint = opsOperationFingerprint(operation);
    const deadlineAt = Date.now() + 60000;
    const execution = {
      executor: "ops-agent" as const,
      principal: "api" as const,
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
    };
    const child = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: randomUUID(),
      operationKey: c.controlChildOperationKey(execution.operationKey, "lifecycle", 0),
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint,
        deadlineAt,
        parent: c.retainedControlParent(execution),
      }),
    };
    const plan = {
      phase: "lifecycle" as const,
      ordinal: 0,
      kind: operation.kind,
      execution: child,
      serviceIds: ["motis"],
      recipient: "fixed-cli" as const,
    };
    const authority = c.retainAdmittedControlExecution(installation, {
      requestedDeadlineAt: execution.deadlineAt,
      execution,
      kind: operation.kind,
      operation,
      admittedAt: deadlineAt - 60000,
      serviceIds: ["motis"],
      plan: [plan],
    });
    const lease = await c.acquireArtifactTargetLease({
      dataRoot: join(infra, "data"),
      serviceIds: ["motis"],
      owner: authority,
    });
    const delegationId = randomUUID();
    const publicKey = c.prepareFixedControlChild(authority, delegationId);
    const assertion = await c.delegateArtifactTargetLease(lease, {
      ...plan,
      childPublicKey: publicKey,
    });
    const args = c.fixedCliArguments(operation);
    c.retainFixedCliSpawnIntent(authority, { delegationId, execution: child, operation, args });
    const receiptOptions = {
      dataRoot: join(infra, "data"),
      execution: child,
      serviceIds: ["motis"],
      action: "start" as const,
      noDeps: false,
      coordinatorMode: "ensure-running" as const,
      expectedRevisionId: operation.expectedConfigurationRevisionId,
      seedRevisionId: operation.expectedConfigurationRevisionId,
    };
    await services.withServiceLifecycleReceiptAuthority(
      authority,
      () => services.openServiceLifecycleReceipt(receiptOptions),
      { execution: child, publicKey },
    );
    vi.stubEnv("OPENMAPX_ROOT_DIR", repo);
    vi.stubEnv("OPENMAPX_CONTROL_EXECUTION", JSON.stringify(child));
    vi.stubEnv("OPENMAPX_CONTROL_DELEGATION", assertion);
    vi.stubEnv("OPENMAPX_PARENT_EXECUTION", undefined);
    let calls = 0;
    try {
      const command = withCliControlContext(args, async () => {
        const context = cliControlContext();
        if (!context?.lease) throw Error("Missing retained CLI control context");
        const childLease = context.lease;
        const store = await services.withServiceLifecycleReceiptAuthority(context.authority, () =>
          services.openServiceLifecycleReceipt(receiptOptions),
        );
        await services.withConfigurationGenerationWriter(infra, (writer) =>
          services.withVerifiedLifecycleOwnership(
            { writer, lease: childLease, authority: context.authority },
            async (ownership) => {
              const receipt = await store.read();
              await store.checkpoint(
                receipt.sequence,
                { ...receipt, sequence: receipt.sequence + 1, phase: "pins_validated" },
                ownership,
              );
            },
          ),
        );
        calls++;
        completeCliCommand(exitCode);
      });
      if (exitCode === 0) await command;
      else await expect(command).rejects.toMatchObject({ code: exitCode });
      expect(calls).toBe(1);
      const childInstallation = c.openFixedChildInstallation({ infraDir: infra, assertion });
      try {
        const childAuthority = c.restoreAdmittedControlExecution(childInstallation, child);
        expect(() => c.verifyControlEffectSettlement(childInstallation, child)).not.toThrow();
        const receipt = await services.withServiceLifecycleReceiptAuthority(childAuthority, () =>
          services.readServiceLifecycleReceipt(receiptOptions),
        );
        expect(receipt.phase).toBe("pins_validated");
      } finally {
        c.closeControlInstallation(childInstallation);
      }
      await expect(
        withCliControlContext(args, async () => {
          calls++;
        }),
      ).rejects.toThrow();
      expect(calls).toBe(1);
      if (exitCode === 0) {
        c.retainControlEffectReceipt(authority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: { kind: "not-started" },
        });
        await c.settleArtifactTargetLeaseChild(
          lease,
          c.verifyControlEffectSettlement(installation, execution),
        );
        await c.releaseArtifactTargetLease(lease);
      }
    } finally {
      // Failed/cancelled children retain unknown evidence; do not invent a safe
      // release for this synthetic parent merely to tear the fixture down.
      if (exitCode !== 0) c.closeArtifactTargetLeaseHandle(lease);
      vi.unstubAllEnvs();
      c.closeControlInstallation(installation);
      rmSync(repo, { recursive: true, force: true });
    }
  },
);
