import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { leaseStoreDirectory, openLeaseStore } from "./lease-store";

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

/** The leases the agent's store holds now. */
function heldLeases() {
  return openLeaseStore({ directory: leaseStoreDirectory(root), purpose: "test" }).list();
}
it("reconciles a settled root after a crash between settlement and release", async () => {
  const c = await import("./control-authority"),
    a = await api();
  const authority = owner();
  const lease = await a.acquireArtifactTargetLease({ serviceIds: ["osrm"], owner: authority });
  retainControlEffectReceipt(authority, {
    outcome: "failed_without_effect",
    publication: "not_started",
    receipt: { kind: "not-started" },
  });
  await a.settleArtifactTargetLeaseChild(
    lease,
    verifyControlEffectSettlement(installation, authority.execution),
  );
  a.closeArtifactTargetLeaseHandle(lease);
  expect(heldLeases().map((value) => value.leaseId)).toEqual([lease.leaseId]);
  closeControlInstallation(installation);
  installation = openControlInstallation({
    infraDir: root,
    role: "host-cli",
    serviceIds: ["osrm", "motis"],
  });
  const restored = c.restoreAdmittedControlExecution(installation, authority.execution),
    recovery = c.verifyControlRecoveryAuthority(restored);
  const input = { leaseId: lease.leaseId, authority: recovery };
  await expect(a.reconcileArtifactTargetLease(input)).resolves.toBe("released");
  await expect(a.reconcileArtifactTargetLease(input)).resolves.toBe("released");
  expect(heldLeases()).toEqual([]);
});
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
describe("certified target leases", () => {
  it("requires nominal durable ownership, then fences unknown own effects", async () => {
    const a = await api();
    const authority = owner();
    await expect(
      a.acquireArtifactTargetLease({
        serviceIds: ["osrm"],
        owner: { execution: authority.execution } as typeof authority,
      }),
    ).rejects.toThrow(/authority/);
    const lease = await a.acquireArtifactTargetLease({
      serviceIds: ["osrm"],
      owner: authority,
    });
    await expect(a.releaseArtifactTargetLease(lease)).rejects.toThrow(/settle|effect/);
    expect(heldLeases().map((value) => value.targets)).toEqual([["osrm"]]);
  });
  it("releases a certified target after durable no-effect settlement", async () => {
    const a = await api();
    const authority = owner();
    const lease = await a.acquireArtifactTargetLease({
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
    expect(heldLeases()).toEqual([]);
  });
  it("refuses a second owner of a held target and names the holder", async () => {
    const a = await api();
    const first = owner();
    await a.acquireArtifactTargetLease({ serviceIds: ["osrm"], owner: first });
    const second = owner();
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const refused = expect(
        a.acquireArtifactTargetLease({ serviceIds: ["osrm"], owner: second }),
      ).rejects.toThrow(first.execution.operationKey);
      await vi.advanceTimersByTimeAsync(6000);
      await refused;
    } finally {
      vi.useRealTimers();
    }
    expect(heldLeases()).toHaveLength(1);
  });
});
it("never reacquires or expands a retained execution's root", async () => {
  const a = await api();
  const authority = owner();
  await a.acquireArtifactTargetLease({
    serviceIds: ["osrm"],
    owner: authority,
  });
  await expect(
    a.acquireArtifactTargetLease({
      serviceIds: ["osrm"],
      owner: authority,
    }),
  ).rejects.toThrow(/already acquired/);
  await expect(
    a.acquireArtifactTargetLease({
      serviceIds: ["motis"],
      owner: authority,
    }),
  ).rejects.toThrow(/closure/);
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
it("holds a target lease, the configuration writer and the release-store lock together", async () => {
  const { acquireConfigurationOwnership, configurationWriterLockPath } = await import(
    "../services/configuration-ownership"
  );
  const { acquireReleaseStoreLock } = await import("../services/release-store-lock");
  const a = await api();
  const c = await import("./control-authority");
  const authority = owner();
  const lease = await a.acquireArtifactTargetLease({
    serviceIds: ["osrm"],
    owner: authority,
  });
  expect(heldLeases()).toHaveLength(1);
  const releaseWriter = await acquireConfigurationOwnership(root);
  const store = await acquireReleaseStoreLock(root, {}, { failIfBusy: true });
  expect(existsSync(configurationWriterLockPath(root))).toBe(true);
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
