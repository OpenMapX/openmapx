import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  type ControlIssuer,
  type ExecutionRef,
  executionFingerprint,
} from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { controlDigest } from "./control-records";
import {
  type ControlPlannedChild,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  retainedControlParent,
  verifyControlEffectSettlement,
} from "./execution-record";
import {
  type ControlChildPhase,
  controlChildOperationKey,
  leaseStoreDirectory,
  openLeaseStore,
} from "./lease-store";
import { openControlInstallation, provisionControlDirectories } from "./private-records";
import {
  acquireArtifactTargetLease,
  closeArtifactTargetLeaseHandle,
  delegateArtifactTargetLease,
  releaseArtifactTargetLease,
  settleArtifactTargetLeaseChild,
} from "./target-lease";

let root: string, fixture: string, fixtureRoot: string;
beforeAll(async () => {
  const result = await build({
    entryPoints: [join(import.meta.dirname, "test-fixtures/peer-process.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node24",
  });
  const output = result.outputFiles[0];
  if (!output) throw Error("Missing peer fixture bundle");
  fixtureRoot = mkdtempSync(join(tmpdir(), "omx-peer-bundle-"));
  fixture = join(fixtureRoot, "peer.mjs");
  writeFileSync(fixture, output.text);
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-peer-process-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlDirectories(root);
  symlinkSync(root, join(root, "host-alias"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function ref(
  role: ControlIssuer,
  kind: string,
  operation: unknown,
  parent?: ExecutionRef,
  phase?: ControlChildPhase,
): ExecutionRef {
  if (parent && !phase) throw Error("Missing child phase in fixture");
  const operationFingerprint =
    role === "ops-agent" &&
    !["configurationHandoff.prepare", "configurationMaintenance.prepare"].includes(kind)
      ? opsOperationFingerprint(operation as Parameters<typeof opsOperationFingerprint>[0])
      : controlDigest(operation);
  const deadlineAt = parent?.deadlineAt ?? Date.now() + 60000;
  return {
    executor: role,
    principal: role === "ops-agent" ? (parent ? "data-manager" : "api") : role,
    executionId: role === "ops-agent" ? `job1_${randomUUID().replaceAll("-", "")}` : randomUUID(),
    operationKey: parent
      ? controlChildOperationKey(parent.operationKey, phase ?? "lifecycle", 0)
      : createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind,
      operationFingerprint,
      deadlineAt,
      ...(parent ? { parent: retainedControlParent(parent) } : {}),
    }),
  };
}
async function child(input: unknown) {
  const p = spawn(process.execPath, [fixture], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "",
    err = "";
  p.stdout.on("data", (b) => (out += b));
  p.stderr.on("data", (b) => (err += b));
  p.stdin.end(`${JSON.stringify(input)}\n`);
  await new Promise<void>((resolve, reject) => {
    p.once("error", reject);
    p.once("exit", (code) => (code === 0 ? resolve() : reject(Error(err))));
  });
  return JSON.parse(out) as {
    ok: boolean;
    retired?: number;
    pending?: number;
    origin?: { rootKey: string; issuer: string; notAfter: number };
    injected?: boolean;
    retained?: boolean;
    error?: string;
    leaseId?: string;
  };
}
it("retains one data-manager owner and one agent receiver across path aliases", async () => {
  const role = "data-manager";
  const phase = "stop-primary";
  const operation = { kind: "transit-sync" };
  const kind = operation.kind;
  const rootRef = ref(role, kind, operation);
  const childOperation = { kind: "motis.primary.stop" };
  const childRef = ref("ops-agent", childOperation.kind, childOperation, rootRef, phase);
  const installation = openControlInstallation({
    infraDir: root,
    role,
    serviceIds: ["motis", "osrm"],
  });
  const plan: ControlPlannedChild = {
    phase,
    ordinal: 0,
    kind: childOperation.kind,
    execution: childRef,
    serviceIds: ["motis"],
    recipient: "ops-agent",
  };
  const authority = await retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: rootRef.deadlineAt,
    execution: rootRef,
    kind,
    operation,
    admittedAt: rootRef.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await acquireArtifactTargetLease({
    serviceIds: ["motis"],
    owner: authority,
  });
  const delegation = await delegateArtifactTargetLease(lease, plan);
  const input = {
    infraDir: join(root, "host-alias"),
    role: "ops-agent",
    leaseChild: { leaseId: lease.leaseId, childKey: delegation.childKey },
    execution: childRef,
    kind: childOperation.kind,
    operation: childOperation,
    admittedAt: childRef.deadlineAt - 60000,
  };
  const adopted = await child(input);
  expect(adopted, JSON.stringify(adopted)).toMatchObject({
    ok: true,
    retained: false,
    leaseId: lease.leaseId,
  });
  await expect(releaseArtifactTargetLease(lease)).rejects.toThrow();
  expect(
    await child({
      ...input,
      execution: { ...childRef, operationKey: `opk1_${"z".repeat(32)}` },
    }),
  ).toMatchObject({ ok: false });
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true, retained: true });
  await expect(delegateArtifactTargetLease(lease, plan)).rejects.toThrow(/replay/);
  await retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await settleArtifactTargetLeaseChild(
    lease,
    await verifyControlEffectSettlement(installation, rootRef),
  );
  await releaseArtifactTargetLease(lease);
});
it("keeps owner-death recovery fenced until a separately admitted child settles", async () => {
  const { reconcileArtifactTargetLease } = await import("./target-lease");
  const role = "data-manager";
  const operation = { kind: "transit-sync" };
  const execution = ref(role, operation.kind, operation);
  const childOperation = { kind: "motis.primary.stop" };
  const childRef = ref("ops-agent", childOperation.kind, childOperation, execution, "stop-primary");
  const installation = openControlInstallation({ infraDir: root, role, serviceIds: ["motis"] });
  const plan: ControlPlannedChild = {
    phase: "stop-primary",
    ordinal: 0,
    kind: childOperation.kind,
    execution: childRef,
    serviceIds: ["motis"],
    recipient: "ops-agent",
  };
  const admitted = {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  };
  const authority = await retainAdmittedControlExecution(installation, admitted);
  const lease = await acquireArtifactTargetLease({
    serviceIds: ["motis"],
    owner: authority,
  });
  const delegation = await delegateArtifactTargetLease(lease, plan);
  const input = {
    infraDir: root,
    role: "ops-agent",
    leaseChild: { leaseId: lease.leaseId, childKey: delegation.childKey },
    execution: childRef,
    kind: childOperation.kind,
    operation: childOperation,
    admittedAt: childRef.deadlineAt - 60000,
  };
  expect(await child(input)).toMatchObject({ ok: true });
  await retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  // Reopen role-private receipts exactly as a replacement owner does; no live handle is passed to recovery.
  const replacement = openControlInstallation({ infraDir: root, role, serviceIds: ["motis"] });
  const recovery = await retainAdmittedControlExecution(replacement, admitted);
  expect(
    await reconcileArtifactTargetLease({
      leaseId: lease.leaseId,
      authority: recovery,
    }),
  ).toBe("fenced");
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true });
  expect(
    await reconcileArtifactTargetLease({
      leaseId: lease.leaseId,
      authority: recovery,
    }),
  ).toBe("released");
});
it("keeps an attempted child fenced after SIGKILL of its actual owner process", async () => {
  const c = await import("./test-fixtures/control");
  const l = await import("./target-lease");
  const operation = { kind: "transit-sync" };
  const execution = ref("data-manager", operation.kind, operation);
  const body = { kind: "motis.primary.stop" };
  const receiver = ref("ops-agent", body.kind, body, execution, "stop-primary");
  const plan: ControlPlannedChild = {
    phase: "stop-primary",
    ordinal: 0,
    kind: body.kind,
    execution: receiver,
    serviceIds: ["motis"],
    recipient: "ops-agent",
  };
  const admitted = {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  };
  const p = spawn(process.execPath, [fixture], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const response = new Promise<{
    ok: boolean;
    delegation: { childKey: string };
    leaseId: string;
  }>((resolve, reject) => {
    let text = "";
    p.stdout.on("data", (b) => {
      text += b;
      if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0] ?? ""));
    });
    p.once("error", reject);
  });
  p.stdin.end(
    `${JSON.stringify({ mode: "owner", infraDir: root, role: "data-manager", admitted, child: plan })}\n`,
  );
  const owned = await response;
  expect(owned.ok).toBe(true);
  const exited = new Promise<void>((resolve) => p.once("exit", () => resolve()));
  p.kill("SIGKILL");
  await exited;
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["motis"],
  });
  const recovery = await c.retainAdmittedControlExecution(installation, admitted);
  expect(
    await l.reconcileArtifactTargetLease({
      leaseId: owned.leaseId,
      authority: recovery,
    }),
  ).toBe("fenced");
  const input = {
    infraDir: root,
    role: "ops-agent",
    leaseChild: { leaseId: owned.leaseId, childKey: owned.delegation.childKey },
    execution: receiver,
    kind: body.kind,
    operation: body,
    admittedAt: receiver.deadlineAt - 60000,
  };
  expect(await child({ ...input, cancel: true })).toMatchObject({ ok: true });
  expect(
    await l.reconcileArtifactTargetLease({
      leaseId: owned.leaseId,
      authority: recovery,
    }),
  ).toBe("fenced");
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true });
  expect(
    await l.reconcileArtifactTargetLease({
      leaseId: owned.leaseId,
      authority: recovery,
    }),
  ).toBe("released");
  c.closeControlInstallation(installation);
});
it("keeps paired-pin approval a one-use leaf under its original activation root", async () => {
  const c = await import("./test-fixtures/control");
  const operation = { kind: "catalog.activate", validationId: randomUUID() };
  const execution = ref("data-manager", operation.kind, operation);
  const body = {
    kind: "transitousLock.approve" as const,
    proposalId: randomUUID(),
    validationId: operation.validationId,
    expectedGenerationId: null,
    diffDigest: "a".repeat(64),
    acknowledgeLicenseChanges: false,
  };
  const childRef = ref("ops-agent", body.kind, body, execution, "paired-pin-commit");
  // The exact async120s leaf stays closed in the production adapter until05.3.
  childRef.deadlineAt = Date.now() + 20000;
  childRef.fingerprint = executionFingerprint({
    kind: body.kind,
    operationFingerprint: childRef.operationFingerprint,
    deadlineAt: childRef.deadlineAt,
    parent: c.retainedControlParent(execution),
  });
  const plan: ControlPlannedChild = {
    phase: "paired-pin-commit",
    ordinal: 0,
    kind: body.kind,
    execution: childRef,
    serviceIds: ["motis"],
    recipient: "ops-agent",
  };
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["motis"],
  });
  const authority = await c.retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await acquireArtifactTargetLease({
    serviceIds: ["motis"],
    owner: authority,
  });
  const delegation = await delegateArtifactTargetLease(lease, plan);
  const input = {
    primitive: true,
    infraDir: root,
    role: "ops-agent",
    leaseChild: { leaseId: lease.leaseId, childKey: delegation.childKey },
    execution: childRef,
    kind: body.kind,
    operation: body,
    admittedAt: Date.now(),
  };
  for (const patch of [
    { kind: "motis.primary.stop" },
    { transportPrincipal: "host-cli" },
    { execution: { ...childRef, fingerprint: "0".repeat(64) } },
  ])
    expect(await child({ ...input, ...patch })).toMatchObject({ ok: false });
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true });
  await expect(delegateArtifactTargetLease(lease, plan)).rejects.toThrow(/replay/);
  await c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await settleArtifactTargetLeaseChild(
    lease,
    await c.verifyControlEffectSettlement(installation, execution),
  );
  await releaseArtifactTargetLease(lease);
  c.closeControlInstallation(installation);
});
it("rejects a logical configuration-fence delegation without the actual maintenance producer's owner", async () => {
  const c = await import("./test-fixtures/control");
  const operation = {
    kind: "configurationMaintenance.prepare",
    maintenanceId: randomUUID(),
    candidateId: randomUUID(),
  };
  const execution = ref("ops-agent", operation.kind, operation);
  const body = {
    kind: "configuration-maintenance.prepare",
    maintenanceId: operation.maintenanceId,
    candidateId: operation.candidateId,
  };
  const childRef = ref("data-manager", body.kind, body, execution, "configuration-fence");
  const plan: ControlPlannedChild = {
    phase: "configuration-fence",
    ordinal: 0,
    kind: body.kind,
    execution: childRef,
    serviceIds: ["motis"],
    recipient: "data-manager",
  };
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis"],
  });
  const authority = await c.retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await acquireArtifactTargetLease({
    serviceIds: ["motis"],
    owner: authority,
  });
  try {
    // A bare root/plan cannot impersonate the actual maintenance producer.
    // Genuine short-leaf/SQL preparation, forged/foreign controls and held-root
    // acceptance run through the owned API/agent/DM PostgreSQL fixture.
    await expect(delegateArtifactTargetLease(lease, plan)).rejects.toThrow();
    await expect(releaseArtifactTargetLease(lease)).rejects.toThrow();
    expect(
      openLeaseStore({ directory: leaseStoreDirectory(root), purpose: "test" })
        .list()
        .map((value) => value.owner.operationKey),
    ).toEqual([execution.operationKey]);
  } finally {
    closeArtifactTargetLeaseHandle(lease);
    c.closeControlInstallation(installation);
  }
});
