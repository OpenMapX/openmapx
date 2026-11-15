import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFingerprint } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import {
  type ControlInstallation,
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  verifyControlEffectSettlement,
} from "./control-authority";

let root: string;
let installation: ControlInstallation;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "omx-target-"));
  mkdirSync(join(root, "data"), { mode: 0o700 });
  await provisionControlInstallation(root);
  installation = openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["osrm", "motis"],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});

it.each([18, 256])(
  "recovers release after target17 for %i maximum-length certified targets within the admission byte budget",
  async (count) => {
    const c = await import("./control-authority"),
      a = await api();
    const { AnchoredDirectory } = await import("./filesystem");
    const targets = Array.from(
      { length: count },
      (_, n) => `svc-${String(n).padStart(3, "0")}${"x".repeat(57)}`,
    );
    closeControlInstallation(installation);
    installation = openControlInstallation({
      infraDir: root,
      role: "host-cli",
      serviceIds: targets,
    });
    const serviceId = targets[0];
    if (!serviceId) throw Error("Missing test target");
    const operation = { kind: "service.build" as const, serviceId },
      operationFingerprint = opsOperationFingerprint(operation),
      deadlineAt = Date.now() + 120000;
    const execution = {
      executor: "host-cli" as const,
      principal: "host-cli" as const,
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
      deadlineAt,
    };
    const authority = retainAdmittedControlExecution(installation, {
      execution,
      kind: operation.kind,
      operation,
      admittedAt: deadlineAt - 120000,
      requestedDeadlineAt: deadlineAt,
      serviceIds: targets,
    });
    const admissionPath = join(
        root,
        `control-private/host-cli/executions/${execution.operationKey}.json`,
      ),
      admitted = readFileSync(admissionPath);
    const lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: targets,
      owner: authority,
    });
    retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await a.settleArtifactTargetLeaseChild(
      lease,
      verifyControlEffectSettlement(installation, execution),
    );
    const original = AnchoredDirectory.prototype.write;
    let interrupted = false,
      maximumBytes = 0;
    const fault = vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
      this: import("./filesystem").AnchoredDirectory,
      ...args
    ) {
      original.apply(this, args);
      if (args[0] !== "admission.json") return;
      maximumBytes = Math.max(maximumBytes, Buffer.byteLength(args[1]));
      const release = JSON.parse(args[1].toString()).payload.release;
      if (
        !interrupted &&
        (release?.completedTargets ?? release?.locks?.length) === 17 &&
        release.pending === undefined
      ) {
        interrupted = true;
        throw Error("contained stop after target17 publication");
      }
    });
    await expect(a.releaseArtifactTargetLease(lease)).rejects.toThrow(
      "contained stop after target17",
    );
    expect(interrupted).toBe(true);
    expect(
      targets
        .slice(0, 17)
        .every((id) => !existsSync(join(root, `data/.admin-target-control/locks/${id}`))),
    ).toBe(true);
    expect(existsSync(join(root, `data/.admin-target-control/locks/${targets[17]}`))).toBe(true);
    a.closeArtifactTargetLeaseHandle(lease);
    closeControlInstallation(installation);
    installation = openControlInstallation({
      infraDir: root,
      role: "host-cli",
      serviceIds: targets,
    });
    const restored = c.restoreAdmittedControlExecution(installation, execution),
      recovery = c.verifyControlRecoveryAuthority(restored);
    const input = { dataRoot: join(root, "data"), leaseId: lease.leaseId, authority: recovery };
    await expect(a.reconcileArtifactTargetLease(input)).resolves.toBe("released");
    await expect(a.reconcileArtifactTargetLease(input)).resolves.toBe("released");
    fault.mockRestore();
    expect(maximumBytes).toBeLessThanOrEqual(4096);
    const journalBytes = readFileSync(
      join(root, `data/.admin-target-control/leases/${lease.leaseId}/admission.json`),
    );
    expect(journalBytes.byteLength).toBeLessThanOrEqual(4096);
    const finalJournal = JSON.parse(journalBytes.toString()).payload;
    expect(finalJournal.release).toMatchObject({
      version: 2,
      phase: "released",
      completedTargets: count,
      active: true,
    });
    expect(
      existsSync(
        join(
          root,
          `data/.admin-target-control/admission-index-v1/active/${finalJournal.active.name}`,
        ),
      ),
    ).toBe(false);
    expect(
      targets.every((id) => !existsSync(join(root, `data/.admin-target-control/locks/${id}`))),
    ).toBe(true);
    expect(readFileSync(admissionPath)).toEqual(admitted);
    expect(
      JSON.parse(
        readFileSync(
          join(root, `control-private/host-cli/effect-started/${execution.operationKey}.json`),
          "utf8",
        ),
      ),
    ).toBeNull();
  },
  120000,
);
function owner() {
  const operation = { kind: "service.build" as const, serviceId: "osrm" };
  const operationFingerprint = opsOperationFingerprint(operation);
  const deadlineAt = Date.now() + 60000;
  return retainAdmittedControlExecution(installation, {
    requestedDeadlineAt: {
      executor: "host-cli",
      principal: "host-cli",
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
      deadlineAt,
    }.deadlineAt,
    execution: {
      executor: "host-cli",
      principal: "host-cli",
      executionId: randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
      operationFingerprint,
      fingerprint: executionFingerprint({ kind: operation.kind, operationFingerprint, deadlineAt }),
      deadlineAt,
    },
    kind: operation.kind,
    operation,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["osrm"],
  });
}
async function api() {
  return import("./target-lease");
}
it("distinguishes an occupied original journal guard before running its source check", async () => {
  const a = await api(),
    authority = owner(),
    lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    });
  const directory = join(root, "data/.admin-target-control/leases", lease.leaseId),
    guard = join(directory, ".journal-writer"),
    before = readFileSync(join(directory, "owner.json"));
  mkdirSync(guard, { mode: 0o700 });
  try {
    expect(() => a.assertArtifactTargetLeaseForward(lease)).toThrow(
      a.ArtifactTargetJournalBusyError,
    );
    expect(readFileSync(join(directory, "owner.json"))).toEqual(before);
    expect(existsSync(guard)).toBe(true);
  } finally {
    rmdirSync(guard);
  }
  a.assertArtifactTargetLeaseForward(lease);
  a.closeArtifactTargetLeaseHandle(lease);
});
describe("certified target leases", () => {
  it("requires nominal durable ownership, then fences unknown own effects", async () => {
    const a = await api();
    const authority = owner();
    await expect(
      a.acquireArtifactTargetLease({
        dataRoot: join(root, "data"),
        serviceIds: ["osrm"],
        owner: { execution: authority.execution } as typeof authority,
      }),
    ).rejects.toThrow(/authority/);
    const lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    });
    await expect(a.releaseArtifactTargetLease(lease)).rejects.toThrow(/settlement|effect/);
    expect(existsSync(join(root, "data/.admin-target-control/locks/osrm"))).toBe(true);
  });
  it("releases a certified target after durable no-effect settlement", async () => {
    const a = await api();
    const authority = owner();
    const lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    });
    retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await a.settleArtifactTargetLeaseChild(
      lease,
      verifyControlEffectSettlement(installation, authority.execution),
    );
    await a.releaseArtifactTargetLease(lease);
    expect(existsSync(join(root, "data/.admin-target-control/locks/osrm"))).toBe(false);
  });
  it("rejects replacement lock inodes without removing the replacement", async () => {
    const a = await api();
    const authority = owner();
    const lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    });
    const path = join(root, "data/.admin-target-control/locks/osrm");
    renameSync(path, `${path}.old`);
    mkdirSync(path, { mode: 0o700 });
    await expect(a.releaseArtifactTargetLease(lease)).rejects.toThrow(/inode|identity|changed/);
    expect(existsSync(path)).toBe(true);
  });
});
it("never reacquires or expands a retained execution's root", async () => {
  const a = await api();
  const authority = owner();
  await a.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["osrm"],
    owner: authority,
  });
  await expect(
    a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    }),
  ).rejects.toThrow(/already acquired/);
  await expect(
    a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["motis"],
      owner: authority,
    }),
  ).rejects.toThrow(/closure/);
});
it("detects rollback of a signed shared journal using private high-water evidence", async () => {
  const a = await api();
  const authority = owner();
  const lease = await a.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["osrm"],
    owner: authority,
  });
  const path = join(root, `data/.admin-target-control/leases/${lease.leaseId}/owner.json`);
  const previous = readFileSync(path);
  await a.cancelArtifactTargetLease(lease);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, previous);
  await expect(a.releaseArtifactTargetLease(lease)).rejects.toThrow(/rollback|replacement/);
});
it("rejects arbitrary caller text as effect evidence", async () => {
  const authority = owner();
  expect(() =>
    retainControlEffectReceipt(authority, {
      outcome: "committed",
      publication: "committed",
      receipt: "trust me",
    }),
  ).toThrow(/evidence|receipt/);
});
it("keeps a bare terminal maintenance summary fenced without the fixed owner source", async () => {
  const c = await import("./control-authority");
  const a = await api();
  const { writeFileSync } = await import("node:fs");
  const agent = c.openControlInstallation({
    infraDir: root,
    role: "ops-agent",
    serviceIds: ["motis", "osrm"],
  });
  const operation = {
    kind: "configurationMaintenance.prepare",
    maintenanceId: randomUUID(),
    candidateId: randomUUID(),
  };
  const operationFingerprint = c.controlDigest(operation);
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
  const { commitConfigurationGeneration } = await import("../services/configuration-generation"),
    generation = await commitConfigurationGeneration({
      infraDir: root,
      services: [],
      input: {
        domain: "example.test",
        selectedRoots: [],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      ownedServiceGenerations: [],
    });
  const body = {
    kind: "service.recreate" as const,
    serviceId: "motis",
    expectedConfigurationRevisionId: generation.revisionId,
  };
  const hash = opsOperationFingerprint(body);
  const child = {
    ...execution,
    executionId: `job1_${randomUUID().replaceAll("-", "")}`,
    operationKey: c.controlChildOperationKey(execution.operationKey, "maintenance-recreate", 0),
    operationFingerprint: hash,
    fingerprint: executionFingerprint({
      kind: body.kind,
      operationFingerprint: hash,
      deadlineAt,
      parent: c.retainedControlParent(execution),
    }),
  };
  const plan = {
    phase: "maintenance-recreate" as const,
    ordinal: 0,
    kind: body.kind,
    execution: child,
    serviceIds: ["motis"],
    recipient: "ops-agent" as const,
  };
  const authority = c.retainAdmittedControlExecution(agent, {
    requestedDeadlineAt: execution.deadlineAt,
    execution,
    kind: operation.kind,
    operation,
    admittedAt: deadlineAt - 60000,
    serviceIds: ["motis"],
    plan: [plan],
  });
  const lease = await a.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["motis"],
    owner: authority,
  });
  await expect(
    a.delegateArtifactTargetLease(lease, { ...plan, childPublicKey: agent.publicKey }),
  ).rejects.toThrow();
  mkdirSync(join(root, "state/ops-agent"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(root, "state/ops-agent/jobs-v1.json"),
    JSON.stringify({
      version: 2,
      jobs: [
        {
          operationId: execution.executionId,
          operationKey: execution.operationKey,
          operationFingerprint: execution.operationFingerprint,
          fingerprint: execution.fingerprint,
          deadlineAt,
          state: "succeeded",
          operation,
          result: { state: "prepared" },
          terminalAt: new Date().toISOString(),
        },
      ],
    }),
    { mode: 0o600 },
  );
  c.retainControlPreparedTerminal(authority);
  c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await expect(
    a.delegateArtifactTargetLease(lease, {
      ...plan,
      serviceIds: ["osrm"],
      childPublicKey: agent.publicKey,
    }),
  ).rejects.toThrow();
  // A private journal summary and ordinary own-effect settlement are not
  // the actual fixed candidate/owner/decision/guard closure source.
  await expect(
    a.delegateArtifactTargetLease(lease, { ...plan, childPublicKey: agent.publicKey }),
  ).rejects.toThrow();
  await expect(
    a.settleArtifactTargetLeaseChild(lease, c.verifyControlEffectSettlement(agent, execution)),
  ).rejects.toThrow();
  await expect(a.releaseArtifactTargetLease(lease)).rejects.toThrow();
  a.closeArtifactTargetLeaseHandle(lease);
  c.closeControlInstallation(agent);
});
it("holds certified target, configuration writer and release-store locks together", async () => {
  const { acquireConfigurationOwnership } = await import("../services/configuration-ownership");
  const { acquireReleaseStoreLock } = await import("../services/release-store-lock");
  const a = await api();
  const c = await import("./control-authority");
  const authority = owner();
  const lease = await a.acquireArtifactTargetLease({
    dataRoot: join(root, "data"),
    serviceIds: ["osrm"],
    owner: authority,
  });
  expect(existsSync(join(root, "data/.admin-target-control/locks/osrm"))).toBe(true);
  const releaseWriter = await acquireConfigurationOwnership(root);
  const store = await acquireReleaseStoreLock(root, {}, { failIfBusy: true });
  expect(existsSync(join(root, "state/ops-agent/configuration/.writer"))).toBe(true);
  store.release();
  releaseWriter();
  c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await a.settleArtifactTargetLeaseChild(
    lease,
    c.verifyControlEffectSettlement(installation, authority.execution),
  );
  await a.releaseArtifactTargetLease(lease);
});
it("does not turn an already-started execution into no-effect evidence", async () => {
  const c = await import("./control-authority");
  const authority = owner();
  c.beginControlEffect(authority);
  expect(() =>
    c.retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    }),
  ).toThrow(/Started/);
});
it("does not restart effects after retaining unused-execution evidence", async () => {
  const c = await import("./control-authority");
  const authority = owner();
  c.retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  expect(() => c.beginControlEffect(authority)).toThrow(/cannot restart/);
});

it("admits from a bounded active index without opening retained terminal ledgers", async () => {
  const a = await api();
  const { AnchoredDirectory } = await import("./filesystem");
  const { vi } = await import("vitest");
  // Real retained terminal histories, with valid signatures and released locks.
  for (let i = 0; i < 12; i++) {
    const authority = owner();
    const lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    });
    retainControlEffectReceipt(authority, {
      outcome: "failed_without_effect",
      publication: "not_started",
      receipt: { kind: "not-started" },
    });
    await a.settleArtifactTargetLeaseChild(
      lease,
      verifyControlEffectSettlement(installation, authority.execution),
    );
    await a.releaseArtifactTargetLease(lease);
  }
  const authority = owner();
  const read = AnchoredDirectory.prototype.read;
  const historicalReads: string[] = [];
  const spy = vi.spyOn(AnchoredDirectory.prototype, "read").mockImplementation(function (
    this: InstanceType<typeof AnchoredDirectory>,
    name,
    max,
    mode,
  ) {
    if (name === "owner.json") historicalReads.push(this.path);
    return read.call(this, name, max, mode);
  });
  let lease: import("./target-lease").ArtifactTargetLease | undefined;
  try {
    lease = await a.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds: ["osrm"],
      owner: authority,
    });
  } finally {
    spy.mockRestore();
  }
  expect(new Set(historicalReads).size, "new acquisition must read only its new ledger").toBe(1);
  if (lease) a.closeArtifactTargetLeaseHandle(lease);
}, 180000);

it("does not accumulate temporary authority records after failed atomic updates", async () => {
  const { AnchoredDirectory } = await import("./filesystem");
  const { vi } = await import("vitest");
  const { readdirSync } = await import("node:fs");
  const dir = new AnchoredDirectory(root);
  try {
    dir.write("receipt.json", "original", true);
    for (let i = 0; i < 3; i++) {
      const check = dir.check.bind(dir);
      let calls = 0;
      const fault = vi.spyOn(dir, "check").mockImplementation(() => {
        if (++calls === 3) throw Error("synthetic post-write authority failure");
        check();
      });
      try {
        expect(() => dir.write("receipt.json", "replacement")).toThrow(/synthetic/);
      } finally {
        fault.mockRestore();
      }
    }
    expect(dir.read("receipt.json", 64).toString()).toBe("original");
    expect(readdirSync(root).filter((name) => name.startsWith(".write-"))).toEqual([]);
  } finally {
    dir.close();
  }
});
