import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ControlIssuer,
  type ExecutionRef,
  executionFingerprint,
} from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  type ControlChildPhase,
  type ControlPlannedChild,
  closeControlInstallation,
  controlChildOperationKey,
  controlDigest,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  retainedControlParent,
  verifyControlEffectSettlement,
} from "./control-authority";
import {
  acquireArtifactTargetLease,
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
  await provisionControlInstallation(root);
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
      ? controlChildOperationKey(parent.operationKey, phase ?? "hardlinks", 0)
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
describe("separate-process physical-mount delegation", () => {
  it.each(["data-manager", "ops-agent"] as const)(
    "retains one owner and one receiver across %s direction and path aliases",
    async (role) => {
      const receiver = role === "data-manager" ? "ops-agent" : "data-manager";
      const phase = role === "data-manager" ? "stop-primary" : "hardlinks";
      const operation =
        role === "data-manager"
          ? { kind: "transit-sync" }
          : { kind: "service.start", serviceId: "motis" };
      const kind = operation.kind;
      const rootRef = ref(role, kind, operation);
      const childOperation =
        receiver === "ops-agent"
          ? { kind: "motis.primary.stop" }
          : {
              kind: "generation-hardlinks",
              revisionId: "cfg1_test",
              planDigest: "a".repeat(64),
              coordinatorMode: "require-running",
            };
      const childRef = ref(receiver, childOperation.kind, childOperation, rootRef, phase);
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
        recipient: receiver,
      };
      const authority = retainAdmittedControlExecution(installation, {
        requestedDeadlineAt: rootRef.deadlineAt,
        execution: rootRef,
        kind,
        operation,
        admittedAt: rootRef.deadlineAt - 60000,
        serviceIds: ["motis"],
        plan: [plan],
      });
      const lease = await acquireArtifactTargetLease({
        dataRoot: join(root, "host-alias/data"),
        serviceIds: ["motis"],
        owner: authority,
      });
      const verifiers = JSON.parse(
        readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"),
      );
      const assertion = await delegateArtifactTargetLease(lease, {
        ...plan,
        childPublicKey: verifiers.publicKeys[receiver],
      });
      const input = {
        infraDir: root,
        role: receiver,
        assertion,
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
      await expect(
        delegateArtifactTargetLease(lease, {
          ...plan,
          childPublicKey: verifiers.publicKeys[receiver],
        }),
      ).rejects.toThrow(/replay/);
      retainControlEffectReceipt(authority, {
        outcome: "failed_without_effect",
        publication: "not_started",
        receipt: { kind: "not-started" },
      });
      await settleArtifactTargetLeaseChild(
        lease,
        verifyControlEffectSettlement(installation, rootRef),
      );
      await releaseArtifactTargetLease(lease);
    },
  );
});
it("keeps owner-death recovery fenced until a separately admitted child settles", async () => {
  const { verifyControlRecoveryAuthority } = await import("./control-authority");
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
  const authority = retainAdmittedControlExecution(installation, admitted);
  const lease = await acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
  const publicKeys = JSON.parse(
    readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"),
  ).publicKeys;
  const assertion = await delegateArtifactTargetLease(lease, {
    ...plan,
    childPublicKey: publicKeys["ops-agent"],
  });
  const input = {
    infraDir: root,
    role: "ops-agent",
    assertion,
    execution: childRef,
    kind: childOperation.kind,
    operation: childOperation,
    admittedAt: childRef.deadlineAt - 60000,
  };
  expect(await child(input)).toMatchObject({ ok: true });
  retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  // Reopen role-private receipts exactly as a replacement owner does; no live handle is passed to recovery.
  const replacement = openControlInstallation({ infraDir: root, role, serviceIds: ["motis"] });
  const recovered = retainAdmittedControlExecution(replacement, admitted);
  const recovery = verifyControlRecoveryAuthority(recovered);
  expect(
    await reconcileArtifactTargetLease({
      dataRoot: join(root, "host-alias/data"),
      leaseId: lease.leaseId,
      authority: recovery,
    }),
  ).toBe("fenced");
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true });
  expect(
    await reconcileArtifactTargetLease({
      dataRoot: join(root, "data"),
      leaseId: lease.leaseId,
      authority: recovery,
    }),
  ).toBe("released");
});
it.each([false, true])(
  "certifies a depth-two hardlink leaf across processes (cancel intermediate: %s)",
  async (cancelIntermediate) => {
    const c = await import("./control-authority");
    const operation = { kind: "service.start" as const, serviceId: "motis" };
    const execution = ref("ops-agent", operation.kind, operation);
    const cli = ref("host-cli", operation.kind, operation, execution, "lifecycle");
    const plan: ControlPlannedChild = {
      phase: "lifecycle",
      ordinal: 0,
      kind: operation.kind,
      execution: cli,
      serviceIds: ["motis"],
      recipient: "fixed-cli",
    };
    const installation = c.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis", "osrm"],
    });
    const authority = c.retainAdmittedControlExecution(installation, {
      requestedDeadlineAt: execution.deadlineAt,
      execution,
      kind: operation.kind,
      operation,
      admittedAt: execution.deadlineAt - 60000,
      serviceIds: ["motis"],
      plan: [plan],
    });
    const lease = await acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["motis"],
      owner: authority,
    });
    const id = randomUUID();
    const key = c.prepareFixedControlChild(authority, id);
    const assertion = await delegateArtifactTargetLease(lease, { ...plan, childPublicKey: key });
    const args = c.fixedCliArguments(operation);
    c.retainFixedCliSpawnIntent(authority, { delegationId: id, execution: cli, operation, args });
    const hardlinks = {
      kind: "generation-hardlinks",
      revisionId: "cfg1_test",
      planDigest: "a".repeat(64),
      coordinatorMode: "require-running",
    };
    const leaf = ref("data-manager", hardlinks.kind, hardlinks, cli, "hardlinks");
    const childPublicKey = JSON.parse(
      readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"),
    ).publicKeys["data-manager"];
    const fixed = { mode: "fixed", infraDir: root, assertion, execution: cli, args };
    const leafInput = {
      execution: leaf,
      phase: "hardlinks",
      recipient: "data-manager",
      serviceIds: ["motis"],
      childPublicKey,
    };
    expect(await child({ ...fixed, child: { ...leafInput, serviceIds: ["osrm"] } })).toMatchObject({
      ok: false,
    });
    const started = (await child({ ...fixed, action: "run", child: leafInput })) as {
      ok: boolean;
      assertion: string;
      error?: string;
    };
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
    expect(await child({ ...fixed, action: "run" })).toMatchObject({ ok: false });
    expect(await child({ ...fixed, action: "settle" })).toMatchObject({ ok: false });
    const hardlinkInput = {
      infraDir: root,
      role: "data-manager",
      assertion: started.assertion,
      execution: leaf,
      kind: hardlinks.kind,
      operation: hardlinks,
      admittedAt: leaf.deadlineAt - 60000,
    };
    if (cancelIntermediate) {
      expect(await child({ ...hardlinkInput, forward: true })).toMatchObject({ ok: true });
      expect(await child({ ...fixed, action: "cancel" })).toMatchObject({ ok: true });
      expect(await child(hardlinkInput)).toMatchObject({ ok: true, retained: true });
      expect(await child({ ...hardlinkInput, forward: true })).toMatchObject({ ok: false });
      await expect(releaseArtifactTargetLease(lease)).rejects.toThrow();
    }
    expect(
      await child({
        infraDir: root,
        role: "data-manager",
        assertion: started.assertion,
        execution: leaf,
        kind: hardlinks.kind,
        operation: hardlinks,
        admittedAt: leaf.deadlineAt - 60000,
        settle: true,
      }),
    ).toMatchObject({ ok: true });
    expect(await child({ ...fixed, action: "settle" })).toMatchObject({ ok: true });
    c.retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await settleArtifactTargetLeaseChild(
      lease,
      c.verifyControlEffectSettlement(installation, execution),
    );
    await releaseArtifactTargetLease(lease);
    c.closeControlInstallation(installation);
  },
  60000,
);
it("keeps an attempted child fenced after SIGKILL of its actual owner process", async () => {
  const c = await import("./control-authority");
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
  const childPublicKey = JSON.parse(
    readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"),
  ).publicKeys["ops-agent"];
  const p = spawn(process.execPath, [fixture], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const response = new Promise<{ ok: boolean; assertion: string; leaseId: string }>(
    (resolve, reject) => {
      let text = "";
      p.stdout.on("data", (b) => {
        text += b;
        if (text.includes("\n")) resolve(JSON.parse(text.split("\n")[0] ?? ""));
      });
      p.once("error", reject);
    },
  );
  p.stdin.end(
    `${JSON.stringify({ mode: "owner", infraDir: root, role: "data-manager", admitted, child: { ...plan, childPublicKey } })}\n`,
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
  const authority = c.retainAdmittedControlExecution(installation, admitted);
  const recovery = c.verifyControlRecoveryAuthority(authority);
  expect(
    await l.reconcileArtifactTargetLease({
      dataRoot: join(root, "data"),
      leaseId: owned.leaseId,
      authority: recovery,
    }),
  ).toBe("fenced");
  const input = {
    infraDir: root,
    role: "ops-agent",
    assertion: owned.assertion,
    execution: receiver,
    kind: body.kind,
    operation: body,
    admittedAt: receiver.deadlineAt - 60000,
  };
  expect(await child({ ...input, cancel: true })).toMatchObject({ ok: true });
  expect(
    await l.reconcileArtifactTargetLease({
      dataRoot: join(root, "data"),
      leaseId: owned.leaseId,
      authority: recovery,
    }),
  ).toBe("fenced");
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true });
  expect(
    await l.reconcileArtifactTargetLease({
      dataRoot: join(root, "data"),
      leaseId: owned.leaseId,
      authority: recovery,
    }),
  ).toBe("released");
  c.closeControlInstallation(installation);
});
it.each([false, true])(
  "external helper survives owner death and requires terminal preparation (%s)",
  async (prepared) => {
    const operation = {
      kind: "configurationHandoff.prepare",
      handoffId: randomUUID(),
      expectedRevisionId: "cfg1_old",
      desiredRevisionId: "cfg1_new",
      image: `sha256:${"1".repeat(64)}`,
    };
    const execution = ref("ops-agent", operation.kind, operation);
    const body = { kind: "configuration-helper", handoffId: operation.handoffId };
    const helper = ref("host-cli", body.kind, body, execution, "configuration-handoff");
    const plan: ControlPlannedChild = {
      phase: "configuration-handoff",
      ordinal: 0,
      kind: body.kind,
      execution: helper,
      serviceIds: ["motis"],
      recipient: "configuration-helper",
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
    const { writeFileSync } = await import("node:fs");
    mkdirSync(join(root, "data/ops-agent"), { mode: 0o700 });
    writeFileSync(
      join(root, "data/ops-agent/jobs-v1.json"),
      JSON.stringify({
        version: 2,
        jobs: [
          {
            operationId: execution.executionId,
            operationKey: execution.operationKey,
            operationFingerprint: execution.operationFingerprint,
            fingerprint: execution.fingerprint,
            deadlineAt: execution.deadlineAt,
            state: prepared ? "succeeded" : "running",
            operation,
            result: { phase: "prepared", handoffId: operation.handoffId },
            terminalAt: new Date().toISOString(),
          },
        ],
      }),
      { mode: 0o600 },
    );
    const p = spawn(process.execPath, [fixture], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const response = new Promise<{ ok: boolean; assertion: string; error?: string }>(
      (resolve, reject) => {
        let out = "";
        p.stdout.on("data", (b) => {
          out += b;
          if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0] ?? ""));
        });
        p.once("error", reject);
      },
    );
    p.stdin.end(
      `${JSON.stringify({
        mode: "owner",
        infraDir: root,
        role: "ops-agent",
        admitted,
        child: { ...plan, childPublicKey: "" },
        fixedId: randomUUID(),
        prepared,
      })}\n`,
    );
    const owned = await response;
    try {
      expect(owned, JSON.stringify(owned)).toMatchObject({ ok: true });
    } finally {
      const exited = new Promise<void>((resolve) => {
        if (p.exitCode !== null) resolve();
        else p.once("exit", () => resolve());
      });
      p.kill("SIGKILL");
      await exited;
    }
    const observed = await child({
      mode: "helper",
      infraDir: root,
      assertion: owned.assertion,
      execution: helper,
    });
    expect(observed, JSON.stringify(observed)).toMatchObject({ ok: prepared });
  },
);
it("keeps paired-pin approval a one-use leaf under its original activation root", async () => {
  const c = await import("./control-authority");
  const operation = { kind: "catalog.activate", validationId: randomUUID() };
  const execution = ref("data-manager", operation.kind, operation);
  const body = {
    kind: "transitousLock.approve" as const,
    ref: `main@${"a".repeat(40)}`,
    approvedBy: "synthetic-reviewer",
  };
  const childRef = ref("ops-agent", body.kind, body, execution, "paired-pin-commit");
  // The current legacy kind has a 30 s budget and stays closed in the real adapter.
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
  const authority = c.retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
  const key = JSON.parse(readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"))
    .publicKeys["ops-agent"];
  const assertion = await delegateArtifactTargetLease(lease, { ...plan, childPublicKey: key });
  const input = {
    primitive: true,
    infraDir: root,
    role: "ops-agent",
    assertion,
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
  await expect(
    delegateArtifactTargetLease(lease, { ...plan, childPublicKey: key }),
  ).rejects.toThrow(/replay/);
  c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await settleArtifactTargetLeaseChild(
    lease,
    c.verifyControlEffectSettlement(installation, execution),
  );
  await releaseArtifactTargetLease(lease);
  c.closeControlInstallation(installation);
});
it("settles the logical configuration-fence leaf without releasing the maintenance owner", async () => {
  const c = await import("./control-authority");
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
  const authority = c.retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
  const key = JSON.parse(readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"))
    .publicKeys["data-manager"];
  const assertion = await delegateArtifactTargetLease(lease, { ...plan, childPublicKey: key });
  const envelope = JSON.parse(Buffer.from(assertion, "base64url").toString("utf8"));
  const forged = Buffer.from(JSON.stringify({ ...envelope, signature: "a".repeat(86) })).toString(
    "base64url",
  );
  const foreign = Buffer.from(
    JSON.stringify({ ...envelope, installationId: randomUUID() }),
  ).toString("base64url");
  const input = {
    infraDir: root,
    role: "data-manager",
    assertion,
    execution: childRef,
    kind: body.kind,
    operation: body,
    admittedAt: childRef.deadlineAt - 60000,
  };
  expect(await child({ ...input, assertion: forged })).toMatchObject({ ok: false });
  expect(await child({ ...input, assertion: foreign })).toMatchObject({ ok: false });
  expect(await child({ ...input, settle: true })).toMatchObject({ ok: true });
  await expect(releaseArtifactTargetLease(lease)).rejects.toThrow(/settlement/);
  c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await settleArtifactTargetLeaseChild(
    lease,
    c.verifyControlEffectSettlement(installation, execution),
  );
  await releaseArtifactTargetLease(lease);
  c.closeControlInstallation(installation);
});

it("serializes a paused observer and a newer writer across actual processes", async () => {
  const c = await import("./control-authority");
  const l = await import("./target-lease");
  const fs = await import("node:fs");
  const operation = { kind: "transit-sync" };
  const execution = ref("data-manager", operation.kind, operation);
  const body = { kind: "motis.primary.stop" };
  const receiver = ref("ops-agent", body.kind, body, execution, "stop-primary");
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["motis"],
  });
  const plan: ControlPlannedChild = {
    phase: "stop-primary",
    ordinal: 0,
    kind: body.kind,
    execution: receiver,
    serviceIds: ["motis"],
    recipient: "ops-agent",
  };
  const authority = c.retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    operation,
    kind: operation.kind,
    admittedAt: execution.deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await l.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
  const publicKey = JSON.parse(readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"))
    .publicKeys["ops-agent"];
  const assertion = await l.delegateArtifactTargetLease(lease, {
    ...plan,
    childPublicKey: publicKey,
  });
  const ready = join(root, "observer-ready"),
    resume = join(root, "observer-resume");
  const observing = child({
    mode: "observe-interleaving",
    infraDir: root,
    assertion,
    ready,
    resume,
  });
  let busy = false;
  try {
    await expect.poll(() => fs.existsSync(ready)).toBe(true);
    try {
      await l.cancelArtifactTargetLease(lease);
    } catch (error) {
      busy = /writer.*busy/.test(String(error));
    }
  } finally {
    fs.writeFileSync(resume, "resume");
  }
  expect(await observing).toMatchObject({ ok: true });
  expect(busy, "observer must hold the same CAS guard as the writer").toBe(true);
  const ownerPath = join(root, `data/.admin-target-control/leases/${lease.leaseId}/owner.json`);
  const old = readFileSync(ownerPath);
  await l.cancelArtifactTargetLease(lease);
  const mark = JSON.parse(
    readFileSync(
      join(root, `control-private/data-manager/observations/${lease.leaseId}.json`),
      "utf8",
    ),
  );
  expect(mark.owner.sequence).toBe(JSON.parse(readFileSync(ownerPath, "utf8")).payload.sequence);
  fs.writeFileSync(ownerPath, old);
  expect(() =>
    l.inspectArtifactDelegation({ dataRoot: join(root, "data"), assertion, installation }),
  ).toThrow(/rollback/);
  l.closeArtifactTargetLeaseHandle(lease);
  c.closeControlInstallation(installation);
});

describe("renewable retention with independent processes", () => {
  it("inherits origin through a deadline-only independent lease and retains an offline participant while unrelated families renew", async () => {
    const c = await import("./control-authority"),
      { admittedRoot, terminalWithoutEffect } = await import("./test-fixtures/authority");
    const operation = { kind: "data.update" as const },
      execution = ref("ops-agent", operation.kind, operation),
      childOperation = { kind: "download-osm", regionId: "europe/germany" };
    const leaf = ref("data-manager", childOperation.kind, childOperation, execution, "osm"),
      installation = c.openControlInstallation({
        infraDir: root,
        role: "ops-agent",
        serviceIds: ["osrm"],
      });
    const plan = {
      phase: "osm" as const,
      ordinal: 0,
      kind: childOperation.kind,
      execution: leaf,
      serviceIds: ["osrm"],
      recipient: "data-manager" as const,
    };
    const authority = c.retainAdmittedControlExecution(installation, {
      execution,
      operation,
      kind: operation.kind,
      admittedAt: execution.deadlineAt - 60000,
      requestedDeadlineAt: execution.deadlineAt,
      serviceIds: ["osrm"],
      plan: [plan],
    });
    const key = JSON.parse(readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"))
      .publicKeys["data-manager"];
    const assertion = await c.attestParentExecution(authority, { ...plan, childPublicKey: key });
    const adopted = await child({
      mode: "deadline-lease",
      infraDir: root,
      role: "data-manager",
      assertion,
      execution: leaf,
      operation: childOperation,
      admittedAt: leaf.deadlineAt - 60000,
    });
    expect(adopted, JSON.stringify(adopted)).toMatchObject({
      ok: true,
      origin: {
        rootKey: execution.operationKey,
        issuer: "ops-agent",
        notAfter: execution.deadlineAt,
      },
    });
    terminalWithoutEffect(authority);
    c.closeControlInstallation(installation);
    const unrelated = admittedRoot(root, "ops-agent");
    terminalWithoutEffect(unrelated.authority);
    c.closeControlInstallation(unrelated.installation);
    const now = unrelated.execution.deadlineAt + 96 * 3600_000,
      gc = (role: string) =>
        child({
          mode: "retention",
          infraDir: root,
          role,
          now,
          maxFamilies: 1,
          assertPrivateRole: true,
        });
    expect(await gc("ops-agent")).toMatchObject({ retired: 0, pending: 1 });
    expect(await gc("ops-agent")).toMatchObject({ retired: 1, pending: 0 });
    expect(
      readFileSync(
        join(root, `control-private/data-manager/executions/${leaf.operationKey}.json`),
        "utf8",
      ),
    ).toContain(leaf.operationKey);
    let retired = 0;
    for (let n = 0; n < 12 && retired < 2; n++) {
      const a = await gc("data-manager"),
        b = await gc("ops-agent");
      retired += (a.retired ?? 0) + (b.retired ?? 0);
    }
    expect(retired).toBe(2);
    expect(
      (await import("node:fs")).existsSync(
        join(root, `control-private/data-manager/executions/${leaf.operationKey}.json`),
      ),
    ).toBe(false);
    expect(
      (await import("node:fs")).existsSync(
        join(root, `control-private/ops-agent/executions/${execution.operationKey}.json`),
      ),
    ).toBe(false);
  }, 120000);
  it.each(["planned", "unlinked", "counted", "item_done"])(
    "resumes contained failure after durable %s without double decrement",
    async (phase) => {
      const { admittedRoot, terminalWithoutEffect } = await import("./test-fixtures/authority");
      const f = admittedRoot(root);
      terminalWithoutEffect(f.authority);
      closeControlInstallation(f.installation);
      const now = f.execution.deadlineAt + 96 * 3600_000;
      const first = await child({ mode: "retention", infraDir: root, now, fault: phase });
      expect(first.injected).toBe(true);
      expect(first.retired).toBe(0);
      const again = await child({ mode: "retention", infraDir: root, now });
      expect(
        again.retired,
        again.retired === 1
          ? undefined
          : readFileSync(
              join(root, "control-private/host-cli/retention-families/slot-0/progress.json"),
              "utf8",
            ).trim(),
      ).toBe(1);
      const counter = JSON.parse(
        readFileSync(join(root, "control-private/host-cli/executions/.retention-count"), "utf8"),
      );
      expect(counter.count).toBe(0);
      const restarted = openControlInstallation({
        infraDir: root,
        role: "host-cli",
        serviceIds: ["motis", "osrm"],
      });
      expect(() =>
        retainAdmittedControlExecution(restarted, {
          execution: f.execution,
          operation: f.operation,
          kind: f.operation.kind,
          admittedAt: f.execution.deadlineAt - 60000,
          requestedDeadlineAt: f.execution.deadlineAt,
          serviceIds: ["osrm"],
        }),
      ).toThrow(/clock|expired/i);
      closeControlInstallation(restarted);
    },
    60000,
  );
  it("cannot release a reused family slot through its old inode/generation transaction", async () => {
    const { admittedRoot, terminalWithoutEffect } = await import("./test-fixtures/authority"),
      c = await import("./control-authority");
    const first = admittedRoot(root);
    terminalWithoutEffect(first.authority);
    c.closeControlInstallation(first.installation);
    const now = first.execution.deadlineAt + 96 * 3600_000;
    expect(
      await child({ mode: "retention", infraDir: root, now, fault: "slot_planned" }),
    ).toMatchObject({ retired: 0, injected: true });
    const journal = readFileSync(
      join(root, "control-private/host-cli/retention-slot-transaction.json"),
      "utf8",
    );
    expect(await child({ mode: "retention", infraDir: root, now })).toMatchObject({ retired: 1 });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now),
      replacement = admittedRoot(root);
    try {
      writeFileSync(
        join(root, "control-private/host-cli/retention-slot-transaction.json"),
        journal,
      );
      await expect(c.reconcileControlRetention(replacement.installation)).rejects.toThrow(
        /slot.*(inode|generation).*replaced/i,
      );
      expect(
        readFileSync(
          join(
            root,
            `control-private/host-cli/executions/${replacement.execution.operationKey}.json`,
          ),
          "utf8",
        ),
      ).toContain(replacement.execution.operationKey);
      expect(
        JSON.parse(
          readFileSync(join(root, "control-private/host-cli/executions/.retention-count"), "utf8"),
        ).count,
      ).toBe(1);
    } finally {
      clock.mockRestore();
      c.closeControlInstallation(replacement.installation);
    }
  }, 60000);
  it("does not steal an unknown killed namespace writer or release its family", async () => {
    const { admittedRoot, terminalWithoutEffect } = await import("./test-fixtures/authority");
    const f = admittedRoot(root);
    terminalWithoutEffect(f.authority);
    closeControlInstallation(f.installation);
    const now = f.execution.deadlineAt + 96 * 3600_000,
      p = spawn(process.execPath, [fixture], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    p.stdout.on("data", (b) => (output += b));
    p.stdin.end(
      `${JSON.stringify({ mode: "retention", infraDir: root, now, fault: "unlinked", kill: true })}\n`,
    );
    await vi.waitFor(() => expect(output).toContain('"ready":true'), { timeout: 30000 });
    p.kill("SIGKILL");
    await new Promise((resolve) => p.once("exit", resolve));
    const again = await child({ mode: "retention", infraDir: root, now });
    expect(again).toMatchObject({ retired: 0, pending: 1 });
    expect(
      readFileSync(
        join(root, "control-private/host-cli/executions/.retention-transaction"),
        "utf8",
      ),
    ).toContain('"phase":"unlinked"');
  }, 60000);
  it("advances a bounded round-robin cursor beyond an older unresolved family", async () => {
    const { admittedRoot, terminalWithoutEffect } = await import("./test-fixtures/authority");
    const unknown = admittedRoot(root),
      done = admittedRoot(root);
    terminalWithoutEffect(done.authority);
    closeControlInstallation(unknown.installation);
    closeControlInstallation(done.installation);
    const now = done.execution.deadlineAt + 96 * 3600_000;
    expect(await child({ mode: "retention", infraDir: root, now })).toMatchObject({
      retired: 0,
      pending: 1,
    });
    const next = await child({ mode: "retention", infraDir: root, now });
    expect(
      next,
      next.retired === 1
        ? undefined
        : readFileSync(
            join(root, "control-private/host-cli/retention-families/slot-1/progress.json"),
            "utf8",
          ).trim(),
    ).toMatchObject({ retired: 1, pending: 0 });
    expect(
      readFileSync(
        join(root, `control-private/host-cli/executions/${unknown.execution.operationKey}.json`),
        "utf8",
      ),
    ).toContain(unknown.execution.operationKey);
  }, 60000);
});
