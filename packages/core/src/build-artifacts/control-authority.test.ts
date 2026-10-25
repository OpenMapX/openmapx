import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-control-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function api() {
  expect(
    existsSync(join(import.meta.dirname, "control-authority.ts")),
    "missing role-private certified control authority",
  ).toBe(true);
  return import("./control-authority");
}
it("provisions three distinct role keys durably and reuses the exact installation", async () => {
  const a = await api();
  await a.provisionControlInstallation(root);
  const before = readFileSync(join(root, "secrets/control-ops-agent.key"));
  await a.provisionControlInstallation(root);
  expect(readFileSync(join(root, "secrets/control-ops-agent.key"))).toEqual(before);
  const bundle = JSON.parse(readFileSync(join(root, "secrets/control-verifiers.json"), "utf8"));
  expect(new Set(Object.values(bundle.publicKeys)).size).toBe(3);
  expect(existsSync(join(root, "data/control-private"))).toBe(false);
});
it("never silently regenerates missing trust or accepts a linked role key", async () => {
  const a = await api();
  await a.provisionControlInstallation(root);
  rmSync(join(root, "secrets/control-verifiers.json"));
  await expect(a.provisionControlInstallation(root)).rejects.toThrow(/trust|verifier|installation/);
});
it.each(["permissions", "hardlink", "symlink"])("rejects unsafe role key %s", async (mode) => {
  const a = await api();
  await a.provisionControlInstallation(root);
  const path = join(root, "secrets/control-ops-agent.key");
  if (mode === "permissions") chmodSync(path, 0o644);
  if (mode === "hardlink") linkSync(path, join(root, "copy"));
  if (mode === "symlink") {
    const bytes = readFileSync(path);
    rmSync(path);
    writeFileSync(join(root, "copy"), bytes, { mode: 0o600 });
    symlinkSync(join(root, "copy"), path);
  }
  expect(() => a.openControlInstallation({ infraDir: root, role: "ops-agent" })).toThrow();
});
it("rejects role-key substitution even with the same UID and valid Ed25519 key", async () => {
  const a = await api();
  await a.provisionControlInstallation(root);
  writeFileSync(
    join(root, "secrets/control-ops-agent.key"),
    readFileSync(join(root, "secrets/control-data-manager.key")),
  );
  expect(() => a.openControlInstallation({ infraDir: root, role: "ops-agent" })).toThrow(
    /role|key|trust/,
  );
});
it("provides deadline-only role attestations without target ownership", async () => {
  const module = await api();
  expect(module).toHaveProperty("attestParentExecution");
  expect(module).toHaveProperty("verifyParentExecution");
});
it("rejects duplicate control headers and the aggregate header budget", async () => {
  const a = await api();
  expect(() =>
    a.controlHeaders([
      "X-OpenMapx-Control-Delegation",
      "one",
      "x-openmapx-control-delegation",
      "two",
    ]),
  ).toThrow(/Duplicate/);
  expect(() => a.controlHeaders(["x-openmapx-parent-execution", "x".repeat(4097)])).toThrow(
    /limit/,
  );
});
it("retains deadline-only attempts separately from execution witnesses", async () => {
  const a = await api();
  const { randomUUID } = await import("node:crypto");
  const { executionFingerprint } = await import("../ops/execution-identity");
  const { opsOperationFingerprint } = await import("../ops/fingerprint");
  await a.provisionControlInstallation(root);
  const installation = a.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["osrm"],
  });
  const operation = { kind: "data.update" as const };
  const deadlineAt = Date.now() + 60000;
  const operationFingerprint = opsOperationFingerprint(operation);
  const parent = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: `job1_${randomUUID().replaceAll("-", "")}`,
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const body = { kind: "download-osm", regionId: "europe/germany" };
  const hash = a.controlDigest(body);
  const child = {
    executor: "data-manager" as const,
    principal: "data-manager" as const,
    executionId: randomUUID(),
    operationKey: a.controlChildOperationKey(parent.operationKey, "osm", 0),
    operationFingerprint: hash,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: body.kind,
      operationFingerprint: hash,
      deadlineAt,
      parent: a.retainedControlParent(parent),
    }),
  };
  const plan = {
    phase: "osm" as const,
    ordinal: 0,
    kind: body.kind,
    execution: child,
    serviceIds: ["osrm"],
    recipient: "data-manager" as const,
  };
  const authority = a.retainAdmittedControlExecution(installation, {
    execution: parent,
    operation,
    kind: operation.kind,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["osrm"],
    plan: [plan],
  });
  const receiver = a.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["osrm"],
  });
  const assertion = await a.attestParentExecution(authority, {
    ...plan,
    childPublicKey: receiver.publicKey,
  });
  const peer = a.verifyControlPeer(receiver, {
    rawHeaders: ["x-openmapx-parent-execution", assertion],
    transportPrincipal: "shared-data-manager-bearer",
    execution: child,
    kind: body.kind,
  });
  expect(
    a.verifyParentExecution(assertion, peer, {
      execution: child,
      kind: body.kind,
      requestedDeadlineAt: deadlineAt,
    }),
  ).toMatchObject({ operationKey: parent.operationKey });
  await expect(
    a.attestParentExecution(authority, { ...plan, childPublicKey: receiver.publicKey }),
  ).rejects.toThrow(/replay/);
  a.closeControlInstallation(receiver);
  a.closeControlInstallation(installation);
});
it("service mounts keep same-UID sibling role material outside the shared mount", () => {
  const repo = join(import.meta.dirname, "../../../..");
  const agent = JSON.parse(readFileSync(join(repo, "services/ops-agent/service.json"), "utf8"));
  const dm = JSON.parse(readFileSync(join(repo, "services/data-manager/service.json"), "utf8"));
  for (const [role, manifest] of [
    ["ops-agent", agent],
    ["data-manager", dm],
  ] as const) {
    expect(manifest.bindMounts).toContainEqual({
      source: `@infra:secrets/control-${role}.key`,
      target: "/run/secrets/openmapx-control-role-key",
      readOnly: true,
    });
    expect(manifest.bindMounts).toContainEqual({
      source: `@infra:control-private/${role}`,
      target: "/var/lib/openmapx/control-private",
      readOnly: false,
    });
    expect(
      manifest.bindMounts.some(
        (m: { source: string }) =>
          m.source ===
          `@infra:control-private/${role === "ops-agent" ? "data-manager" : "ops-agent"}`,
      ),
    ).toBe(false);
  }
  for (const role of ["data-manager", "host-cli"]) {
    expect(
      agent.bindMounts.some(
        (m: { source: string; target: string; readOnly: boolean }) =>
          m.source === "@infra:control-private/hidden-key" &&
          m.target.endsWith(`/secrets/control-${role}.key`) &&
          m.readOnly,
      ),
    ).toBe(true);
    expect(
      agent.bindMounts.some(
        (m: { source: string; target: string; readOnly: boolean }) =>
          m.source === "@infra:control-private/empty" &&
          m.target.endsWith(`/control-private/${role}`) &&
          m.readOnly,
      ),
    ).toBe(true);
  }
});
it("verifies the certified ephemeral fixed-CLI deadline chain without exporting a role key", async () => {
  const c = await api();
  const { randomUUID } = await import("node:crypto");
  const { executionFingerprint } = await import("../ops/execution-identity");
  const { opsOperationFingerprint } = await import("../ops/fingerprint");
  await c.provisionControlInstallation(root);
  const agent = c.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["osrm"],
  });
  const dm = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["osrm"],
  });
  const deadlineAt = Date.now() + 60000;
  const operation = { kind: "data.update" as const };
  const hash = opsOperationFingerprint(operation);
  const execution = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: `job1_${randomUUID().replaceAll("-", "")}`,
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint: hash,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint: hash,
      deadlineAt,
    }),
  };
  const cli = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey: c.controlChildOperationKey(execution.operationKey, "data-workflow", 0),
    operationFingerprint: hash,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint: hash,
      deadlineAt,
      parent: c.retainedControlParent(execution),
    }),
  };
  const body = { kind: "download-osm", regionId: "europe/germany" };
  const childHash = c.controlDigest(body);
  const child = {
    executor: "data-manager" as const,
    principal: "data-manager" as const,
    executionId: randomUUID(),
    operationKey: c.controlChildOperationKey(cli.operationKey, "osm", 0),
    operationFingerprint: childHash,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: body.kind,
      operationFingerprint: childHash,
      deadlineAt,
      parent: c.retainedControlParent(cli),
    }),
  };
  const planned = {
    phase: "data-workflow" as const,
    ordinal: 0,
    kind: operation.kind,
    execution: cli,
    serviceIds: ["osrm"],
    recipient: "fixed-cli" as const,
  };
  const leaf = {
    phase: "osm" as const,
    ordinal: 0,
    kind: body.kind,
    execution: child,
    serviceIds: ["osrm"],
    recipient: "data-manager" as const,
  };
  const authority = c.retainAdmittedControlExecution(agent, {
    execution,
    kind: operation.kind,
    operation,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["osrm"],
    plan: [planned],
  });
  const id = randomUUID();
  const publicKey = c.prepareFixedControlChild(authority, id);
  // Unrelated retained keys must never be enumerated or parsed to find this
  // exact certified challenge. These unreadable historical fixtures expose a scan.
  for (let i = 0; i < 128; i++)
    writeFileSync(
      join(root, `control-private/ops-agent/children/retained-${i}.key`),
      "historical",
      { mode: 0o600 },
    );
  const assertion = await c.attestParentExecution(authority, {
    ...planned,
    childPublicKey: publicKey,
  });
  const args = c.fixedCliArguments(operation);
  c.retainFixedCliSpawnIntent(authority, {
    delegationId: id,
    execution: cli,
    operation,
    args,
    plan: [leaf],
  });
  const fixed = c.openFixedChildInstallation({ infraDir: root, assertion });
  expect(fixed.publicKey).not.toBe(agent.publicKey);
  const intent = c.readFixedCliSpawnIntent(fixed, cli, args);
  const peer = c.verifyFixedCliControlPeer(fixed, {
    assertion,
    execution: cli,
    kind: operation.kind,
  });
  const parent = c.verifyParentExecution(assertion, peer, {
    execution: cli,
    kind: operation.kind,
    requestedDeadlineAt: deadlineAt,
  });
  const cliAuthority = c.retainAdmittedControlExecution(fixed, {
    execution: cli,
    kind: operation.kind,
    operation,
    admittedAt: intent.admittedAt,
    parent,
    serviceIds: intent.serviceIds,
    plan: intent.plan,
  });
  const next = await c.attestParentExecution(cliAuthority, {
    ...leaf,
    childPublicKey: dm.publicKey,
  });
  const dmPeer = c.verifyControlPeer(dm, {
    rawHeaders: ["x-openmapx-parent-execution", next],
    transportPrincipal: "shared-data-manager-bearer",
    execution: child,
    kind: body.kind,
  });
  expect(
    c.verifyParentExecution(next, dmPeer, {
      execution: child,
      kind: body.kind,
      requestedDeadlineAt: deadlineAt,
    }),
  ).toMatchObject({ operationKey: cli.operationKey });
  c.cancelControlExecution(authority);
  expect(() => c.assertControlExecutionForward(cliAuthority)).toThrow(/ancestor|observation/);
  expect(
    c.verifyParentExecution(next, dmPeer, {
      execution: child,
      kind: body.kind,
      requestedDeadlineAt: deadlineAt,
    }),
  ).toMatchObject({ operationKey: cli.operationKey });
  c.closeControlInstallation(fixed);
  c.closeControlInstallation(dm);
  c.closeControlInstallation(agent);
});

async function deadlineFamily() {
  const c = await api();
  const { randomUUID } = await import("node:crypto");
  const { executionFingerprint } = await import("../ops/execution-identity");
  const { opsOperationFingerprint } = await import("../ops/fingerprint");
  await c.provisionControlInstallation(root);
  const agent = c.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["osrm"],
  });
  const dm = c.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["osrm"],
  });
  const operation = { kind: "data.update" as const };
  const deadlineAt = Date.now() + 60000;
  const operationFingerprint = opsOperationFingerprint(operation);
  const execution = {
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: `job1_${randomUUID().replaceAll("-", "")}`,
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const hash = c.controlDigest({ kind: "download-osm", regionId: "europe/germany" });
  const child = {
    executor: "data-manager" as const,
    principal: "data-manager" as const,
    executionId: randomUUID(),
    operationKey: c.controlChildOperationKey(execution.operationKey, "osm", 0),
    operationFingerprint: hash,
    deadlineAt,
    fingerprint: executionFingerprint({
      kind: "download-osm",
      operationFingerprint: hash,
      deadlineAt,
      parent: c.retainedControlParent(execution),
    }),
  };
  const plan = {
    phase: "osm" as const,
    ordinal: 0,
    kind: "download-osm",
    execution: child,
    serviceIds: ["osrm"],
    recipient: "data-manager" as const,
  };
  const authority = c.retainAdmittedControlExecution(agent, {
    execution,
    operation,
    kind: operation.kind,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["osrm"],
    plan: [plan],
  });
  const grant = () => c.attestParentExecution(authority, { ...plan, childPublicKey: dm.publicKey });
  const admit = (assertion: string) =>
    c.verifyParentExecution(
      assertion,
      c.verifyControlPeer(dm, {
        rawHeaders: ["x-openmapx-parent-execution", assertion],
        transportPrincipal: "shared-data-manager-bearer",
        execution: child,
        kind: plan.kind,
      }),
      { execution: child, kind: plan.kind, requestedDeadlineAt: deadlineAt },
    );
  return { c, agent, dm, authority, execution, child, grant, admit };
}
it("terminal deadline-only parent cannot mint an unattempted child", async () => {
  const f = await deadlineFamily();
  try {
    f.c.retainControlEffectReceipt(f.authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await expect(f.grant()).rejects.toThrow(/terminal|settled|forward/);
  } finally {
    f.c.closeControlInstallation(f.dm);
    f.c.closeControlInstallation(f.agent);
  }
});
it("terminal deadline-only parent fences a previously attempted unadopted grant", async () => {
  const f = await deadlineFamily();
  try {
    const assertion = await f.grant();
    f.c.retainControlEffectReceipt(f.authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    expect(() => f.admit(assertion)).toThrow(/terminal|observation/);
    expect(existsSync(join(root, "data/.admin-target-control/locks"))).toBe(false);
  } finally {
    f.c.closeControlInstallation(f.dm);
    f.c.closeControlInstallation(f.agent);
  }
});
it.each([false, true])(
  "canceled deadline-only parent fences unadopted attempts (attempted: %s)",
  async (attempted) => {
    const f = await deadlineFamily();
    try {
      const assertion = attempted ? await f.grant() : undefined;
      const children = f.c.cancelControlExecution(f.authority);
      expect(children).toHaveLength(attempted ? 1 : 0);
      if (assertion) expect(() => f.admit(assertion)).toThrow(/cancel|forward|observation/);
      else await expect(f.grant()).rejects.toThrow(/cancel|forward/);
      expect(() => f.c.beginControlEffect(f.authority)).toThrow(/cancel|forward/);
    } finally {
      f.c.closeControlInstallation(f.dm);
      f.c.closeControlInstallation(f.agent);
    }
  },
);
it("retained deadline-only duplicates observe after cancellation but cannot start work", async () => {
  const f = await deadlineFamily();
  try {
    const assertion = await f.grant();
    const parent = f.admit(assertion);
    f.c.cancelControlExecution(f.authority);
    expect(f.admit(assertion)).toEqual(parent);
    const body = { kind: "download-osm", regionId: "europe/germany" };
    const authority = f.c.retainAdmittedControlExecution(f.dm, {
      execution: f.child,
      operation: body,
      kind: body.kind,
      admittedAt: f.execution.deadlineAt - 60000,
      parent,
      serviceIds: ["osrm"],
    });
    expect(() => f.c.beginControlEffect(authority)).toThrow(/cancel|forward|observation/);
    const { acquireArtifactTargetLease } = await import("./target-lease");
    await expect(
      acquireArtifactTargetLease({
        dataRoot: join(root, "data"),
        serviceIds: ["osrm"],
        owner: authority,
      }),
    ).rejects.toThrow(/cancel|ancestor|observation/);
  } finally {
    f.c.closeControlInstallation(f.dm);
    f.c.closeControlInstallation(f.agent);
  }
});

it("refuses exhausted private admission capacity before publishing a witness or effect", async () => {
  const f = await deadlineFamily();
  const { CONTROL_RETENTION_LIMITS } = await import("./control-retention");
  try {
    // A durable consumed-reservation fixture, not a mocked authorization decision.
    const count = join(root, "control-private/ops-agent/executions/.retention-count");
    writeFileSync(count, String(CONTROL_RETENTION_LIMITS.executionsPerRole), { mode: 0o600 });
    const replacement = { ...f.execution, operationKey: `opk1_${"z".repeat(32)}` };
    expect(() =>
      f.c.retainAdmittedControlExecution(f.agent, {
        execution: replacement,
        operation: { kind: "data.update" },
        kind: "data.update",
        admittedAt: replacement.deadlineAt - 60000,
        serviceIds: ["osrm"],
      }),
    ).toThrow(/capacity/);
    expect(
      existsSync(
        join(
          root,
          `data/.admin-target-control/executions/ops-agent/${replacement.operationKey}.json`,
        ),
      ),
    ).toBe(false);
    // Capacity is admission-only: existing exact identity and settlement stay available.
    f.c.retainControlEffectReceipt(f.authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    expect(() => f.c.verifyControlEffectSettlement(f.agent, f.execution)).not.toThrow();
  } finally {
    f.c.closeControlInstallation(f.dm);
    f.c.closeControlInstallation(f.agent);
  }
});
it("expired exact deadline-only adoption stays observable without renewing one-use work", async () => {
  const f = await deadlineFamily();
  const { vi } = await import("vitest");
  try {
    const assertion = await f.grant();
    const admitted = f.admit(assertion);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(f.execution.deadlineAt + 96 * 60 * 60 * 1000);
    try {
      expect(f.admit(assertion)).toEqual(admitted);
      await expect(f.grant()).rejects.toThrow(/Expired/);
      expect(
        existsSync(
          join(root, `control-private/ops-agent/executions/${f.execution.operationKey}.json`),
        ),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
  } finally {
    f.c.closeControlInstallation(f.dm);
    f.c.closeControlInstallation(f.agent);
  }
});
