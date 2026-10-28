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
  cliControlContext,
  completeCliCommand,
  withCliControlContext,
} from "../src/lib/control-context";

it("settles successful explicit CLI exits once through the real control context", async () => {
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
    await withCliControlContext(args, async () => {
      const context = cliControlContext()!;
      const store = await services.withServiceLifecycleReceiptAuthority(context.authority, () =>
        services.openServiceLifecycleReceipt(receiptOptions),
      );
      await services.withConfigurationGenerationWriter(infra, (writer) =>
        services.withVerifiedLifecycleOwnership(
          { writer, lease: context.lease!, authority: context.authority },
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
      completeCliCommand(0);
    });
    expect(calls).toBe(1);
    const childInstallation = c.openFixedChildInstallation({ infraDir: infra, assertion });
    try {
      const childAuthority = c.restoreAdmittedControlExecution(childInstallation, child);
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
  } finally {
    vi.unstubAllEnvs();
    c.closeControlInstallation(installation);
    rmSync(repo, { recursive: true, force: true });
  }
});
