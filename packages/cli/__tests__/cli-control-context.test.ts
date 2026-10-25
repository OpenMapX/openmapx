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
import { expect, it, vi } from "vitest";
import { completeCliCommand, withCliControlContext } from "../src/lib/control-context";

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
  const operation = { kind: "service.start" as const, serviceId: "motis" };
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
  vi.stubEnv("OPENMAPX_ROOT_DIR", repo);
  vi.stubEnv("OPENMAPX_CONTROL_EXECUTION", JSON.stringify(child));
  vi.stubEnv("OPENMAPX_CONTROL_DELEGATION", assertion);
  vi.stubEnv("OPENMAPX_PARENT_EXECUTION", undefined);
  let calls = 0;
  try {
    await withCliControlContext(args, async () => {
      calls++;
      completeCliCommand(0);
    });
    expect(calls).toBe(1);
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
