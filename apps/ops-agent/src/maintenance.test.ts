import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlInstallation,
  closeControlInstallation,
  controlChildOperationKey,
  openControlInstallation,
  provisionControlDirectories,
  writePrivateRecord,
} from "@openmapx/core/build-artifacts";
import { DataManagerHttpError } from "@openmapx/core/data-manager-sdk";
import {
  createControlRootOperationKey,
  executionFingerprint,
  type HandoffProgress,
  MaintenanceTransitionRefused,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settleMaintenanceFence } from "../../../packages/cli/src/lib/control-resolve";
import { buildFixedConfigurationMaintenancePlan } from "../../../packages/core/src/build-artifacts/fixed-configuration-maintenance";
import { installationState } from "../../../packages/core/src/build-artifacts/private-records";
import {
  ConfigurationMaintenance,
  createMaintenance,
  type MaintenanceAdapters,
  MaintenanceFenceRefused,
  type MaintenanceFile,
  MaintenanceSettlementRefused,
  maintenanceCapacityReached,
  pendingHandoffs,
  readHandoffOutcome,
  readMaintenance,
  writeHandoffProgress,
} from "./maintenance";
import { applyFailure, maintenanceFailure } from "./maintenance-runtime";
import { OpsExecutionFailure } from "./runtime";

vi.mock("@openmapx/core/data-manager-sdk", async (original) => ({
  ...(await original<typeof import("@openmapx/core/data-manager-sdk")>()),
  settleDataConfigurationFence: vi.fn(),
  inspectDataConfigurationFence: vi.fn(),
}));

const maintenanceId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const apiJobId = "11111111-1111-4111-8111-111111111111";
const handoffId = "66666666-6666-4666-8666-666666666666";
const revisionId = `cfg1_${"a".repeat(43)}`;
const oldContainer = "1".repeat(64);
const image = `sha256:${"2".repeat(64)}`;

function plan(options: { handoff?: boolean; maintenanceId?: string } = {}) {
  const id = options.maintenanceId ?? maintenanceId;
  const deadlineAt = Date.now() + 600_000,
    root = createControlRootOperationKey({ notAfter: deadlineAt, nonce: Buffer.alloc(16, 9) });
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
    maintenanceId: id,
    candidateId,
    revisionId,
    payloadDigest: "d".repeat(64),
    expectedCurrentRevisionId: `cfg1_${"b".repeat(43)}`,
    expectedSourceRevision: "55555555-5555-4555-8555-555555555555",
    coordinatorMode: "ensure-running" as const,
  };
  const operation = {
    kind: "configurationMaintenance.prepare" as const,
    maintenanceId: id,
    candidateId,
    applyOperationKey: controlChildOperationKey(root, "configuration-commit", 0),
    applyOperationFingerprint: opsOperationFingerprint(apply),
    revisionId,
    expectedCurrentRevisionId: apply.expectedCurrentRevisionId,
    expectedSourceRevision: apply.expectedSourceRevision,
    coordinatorMode: apply.coordinatorMode,
    followUp: options.handoff ? ("platform-apply" as const) : ("service-apply" as const),
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
    serviceIds: ["app-api", "data-manager", "motis"],
    recreateServiceIds: options.handoff ? [] : ["motis"],
    hardlinkPlan: { prune: true, plan: [] },
    ...(options.handoff
      ? {
          handoff: {
            handoffId,
            previewFingerprint: "7".repeat(64),
            serviceIds: ["app-api"],
            expectedImageIdentities: { "app-api": image },
            mode: { kind: "configuration" as const },
          },
        }
      : {}),
  });
}

const fence = (state: "prepared" | "settled", file: MaintenanceFile) => ({
  maintenanceId,
  candidateId,
  ownerPrepare: file.plan.prepare,
  planDigest: file.plan.planDigest,
  revisionId,
  hardlinkPlanDigest: null,
  fenceId: "77777777-7777-4777-8777-777777777777",
  sequence: state === "prepared" ? 0 : 1,
  state,
});

let root: string;
let installation: ControlInstallation;
let helper: { id: string; running: boolean; created: boolean; exitCode: number | null } | null;
/** The maintenance's lease as the store keeps it: the store refuses to release
 * it while a handoff child it recorded is unsettled. */
let lease: { held: boolean; handoff: "none" | "held" | "settled"; adopted: boolean };
let order: string[];
let adapters: MaintenanceAdapters;

function admit(options: { handoff?: boolean; maintenanceId?: string } = {}) {
  return createMaintenance(installation, {
    plan: plan(options),
    originalContainers: [],
    apiJobId,
    leaseId: "88888888-8888-4888-8888-888888888888",
    now: new Date(),
  });
}
/** The maintenance's lease as `openmapx control resolve` reads it from the store. */
function fenceLease(file: MaintenanceFile) {
  return {
    leaseId: "88888888-8888-4888-8888-888888888888",
    owner: file.plan.prepare,
    ownerKind: "configurationMaintenance.prepare",
    targets: ["data-manager"],
    state: "held" as const,
    createdAt: Date.now(),
    children: [
      {
        key: "99999999-9999-4999-8999-999999999999",
        parentKey: null,
        parent: file.plan.prepare,
        execution: { ...file.plan.prepare, executor: "data-manager", principal: "data-manager" },
        kind: "configuration-maintenance.prepare",
        phase: "configuration-fence",
        recipient: "data-manager",
        targets: ["data-manager"],
        evidence: { maintenanceId, candidateId, planDigest: file.plan.planDigest },
        adopted: true,
        state: "settled" as const,
      },
    ],
  } as Parameters<typeof settleMaintenanceFence>[1];
}
function progress(
  phase: HandoffProgress["phase"],
  target: HandoffProgress["targets"][number]["phase"],
) {
  writeHandoffProgress(installation, {
    version: 1,
    maintenanceId,
    handoffId,
    phase,
    targets: [
      {
        serviceId: "app-api",
        phase: target,
        oldContainerId: oldContainer,
        newContainerId: target === "verified" ? "3".repeat(64) : null,
        expectedImageId: image,
      },
    ],
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-maintenance-"));
  const infraDir = join(root, "infra", "docker");
  mkdirSync(join(infraDir, "data"), { recursive: true });
  provisionControlDirectories(infraDir);
  installation = openControlInstallation({ infraDir, role: "ops-agent" });
  helper = null;
  lease = { held: true, handoff: "none", adopted: false };
  order = [];
  adapters = {
    now: () => new Date(),
    prepareFence: vi.fn(async (file) => {
      order.push("prepare-fence");
      return fence("prepared", file);
    }),
    fenceDelegated: async () => true,
    settleFence: vi.fn(async (file, outcome) => {
      order.push(`settle-fence:${outcome}`);
      return fence("settled", file);
    }),
    runStep: vi.fn(async (file, ordinal) => {
      // The step is recorded attempted before its effect.
      expect(readMaintenance(installation, maintenanceId).record.steps[ordinal]?.state).toBe(
        "attempted",
      );
      order.push(`step:${ordinal}`);
      return ordinal === 0
        ? {
            outcome: "committed" as const,
            appliedRevisionId: revisionId,
            result: { outcome: "committed" },
          }
        : { outcome: "committed" as const };
    }),
    launchHelper: vi.fn(async () => {
      expect(readMaintenance(installation, maintenanceId).record.handoff).toEqual({
        handoffId,
        containerId: null,
      });
      order.push("launch");
      lease.handoff = "held";
      helper = { id: "c".repeat(64), running: true, created: false, exitCode: null };
      return { containerId: helper.id };
    }),
    findHelper: vi.fn(async () => helper),
    helperAdopted: () => lease.adopted,
    settleHandoff: vi.fn(async (_file, outcome) => {
      order.push(`settle-handoff:${outcome}`);
      if (outcome !== "unknown" && lease.handoff === "held") lease.handoff = "settled";
    }),
    removeHelper: vi.fn(async () => {
      order.push("remove-helper");
      helper = null;
    }),
    cancelLease: vi.fn(async () => {
      order.push("cancel-lease");
    }),
    leaseHeld: () => lease.held,
    releaseLease: vi.fn(async () => {
      if (!lease.held) return;
      if (lease.handoff === "held") throw Error("Every attempted descendant must settle");
      lease.held = false;
      order.push("release");
    }),
  };
});
afterEach(() => {
  closeControlInstallation(installation);
  rmSync(root, { recursive: true, force: true });
});

describe("configuration maintenance in the agent", () => {
  it("prepares, applies each step after recording it, settles and releases", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    expect((await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000))).state).toBe(
      "prepared",
    );
    const applied = await maintenance.applySteps(
      maintenanceId,
      apiJobId,
      AbortSignal.timeout(5000),
    );
    expect(applied.outcome).toBe("committed");
    expect(applied.generation).toEqual({ outcome: "committed" });
    expect(applied.record).toMatchObject({ generation: "committed", followUp: "complete" });
    const settled = await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000));
    expect(settled.state).toBe("settled");
    expect(order).toEqual(["prepare-fence", "step:0", "step:1", "settle-fence:applied", "release"]);
    // Settle is idempotent: a repeat returns the record and does nothing.
    await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000));
    expect(order.at(-1)).toBe("release");
  });

  it("settles a refused fence preparation and releases; an unknown one is held", async () => {
    admit();
    adapters.prepareFence = async () => {
      throw new MaintenanceFenceRefused();
    };
    const refused = new ConfigurationMaintenance(installation, adapters);
    expect((await refused.prepare(maintenanceId, AbortSignal.timeout(5000))).state).toBe("settled");
    expect(order).toEqual(["release"]);
  });

  it("holds a fence preparation whose outcome is unknown for recovery", async () => {
    admit();
    adapters.prepareFence = async () => {
      throw Error("data-manager unreachable");
    };
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    expect((await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000))).state).toBe(
      "recovery_required",
    );
    expect(order).toEqual([]);
  });

  it("holds an unknown step for recovery and never releases", async () => {
    admit();
    adapters.runStep = async () => {
      throw Error("lost");
    };
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    const applied = await maintenance.applySteps(
      maintenanceId,
      apiJobId,
      AbortSignal.timeout(5000),
    );
    expect(applied.outcome).toBe("unknown");
    expect(applied.record.state).toBe("recovery_required");
    await expect(
      maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000)),
    ).rejects.toThrow(MaintenanceTransitionRefused);
    expect(order).toEqual(["prepare-fence"]);
  });

  it("moves a record needing recovery to settled through the operator's resolve", async () => {
    const file = admit();
    adapters.runStep = async () => {
      throw Error("lost");
    };
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("recovery_required");
    const sdk = await import("@openmapx/core/data-manager-sdk");
    vi.mocked(sdk.settleDataConfigurationFence).mockResolvedValue(fence("settled", file));
    vi.stubEnv("DATA_MANAGER_URL", "http://127.0.0.1:1");
    vi.stubEnv("DATA_MANAGER_TOKEN", "x".repeat(43));
    const evidence = { maintenanceId, candidateId, planDigest: file.plan.planDigest };
    await settleMaintenanceFence(
      join(root, "infra", "docker"),
      {
        leaseId: "88888888-8888-4888-8888-888888888888",
        owner: file.plan.prepare,
        ownerKind: "configurationMaintenance.prepare",
        targets: ["data-manager"],
        state: "held",
        createdAt: Date.now(),
        children: [
          {
            key: "99999999-9999-4999-8999-999999999999",
            parentKey: null,
            parent: file.plan.prepare,
            execution: {
              ...file.plan.prepare,
              executor: "data-manager",
              principal: "data-manager",
            },
            kind: "configuration-maintenance.prepare",
            phase: "configuration-fence",
            recipient: "data-manager",
            targets: ["data-manager"],
            evidence,
            adopted: true,
            state: "settled",
          },
        ],
      },
      "failed",
    );
    // The record decides the fence's outcome: the generation was unknown and
    // is resolved as not committed.
    expect(vi.mocked(sdk.settleDataConfigurationFence).mock.calls[0]?.[0]).toEqual({
      ...evidence,
      outcome: "contained",
    });
    expect(readMaintenance(installation, maintenanceId).record).toMatchObject({
      state: "settled",
      generation: "not_committed",
      fenceOutcome: "contained",
      fence: { state: "settled" },
    });
    vi.unstubAllEnvs();
  });

  it("resolves with the record's fence outcome and never while the agent drives the maintenance", async () => {
    const file = admit({ handoff: true });
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    const sdk = await import("@openmapx/core/data-manager-sdk");
    vi.mocked(sdk.settleDataConfigurationFence).mockReset();
    vi.mocked(sdk.settleDataConfigurationFence).mockResolvedValue(fence("settled", file));
    vi.stubEnv("DATA_MANAGER_URL", "http://127.0.0.1:1");
    vi.stubEnv("DATA_MANAGER_TOKEN", "x".repeat(43));
    const evidence = { maintenanceId, candidateId, planDigest: file.plan.planDigest };
    const held = {
      leaseId: "88888888-8888-4888-8888-888888888888",
      owner: file.plan.prepare,
      ownerKind: "configurationMaintenance.prepare",
      targets: ["data-manager"],
      state: "held" as const,
      createdAt: Date.now(),
      children: [
        {
          key: "99999999-9999-4999-8999-999999999999",
          parentKey: null,
          parent: file.plan.prepare,
          execution: { ...file.plan.prepare, executor: "data-manager", principal: "data-manager" },
          kind: "configuration-maintenance.prepare",
          phase: "configuration-fence",
          recipient: "data-manager",
          targets: ["data-manager"],
          evidence,
          adopted: true,
          state: "settled" as const,
        },
      ],
    } as Parameters<typeof settleMaintenanceFence>[1];
    const infraDir = join(root, "infra", "docker");
    // Applying, whether its helper still runs or exited unobserved: the agent
    // finishes it, so the operator is told to wait.
    await expect(settleMaintenanceFence(infraDir, held, "committed")).rejects.toThrow(
      "The agent is still driving this maintenance (applying)",
    );
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 1 };
    await expect(settleMaintenanceFence(infraDir, held, "committed")).rejects.toThrow(
      "still driving",
    );
    expect(sdk.settleDataConfigurationFence).not.toHaveBeenCalled();
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("applying");
    // A record that settled with its outcome fixed decides the fence's outcome.
    progress("cancelled", "pending");
    await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000));
    const settled = readMaintenance(installation, maintenanceId).record;
    expect(settled).toMatchObject({ state: "settled", fenceOutcome: "applied" });
    await settleMaintenanceFence(infraDir, held, "failed");
    expect(vi.mocked(sdk.settleDataConfigurationFence).mock.calls[0]?.[0]).toEqual({
      ...evidence,
      outcome: "applied",
    });
    vi.unstubAllEnvs();
  });

  it("stops sending a settlement data-manager refuses for good, until the operator resolves it", async () => {
    const file = admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    const infraDir = join(root, "infra", "docker");
    await expect(settleMaintenanceFence(infraDir, fenceLease(file), "failed")).rejects.toThrow(
      "The agent is still driving this maintenance (prepared)",
    );
    adapters.settleFence = vi.fn(async () => {
      throw new MaintenanceSettlementRefused(Error("404"));
    });
    const refused = await maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000));
    expect(refused).toMatchObject({ state: "recovery_required", fenceOutcome: "unused" });
    await maintenance.tick(AbortSignal.timeout(5000));
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(adapters.settleFence).toHaveBeenCalledOnce();
    expect(lease.held).toBe(true);
    // Data-manager has no such fence for the operator either; the resolution ends it.
    const sdk = await import("@openmapx/core/data-manager-sdk");
    vi.mocked(sdk.settleDataConfigurationFence).mockReset();
    vi.mocked(sdk.settleDataConfigurationFence).mockRejectedValue(
      new DataManagerHttpError("Configuration maintenance identity is unknown", 404),
    );
    vi.stubEnv("DATA_MANAGER_URL", "http://127.0.0.1:1");
    vi.stubEnv("DATA_MANAGER_TOKEN", "x".repeat(43));
    await settleMaintenanceFence(infraDir, fenceLease(file), "failed");
    expect(readMaintenance(installation, maintenanceId).record).toMatchObject({
      state: "settled",
      fenceOutcome: "unused",
    });
    // Settled, it is released and receipted like any other, and never sent again.
    await maintenance.recover(AbortSignal.timeout(5000));
    expect(lease.held).toBe(false);
    expect(adapters.settleFence).toHaveBeenCalledOnce();
    vi.unstubAllEnvs();
  });

  it("refuses to end a maintenance whose fence data-manager still holds prepared after a conflicting settle", async () => {
    const file = admit();
    adapters.runStep = async () => {
      throw Error("lost");
    };
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    const sdk = await import("@openmapx/core/data-manager-sdk");
    vi.mocked(sdk.settleDataConfigurationFence).mockReset();
    vi.mocked(sdk.settleDataConfigurationFence).mockRejectedValue(
      new DataManagerHttpError("Configuration fence settlement conflict", 409),
    );
    vi.mocked(sdk.inspectDataConfigurationFence).mockResolvedValue(fence("prepared", file));
    vi.stubEnv("DATA_MANAGER_URL", "http://127.0.0.1:1");
    vi.stubEnv("DATA_MANAGER_TOKEN", "x".repeat(43));
    const infraDir = join(root, "infra", "docker");
    await expect(settleMaintenanceFence(infraDir, fenceLease(file), "failed")).rejects.toThrow(
      "still holds it prepared",
    );
    expect(vi.mocked(sdk.inspectDataConfigurationFence).mock.calls[0]?.[0]).toBe(maintenanceId);
    // The record keeps waiting for the fence; nothing claims it was settled.
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settling");
    // Once data-manager reports the fence settled otherwise, the resolution ends it.
    vi.mocked(sdk.inspectDataConfigurationFence).mockResolvedValue(fence("settled", file));
    await settleMaintenanceFence(infraDir, fenceLease(file), "failed");
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settled");
    vi.unstubAllEnvs();
  });

  it("records a step whose result the record refuses as unknown, not as an apply refusal", async () => {
    admit();
    // The generation step commits another revision than the bound one.
    adapters.runStep = vi.fn(async () => ({
      outcome: "committed" as const,
      appliedRevisionId: `cfg1_${"b".repeat(43)}`,
      result: { outcome: "committed" },
    }));
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    const applied = await maintenance.applySteps(
      maintenanceId,
      apiJobId,
      AbortSignal.timeout(5000),
    );
    expect(applied.outcome).toBe("unknown");
    expect(applied.record).toMatchObject({ state: "recovery_required", generation: "unknown" });
    expect(applied.record.steps[0]).toMatchObject({ state: "terminal", outcome: "unknown" });
    expect(adapters.runStep).toHaveBeenCalledOnce();
    expect(lease.held).toBe(true);
  });

  it("gives recovery_required on restart with a step attempted and runs nothing again", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    let release!: () => void;
    adapters.runStep = vi.fn(() => new Promise<never>(() => (release = () => undefined)));
    void maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    await vi.waitFor(() => expect(adapters.runStep).toHaveBeenCalledOnce());
    release();
    const restarted = new ConfigurationMaintenance(installation, adapters);
    await restarted.recover(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("recovery_required");
    expect(adapters.runStep).toHaveBeenCalledOnce();
  });

  it("settles a preparation whose fence child was never recorded, on restart", async () => {
    admit();
    adapters.fenceDelegated = async () => false;
    await new ConfigurationMaintenance(installation, adapters).recover(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settled");
    expect(order).toEqual(["release"]);
  });

  it("succeeds apply with the handoff running and records nothing until the helper exited", async () => {
    admit({ handoff: true });
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    const applied = await maintenance.applySteps(
      maintenanceId,
      apiJobId,
      AbortSignal.timeout(5000),
    );
    expect(applied.outcome).toBe("running");
    expect(maintenance.handoffPending().has(maintenanceId)).toBe(true);
    progress("applying", "recreate_attempted");
    expect((await maintenance.inspect(maintenanceId)).steps.at(-1)?.state).toBe("attempted");
    await expect(
      maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000)),
    ).rejects.toThrow(MaintenanceTransitionRefused);
    // A restart while the helper runs only watches it.
    await new ConfigurationMaintenance(installation, adapters).recover(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("applying");
    progress("applied", "verified");
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 0 };
    const inspected = await maintenance.inspect(maintenanceId);
    expect(inspected.steps.at(-1)).toMatchObject({ state: "terminal", outcome: "committed" });
    expect(inspected.followUp).toBe("complete");
    expect(maintenance.handoffPending().size).toBe(0);
    expect(order).toContain("remove-helper");
    expect(
      (await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000))).state,
    ).toBe("settled");
  });

  it("abandons a prepared maintenance with no step attempted", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    expect(
      (await maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000))).state,
    ).toBe("settled");
    expect(order).toEqual(["prepare-fence", "settle-fence:unused", "release"]);
    expect(adapters.runStep).not.toHaveBeenCalled();
  });

  it("answers settling when data-manager does not settle, and settles it in its own check", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    const settleFence = adapters.settleFence;
    adapters.settleFence = async () => {
      throw Error("data-manager unreachable");
    };
    // The settle operation succeeds with the record as it stands; the API
    // reads the record until it is settled.
    expect(
      (await maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000))).state,
    ).toBe("settling");
    expect(readMaintenance(installation, maintenanceId).record.fenceOutcome).toBe("unused");
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settling");
    adapters.settleFence = settleFence;
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settled");
    expect(order).toEqual(["prepare-fence", "settle-fence:unused", "release"]);
    expect(lease.held).toBe(false);
  });

  it("settles a settling record left by a restart, once the agent is back", async () => {
    admit();
    await new ConfigurationMaintenance(installation, adapters).prepare(
      maintenanceId,
      AbortSignal.timeout(5000),
    );
    // The agent stops while data-manager settles the fence.
    adapters.settleFence = vi.fn(() => new Promise<never>(() => undefined));
    void new ConfigurationMaintenance(installation, adapters).settle(
      maintenanceId,
      "abandon",
      AbortSignal.timeout(5000),
    );
    await vi.waitFor(() => expect(adapters.settleFence).toHaveBeenCalledOnce());
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settling");
    adapters.settleFence = vi.fn(async (file) => fence("settled", file));
    await new ConfigurationMaintenance(installation, adapters).recover(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settled");
    expect(lease.held).toBe(false);
  });

  it("releases the lease of a record that settled just before the agent stopped", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    // The agent is killed after the record settled, before the release.
    const release = adapters.releaseLease;
    adapters.releaseLease = vi.fn(async () => {
      throw Error("agent killed");
    });
    expect(
      (await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000))).state,
    ).toBe("settled");
    expect(lease.held).toBe(true);
    adapters.releaseLease = release;
    await new ConfigurationMaintenance(installation, adapters).recover(AbortSignal.timeout(5000));
    expect(lease.held).toBe(false);
    // Without a restart the agent's own check releases it too.
    lease.held = true;
    await new ConfigurationMaintenance(installation, adapters).tick(AbortSignal.timeout(5000));
    expect(lease.held).toBe(false);
    // And a repeated settle, as the API sends after a lost reply.
    lease.held = true;
    await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000));
    expect(lease.held).toBe(false);
  });

  it("settles the handoff children before recording the helper's outcome, across a restart", async () => {
    admit({ handoff: true });
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    progress("applied", "verified");
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 0 };
    // The agent is killed between settling the children and recording the outcome.
    const settleHandoff = adapters.settleHandoff;
    adapters.settleHandoff = vi.fn(async (file, outcome) => {
      await settleHandoff(file, outcome);
      throw Error("agent killed");
    });
    await expect(maintenance.inspect(maintenanceId)).rejects.toThrow("agent killed");
    expect(readMaintenance(installation, maintenanceId).record.steps.at(-1)?.state).toBe(
      "attempted",
    );
    adapters.settleHandoff = settleHandoff;
    const restarted = new ConfigurationMaintenance(installation, adapters);
    await restarted.recover(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.steps.at(-1)).toMatchObject({
      state: "terminal",
      outcome: "committed",
    });
    expect(
      (await restarted.settle(maintenanceId, "complete", AbortSignal.timeout(5000))).state,
    ).toBe("settled");
    expect(lease.held).toBe(false);
  });

  it("records a helper that exited in its own check, without a request", async () => {
    admit({ handoff: true });
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(maintenance.handoffPending().has(maintenanceId)).toBe(true);
    progress("applied", "verified");
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 0 };
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(maintenance.handoffPending().size).toBe(0);
    expect(order).toContain("remove-helper");
  });

  it("observes no helper while its launch runs in the agent", async () => {
    admit({ handoff: true });
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    let launch!: () => void;
    const launchHelper = adapters.launchHelper;
    adapters.launchHelper = vi.fn(async (file, signal) => {
      await new Promise<void>((resolve) => (launch = resolve));
      return launchHelper(file, signal);
    });
    const applied = maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000));
    await vi.waitFor(() => expect(adapters.launchHelper).toHaveBeenCalledOnce());
    // No container yet, and the check runs: the launch is not counted as never made.
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.steps.at(-1)?.state).toBe(
      "attempted",
    );
    launch();
    expect((await applied).outcome).toBe("running");
  });

  it("abandons a prepared maintenance at its deadline in its own check", async () => {
    const file = admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("prepared");
    adapters.now = () => new Date(file.plan.prepare.deadlineAt + 1);
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(readMaintenance(installation, maintenanceId).record).toMatchObject({
      state: "settled",
      fenceOutcome: "unused",
    });
    expect(order).toEqual(["prepare-fence", "settle-fence:unused", "release"]);
    expect(adapters.runStep).not.toHaveBeenCalled();
    // An apply that comes after the deadline is refused, distinguishable from a crash.
    await expect(
      maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000)),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("stops after the step in flight when cancelled", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    adapters.runStep = vi.fn(async (_file, ordinal) => {
      await maintenance.cancel(maintenanceId, AbortSignal.timeout(5000));
      order.push(`step:${ordinal}`);
      return { outcome: "committed" as const, appliedRevisionId: revisionId, result: {} };
    });
    const applied = await maintenance.applySteps(
      maintenanceId,
      apiJobId,
      AbortSignal.timeout(5000),
    );
    expect(applied.outcome).toBe("contained");
    expect(order).toEqual(["prepare-fence", "cancel-lease", "step:0"]);
    expect(applied.record.steps[1]?.state).toBe("pending");
  });

  it("cancels on an abandon once a step started, and returns the settled record on a repeat", async () => {
    admit({ handoff: true });
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    expect(
      (await maintenance.applySteps(maintenanceId, apiJobId, AbortSignal.timeout(5000))).outcome,
    ).toBe("running");
    progress("applying", "recreate_attempted");
    // The helper still runs: the abandon cancels the lease instead of settling.
    const abandoned = await maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000));
    expect(abandoned).toMatchObject({ state: "applying", cancelRequestedAt: expect.any(String) });
    expect(order).toContain("cancel-lease");
    expect(order).not.toContain("release");
    await expect(
      maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000)),
    ).rejects.toThrow(MaintenanceTransitionRefused);
    progress("cancelled", "verified");
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 1 };
    const settled = await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000));
    expect(settled).toMatchObject({ state: "settled", followUp: "contained" });
    expect(order.at(-1)).toBe("release");
    // Settle is idempotent: a repeat of either outcome changes nothing.
    const releases = order.filter((entry) => entry === "release").length;
    expect(await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000))).toEqual(
      settled,
    );
    expect(await maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000))).toEqual(
      settled,
    );
    expect(order.filter((entry) => entry === "release")).toHaveLength(releases);
  });
});

describe("helper outcome", () => {
  it("is failed_without_effect without a container or progress, running while the container runs", async () => {
    admit({ handoff: true });
    const record = {
      ...readMaintenance(installation, maintenanceId).record,
      handoff: { handoffId, containerId: null },
    };
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("failed_without_effect");
    helper = { id: "c".repeat(64), running: true, created: false, exitCode: null };
    progress("applied", "verified");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("running");
  });

  it("is committed only for exit 0 with every target verified, contained for a clean cancel", async () => {
    admit({ handoff: true });
    const record = {
      ...readMaintenance(installation, maintenanceId).record,
      handoff: { handoffId, containerId: null },
    };
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 0 };
    progress("applied", "verified");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("committed");
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 1 };
    progress("cancelled", "pending");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("contained");
    progress("cancelled", "recreate_attempted");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
    // A helper that failed before any recreate replaced nothing.
    progress("failed", "pending");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("contained");
    progress("failed", "recreate_attempted");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
    helper = null;
    progress("applying", "recreate_attempted");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
  });

  it("is unknown when the helper adopted its child but left no container or progress", async () => {
    admit({ handoff: true });
    const record = {
      ...readMaintenance(installation, maintenanceId).record,
      handoff: { handoffId, containerId: null },
    };
    lease.adopted = true;
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
    helper = { id: "c".repeat(64), running: false, created: false, exitCode: 1 };
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
  });

  it("removes a container Docker created and never started, and counts no launch", async () => {
    admit({ handoff: true });
    const record = {
      ...readMaintenance(installation, maintenanceId).record,
      handoff: { handoffId, containerId: null },
    };
    helper = { id: "c".repeat(64), running: false, created: true, exitCode: 0 };
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("failed_without_effect");
    expect(adapters.removeHelper).toHaveBeenCalledWith("c".repeat(64));
    // Adopted, it started after all: its outcome is not known.
    helper = { id: "c".repeat(64), running: false, created: true, exitCode: 0 };
    lease.adopted = true;
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
  });
});

describe("maintenance records the agent keeps", () => {
  it("refuses a new preparation at the bound and still lists every record", () => {
    for (let index = 0; index < 64; index++) {
      expect(maintenanceCapacityReached(installation)).toBe(false);
      admit({ maintenanceId: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}` });
    }
    expect(maintenanceCapacityReached(installation)).toBe(true);
    // A record written past the bound breaks no other admission.
    admit({ maintenanceId: "33333333-3333-4333-8333-999999999999" });
    expect(pendingHandoffs(installation).size).toBe(0);
  });

  it("fails a refused transition with its own class, distinct from a crash", () => {
    const failure = (reason: ConstructorParameters<typeof MaintenanceTransitionRefused>[0]) =>
      maintenanceFailure(new MaintenanceTransitionRefused(reason));
    expect(failure("expired")).toMatchObject({ errorClass: "stale" });
    expect(failure("busy")).toMatchObject({ errorClass: "busy" });
    expect(failure("conflict")).toMatchObject({ errorClass: "conflict" });
    expect(failure("recovery_required")).toMatchObject({ errorClass: "recovery_required" });
    expect(failure("busy")).toBeInstanceOf(OpsExecutionFailure);
    const crash = Error("lost");
    expect(maintenanceFailure(crash)).toBe(crash);
  });

  it("tells the API an apply was refused only while no step started", () => {
    const { record } = admit();
    const conflict = new MaintenanceTransitionRefused("conflict");
    expect(applyFailure(conflict, record)).toMatchObject({ errorClass: "conflict" });
    const started = {
      ...record,
      state: "applying" as const,
      steps: record.steps.map((step, index) =>
        index === 0 ? { ...step, state: "attempted" as const } : step,
      ),
    };
    expect(applyFailure(conflict, started)).toMatchObject({ errorClass: "recovery_required" });
    const crash = Error("lost");
    expect(applyFailure(crash, started)).toBe(crash);
  });

  it("completes only a settle the agent's stop interrupted, once its record settled", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    const row = (interrupted: boolean) => ({
      operation: {
        kind: "configurationMaintenance.settle" as const,
        maintenanceId,
        outcome: "complete" as const,
      },
      state: "failed" as const,
      ...(interrupted ? { interrupted: true as const } : {}),
    });
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    adapters.settleFence = async () => {
      throw Error("data-manager unreachable");
    };
    await maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000));
    // Settling proves no settlement yet.
    expect(maintenance.interruptedSettleResult(row(true))).toBeUndefined();
    adapters.settleFence = async (file) => fence("settled", file);
    await maintenance.tick(AbortSignal.timeout(5000));
    expect(maintenance.interruptedSettleResult(row(true))).toMatchObject({ state: "settled" });
    // A settle that failed by itself keeps its failure.
    expect(maintenance.interruptedSettleResult(row(false))).toBeUndefined();
  });

  it("logs a record it cannot read and keeps checking", async () => {
    admit();
    writePrivateRecord(
      installationState(installation),
      "maintenance",
      "33333333-3333-4333-8333-000000000099.json",
      { version: 99 },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await expect(maintenance.tick(AbortSignal.timeout(5000))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "Configuration maintenance records are unreadable",
      expect.anything(),
    );
    await expect(maintenance.tick(AbortSignal.timeout(5000))).resolves.toBeUndefined();
    warn.mockRestore();
  });
});
