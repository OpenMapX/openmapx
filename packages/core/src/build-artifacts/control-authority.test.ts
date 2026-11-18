import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { afterEach, beforeEach, expect, it } from "vitest";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-control-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
});
it("renewal refuses an expired timed root after all original identity details were reclaimed", async () => {
  const c = await api();
  const { randomUUID } = await import("node:crypto");
  const { executionFingerprint } = await import("../ops/execution-identity");
  const { opsOperationFingerprint } = await import("../ops/fingerprint");
  await c.provisionControlDirectories(root);
  const installation = c.openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["osrm"],
  });
  const operation = { kind: "service.build" as const, serviceId: "osrm" };
  const hash = opsOperationFingerprint(operation);
  const expiredAt = Date.now() - 96 * 3600_000;
  const operationKey = `opk1_t1_${expiredAt.toString(16).padStart(14, "0")}_AAAAAAAAAAAAAAAAAAAAAA`;
  const currentDeadline = Date.now() + 60000;
  // The old implementation accepts this exact expired timed key with a freshly
  // normalized deadline, even with no historical receipt left to find.
  const execution = {
    executor: "host-cli" as const,
    principal: "host-cli" as const,
    executionId: randomUUID(),
    operationKey,
    operationFingerprint: hash,
    deadlineAt: currentDeadline,
    fingerprint: executionFingerprint({
      kind: operation.kind,
      operationFingerprint: hash,
      deadlineAt: currentDeadline,
    }),
  };
  try {
    expect(() =>
      c.retainAdmittedControlExecution(installation, {
        execution,
        operation,
        kind: operation.kind,
        admittedAt: currentDeadline - 60000,
        requestedDeadlineAt: expiredAt,
        serviceIds: ["osrm"],
      }),
    ).toThrow(/expired|expiry|deadline/i);
    expect(existsSync(join(root, `state/host-cli/control/executions/${operationKey}.json`))).toBe(
      false,
    );
  } finally {
    c.closeControlInstallation(installation);
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function api() {
  return import("./control-authority");
}
it("provisions each role's private records under its own state directory", async () => {
  const a = await api();
  a.provisionControlDirectories(root);
  a.provisionControlDirectories(root);
  for (const role of ["ops-agent", "data-manager", "host-cli"] as const)
    expect(existsSync(a.controlPrivateRoot(root, role))).toBe(true);
  expect(existsSync(join(root, "secrets"))).toBe(false);
});
it("lets data-manager admit a deadline-only child only from the agent's token", async () => {
  const f = await deadlineFamily();
  try {
    const delegation = await f.grant();
    // data-manager trusts the agent's token and the child it states.
    expect(f.admit(delegation)).toMatchObject({ operationKey: f.execution.operationKey });
    expect(() => f.c.inspectRemoteDelegation(f.dm, delegation, "host-cli")).toThrow(/mismatch/);
    expect(() =>
      f.c.inspectRemoteDelegation(f.dm, { ...delegation, phase: "hardlinks" }, "ops-agent"),
    ).toThrow(/mismatch/);
  } finally {
    f.c.closeControlInstallation(f.dm);
    f.c.closeControlInstallation(f.agent);
  }
});
it("service manifests mount no control keys and data-manager mounts only its own private records", () => {
  const repo = join(import.meta.dirname, "../../../..");
  const agent = readFileSync(join(repo, "services/ops-agent/service.json"), "utf8");
  const dm = JSON.parse(readFileSync(join(repo, "services/data-manager/service.json"), "utf8"));
  for (const text of [agent, JSON.stringify(dm)])
    expect(text).not.toMatch(/control-private|control-[a-z-]+\.key|control-verifiers/);
  expect(dm.bindMounts).toContainEqual({
    source: "@infra:state/data-manager/control",
    target: "/var/lib/openmapx/control",
    readOnly: false,
  });
});
it("lets a fixed CLI child without a lease follow its parent's lifecycle", async () => {
  const c = await api();
  const { randomUUID } = await import("node:crypto");
  const { executionFingerprint } = await import("../ops/execution-identity");
  const { opsOperationFingerprint } = await import("../ops/fingerprint");
  await c.provisionControlDirectories(root);
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
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
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
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["osrm"],
    plan: [planned],
  });
  const id = randomUUID();
  const args = c.fixedCliArguments(operation);
  c.retainFixedCliSpawnIntent(authority, {
    childKey: id,
    execution: cli,
    operation,
    args,
    plan: [leaf],
  });
  const delegation = await c.attestParentExecution(authority, { ...planned, childKey: id });
  expect(delegation).toMatchObject({ leaseId: null, childKey: id });
  const fixed = c.openFixedChildInstallation({
    infraDir: root,
    child: { leaseId: null, childKey: id },
  });
  expect(c.controlIdentity(fixed)).toBe(id);
  const intent = c.readFixedCliSpawnIntent(fixed, cli, args);
  const parent = c.verifiedRetainedControlParent(fixed, intent.parent);
  const cliAuthority = c.retainAdmittedControlExecution(fixed, {
    requestedDeadlineAt: cli.deadlineAt,
    execution: cli,
    kind: operation.kind,
    operation,
    admittedAt: intent.admittedAt,
    parent,
    serviceIds: intent.serviceIds,
    plan: intent.plan,
  });
  const next = await c.attestParentExecution(cliAuthority, leaf);
  const remoteParent = () => c.inspectRemoteDelegation(dm, next, "ops-agent").parent;
  expect(remoteParent()).toMatchObject({ operationKey: cli.operationKey });
  c.cancelControlExecution(authority);
  expect(() => c.assertControlExecutionForward(cliAuthority)).toThrow(/ancestor|observation/);
  // An exact retry of the admitted child stays readable after the cancellation.
  expect(remoteParent()).toMatchObject({ operationKey: cli.operationKey });
  c.closeControlInstallation(fixed);
  c.closeControlInstallation(dm);
  c.closeControlInstallation(agent);
});

async function deadlineFamily() {
  const c = await api();
  const phase = await import("./child-phase");
  const { randomUUID } = await import("node:crypto");
  const { executionFingerprint } = await import("../ops/execution-identity");
  const { opsOperationFingerprint } = await import("../ops/fingerprint");
  await c.provisionControlDirectories(root);
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
    operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    operationFingerprint,
    deadlineAt,
    fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
  };
  const reservation = {
    version: 1 as const,
    phase: "osm" as const,
    ordinal: 0,
    kind: "download-osm",
    recipient: "data-manager" as const,
    serviceIds: ["osrm"],
    operationFingerprint: c.controlDigest({ kind: "download-osm", regionId: "europe/germany" }),
    execution: {
      executor: "data-manager" as const,
      principal: "data-manager" as const,
      executionId: randomUUID(),
      operationKey: c.controlChildOperationKey(execution.operationKey, "osm", 0),
    },
  };
  const authority = c.retainAdmittedControlExecution(agent, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    operation,
    kind: operation.kind,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["osrm"],
    reservations: [reservation],
  });
  const grant = async () => {
    await phase.bindControlChildPhase(authority, reservation);
    return (await phase.issueControlChildPhase(authority, { phase: "osm", ordinal: 0 })).delegation;
  };
  const admit = (delegation: Awaited<ReturnType<typeof grant>>) =>
    c.inspectRemoteDelegation(dm, delegation, "ops-agent").parent;
  return { c, agent, dm, authority, execution, grant, admit };
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
it.each([false, true])(
  "canceled deadline-only parent returns its attempts and mints no more (attempted: %s)",
  async (attempted) => {
    const f = await deadlineFamily();
    try {
      if (attempted) await f.grant();
      // The parent cancels the returned children over data-manager's route.
      const children = f.c.cancelControlExecution(f.authority);
      expect(children).toHaveLength(attempted ? 1 : 0);
      await expect(f.grant()).rejects.toThrow(/cancel|forward|observation/);
      expect(() => f.c.beginControlEffect(f.authority)).toThrow(/cancel|forward/);
    } finally {
      f.c.closeControlInstallation(f.dm);
      f.c.closeControlInstallation(f.agent);
    }
  },
);

it("expired exact deadline-only adoption stays observable without renewing one-use work", async () => {
  const f = await deadlineFamily();
  const { vi } = await import("vitest");
  try {
    const delegation = await f.grant();
    const admitted = f.admit(delegation);
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(f.execution.deadlineAt + 96 * 60 * 60 * 1000);
    try {
      expect(f.admit(delegation)).toEqual(admitted);
      await expect(f.grant()).rejects.toThrow(/Expired|observation/);
      expect(
        existsSync(
          join(root, `state/ops-agent/control/executions/${f.execution.operationKey}.json`),
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
