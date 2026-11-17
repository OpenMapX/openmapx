import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlInstallation,
  closeControlInstallation,
  controlChildOperationKey,
  type LocalLeaseBackend,
  leaseStoreDirectory,
  localLeaseBackend,
  openControlInstallation,
  openLeaseStore,
  provisionControlDirectories,
  rootLeaseId,
} from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFixedConfigurationMaintenancePlan } from "../../../packages/core/src/build-artifacts/fixed-configuration-maintenance";
import { type HandoffHelperHost, runConfigurationHandoff } from "./handoff-helper";
import {
  ConfigurationMaintenance,
  createMaintenance,
  type MaintenanceAdapters,
  readHandoffProgress,
  readMaintenance,
} from "./maintenance";

const maintenanceId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const apiJobId = "11111111-1111-4111-8111-111111111111";
const handoffId = "66666666-6666-4666-8666-666666666666";
const stepKey = "99999999-9999-4999-8999-999999999999";
const revisionId = `cfg1_${"a".repeat(43)}`;
const targets = ["app-api", "traefik"];
const image = (id: string) => `sha256:${(id === "app-api" ? "2" : "3").repeat(64)}`;
const container = (id: string) => (id === "app-api" ? "4" : "5").repeat(64);

function plan() {
  const deadlineAt = Date.now() + 600_000,
    root = createControlRootOperationKey({ notAfter: deadlineAt, nonce: Buffer.alloc(16, 7) });
  const parent = {
    issuer: "api" as const,
    apiJobId,
    apiOwnerVersion: 1,
    operationKey: "opk1_originalApiParent0001",
    fingerprint: "a".repeat(64),
    deadlineAt,
    attemptId: "22222222-2222-4222-8222-222222222222",
    assertionDigest: "b".repeat(64),
  };
  const apply = {
    kind: "stack.render" as const,
    maintenanceId,
    candidateId,
    revisionId,
    payloadDigest: "d".repeat(64),
    expectedCurrentRevisionId: `cfg1_${"b".repeat(43)}`,
    expectedSourceRevision: "55555555-5555-4555-8555-555555555555",
    coordinatorMode: "ensure-running" as const,
  };
  const operation = {
    kind: "configurationMaintenance.prepare" as const,
    maintenanceId,
    candidateId,
    applyOperationKey: controlChildOperationKey(root, "configuration-commit", 0),
    applyOperationFingerprint: opsOperationFingerprint(apply),
    revisionId,
    expectedCurrentRevisionId: apply.expectedCurrentRevisionId,
    expectedSourceRevision: apply.expectedSourceRevision,
    coordinatorMode: apply.coordinatorMode,
    followUp: "platform-apply" as const,
  };
  const operationFingerprint = opsOperationFingerprint(operation);
  return buildFixedConfigurationMaintenancePlan({
    prepare: {
      executor: "ops-agent",
      principal: "api",
      executionId: "job1_originalPrepare0001",
      operationKey: root,
      deadlineAt,
      operationFingerprint,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint,
        deadlineAt,
        parent,
      }),
    },
    operation,
    apiParent: parent,
    apply,
    candidateRecordDigest: "c".repeat(64),
    sourceAuthorityRevision: "registry-v1",
    previewDigest: "d".repeat(64),
    serviceIds: ["app-api", "data-manager", "traefik"],
    recreateServiceIds: [],
    hardlinkPlan: { prune: true, plan: [] },
    handoff: {
      handoffId,
      previewFingerprint: "7".repeat(64),
      serviceIds: targets,
      expectedImageIdentities: Object.fromEntries(targets.map((id) => [id, image(id)])),
      mode: { kind: "configuration" },
    },
  });
}

function execution(operationKey: string, executor: ExecutionRef["executor"]): ExecutionRef {
  return {
    executor,
    principal: executor === "ops-agent" ? "api" : "host-cli",
    executionId: executor === "ops-agent" ? "job1_handoffStepChild001" : handoffId,
    operationKey,
    operationFingerprint: "e".repeat(64),
    fingerprint: "f".repeat(64),
    deadlineAt: Date.now() + 600_000,
  };
}

let root: string;
let installation: ControlInstallation;
let leases: LocalLeaseBackend;
let maintenance: ConfigurationMaintenance;
let replaced: string[];

/** Brings a maintenance to a launched helper, with its children recorded in the lease. */
async function launched() {
  const planned = plan();
  const file = createMaintenance(installation, {
    plan: planned,
    originalContainers: targets.map((serviceId) => ({
      serviceId,
      containerId: container(serviceId),
      state: "running" as const,
      provenance: {
        project: "openmapx",
        composeWorkingDirectory: "/srv/openmapx/infra/docker",
        composeConfigFiles: ["/srv/openmapx/infra/docker/compose.yml"],
        imageId: image(serviceId),
      },
    })),
    apiJobId,
    leaseId: rootLeaseId(planned.prepare),
    now: new Date(),
  });
  const lease = await leases.acquire({
    owner: file.plan.prepare,
    ownerKind: "configurationMaintenance.prepare",
    targets: file.plan.serviceIds,
  });
  // The record names the lease the agent acquired for it.
  const record = readMaintenance(installation, maintenanceId);
  const adapters: MaintenanceAdapters = {
    now: () => new Date(),
    prepareFence: async (value) => ({
      maintenanceId,
      candidateId,
      ownerPrepare: value.plan.prepare,
      planDigest: value.plan.planDigest,
      revisionId,
      hardlinkPlanDigest: null,
      fenceId: "77777777-7777-4777-8777-777777777777",
      sequence: 0,
      state: "prepared",
    }),
    fenceDelegated: () => true,
    settleFence: vi.fn(),
    runStep: async () => ({ outcome: "committed", appliedRevisionId: revisionId, result: {} }),
    launchHelper: async (value) => {
      const step = value.plan.steps.at(-1)!;
      await leases.delegate({
        leaseId: lease.leaseId,
        child: {
          key: stepKey,
          parentKey: null,
          parent: value.plan.prepare,
          execution: execution(step.operationKey, "ops-agent"),
          kind: "configurationHandoff.prepare",
          phase: "maintenance-handoff",
          recipient: "ops-agent",
          targets,
        },
      });
      await leases.delegate({
        leaseId: lease.leaseId,
        child: {
          key: handoffId,
          parentKey: stepKey,
          parent: execution(step.operationKey, "ops-agent"),
          execution: execution(
            controlChildOperationKey(step.operationKey, "configuration-handoff", 0),
            "host-cli",
          ),
          kind: "configuration-helper",
          phase: "configuration-handoff",
          recipient: "configuration-helper",
          targets,
        },
      });
      return { containerId: "c".repeat(64) };
    },
    findHelper: async () => ({ id: "c".repeat(64), running: true, exitCode: null }),
    removeHelper: vi.fn(),
    cancelLease: vi.fn(),
    releaseLease: vi.fn(),
  };
  maintenance = new ConfigurationMaintenance(installation, adapters);
  expect(record.record.state).toBe("preparing");
  await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
  expect(
    (await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000))).outcome,
  ).toBe("running");
  return lease.leaseId;
}

const host = (onReplace?: (serviceId: string) => Promise<void> | void): HandoffHelperHost => ({
  async replace(_file, serviceId, beforeEffect) {
    await onReplace?.(serviceId);
    beforeEffect();
    replaced.push(serviceId);
    return (serviceId === "app-api" ? "6" : "7").repeat(64);
  },
  verifyAll: async () => undefined,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-handoff-"));
  const infraDir = join(root, "infra", "docker");
  mkdirSync(join(infraDir, "data"), { recursive: true });
  provisionControlDirectories(infraDir);
  installation = openControlInstallation({ infraDir, role: "ops-agent" });
  leases = localLeaseBackend(
    openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: "test" }),
  );
  replaced = [];
});
afterEach(() => {
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});

const run = (leaseId: string, helperHost = host()) =>
  runConfigurationHandoff({
    installation,
    leases,
    host: helperHost,
    maintenanceId,
    handoffId,
    leaseId,
    leaseChild: handoffId,
    signal: AbortSignal.timeout(5000),
  });

describe("configuration helper", () => {
  it("adopts its child, records each target before replacing it and settles committed", async () => {
    const leaseId = await launched();
    expect(await run(leaseId)).toBe("applied");
    expect([...replaced].sort()).toEqual(targets);
    const progress = readHandoffProgress(installation, maintenanceId);
    expect(progress?.phase).toBe("applied");
    expect(progress?.targets.every((target) => target.phase === "verified")).toBe(true);
    const child = leases.readSync(leaseId)?.children.find((value) => value.key === handoffId);
    expect(child).toMatchObject({
      adopted: true,
      state: "settled",
      settlement: { outcome: "committed" },
    });
  });

  it("finishes the target in flight on cancel, starts no other and settles contained", async () => {
    const leaseId = await launched();
    const order = await new Promise<string[]>((resolve, reject) => {
      run(
        leaseId,
        host(async (serviceId) => {
          if (replaced.length === 0) await leases.cancel({ leaseId, key: handoffId });
          void serviceId;
        }),
      ).then(() => resolve(replaced), reject);
    });
    // The cancel arrived before the first effect: nothing was replaced.
    expect(order).toEqual([]);
    const progress = readHandoffProgress(installation, maintenanceId);
    expect(progress?.phase).toBe("cancelled");
    expect(progress?.targets.every((target) => target.phase === "pending")).toBe(true);
    const child = leases.readSync(leaseId)?.children.find((value) => value.key === handoffId);
    expect(child).toMatchObject({ state: "settled", settlement: { outcome: "contained" } });
  });

  it("keeps a target that was replaced before the cancel and stops before the next", async () => {
    const leaseId = await launched();
    await run(
      leaseId,
      host(async () => {
        if (replaced.length === 1) await leases.cancel({ leaseId, key: handoffId });
      }),
    );
    expect(replaced).toHaveLength(1);
    const progress = readHandoffProgress(installation, maintenanceId)!;
    expect(progress.phase).toBe("cancelled");
    expect(progress.targets.map((target) => target.phase).sort()).toEqual(["pending", "verified"]);
  });

  it("leaves its child unsettled and reports failed when a replacement fails", async () => {
    const leaseId = await launched();
    await expect(
      run(leaseId, {
        replace: async (_file, _serviceId, beforeEffect) => {
          beforeEffect();
          throw Error("compose up failed");
        },
        verifyAll: async () => undefined,
      }),
    ).rejects.toThrow("compose up failed");
    expect(readHandoffProgress(installation, maintenanceId)?.phase).toBe("failed");
    const child = leases.readSync(leaseId)?.children.find((value) => value.key === handoffId);
    expect(child).toMatchObject({ adopted: true, state: "held" });
    expect(child?.settlement).toBeUndefined();
  });

  it("refuses to run a second time once its child was adopted", async () => {
    const leaseId = await launched();
    await run(leaseId);
    await expect(run(leaseId)).rejects.toThrow("already started");
  });
});
