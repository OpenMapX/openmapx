import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlInstallation,
  closeControlInstallation,
  controlChildOperationKey,
  openControlInstallation,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
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
import {
  ConfigurationMaintenance,
  createMaintenance,
  type MaintenanceAdapters,
  MaintenanceFenceRefused,
  type MaintenanceFile,
  readHandoffOutcome,
  readMaintenance,
  writeHandoffProgress,
} from "./maintenance";

vi.mock("@openmapx/core/data-manager-sdk", async (original) => ({
  ...(await original<typeof import("@openmapx/core/data-manager-sdk")>()),
  settleDataConfigurationFence: vi.fn(),
}));

const maintenanceId = "33333333-3333-4333-8333-333333333333";
const candidateId = "44444444-4444-4444-8444-444444444444";
const apiJobId = "11111111-1111-4111-8111-111111111111";
const handoffId = "66666666-6666-4666-8666-666666666666";
const revisionId = `cfg1_${"a".repeat(43)}`;
const oldContainer = "1".repeat(64);
const image = `sha256:${"2".repeat(64)}`;

function plan(options: { handoff?: boolean } = {}) {
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
let helper: { id: string; running: boolean; exitCode: number | null } | null;
let order: string[];
let adapters: MaintenanceAdapters;

function admit(options: { handoff?: boolean } = {}) {
  return createMaintenance(installation, {
    plan: plan(options),
    originalContainers: [],
    apiJobId,
    leaseId: "88888888-8888-4888-8888-888888888888",
    now: new Date(),
  });
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
  order = [];
  adapters = {
    now: () => new Date(),
    prepareFence: vi.fn(async (file) => {
      order.push("prepare-fence");
      return fence("prepared", file);
    }),
    fenceDelegated: () => true,
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
      helper = { id: "c".repeat(64), running: true, exitCode: null };
      return { containerId: helper.id };
    }),
    findHelper: vi.fn(async () => helper),
    settleHandoff: vi.fn(async (_file, outcome) => {
      order.push(`settle-handoff:${outcome}`);
    }),
    removeHelper: vi.fn(async () => {
      order.push("remove-helper");
      helper = null;
    }),
    cancelLease: vi.fn(async () => {
      order.push("cancel-lease");
    }),
    releaseLease: vi.fn(async () => {
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
    adapters.fenceDelegated = () => false;
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
    helper = { id: "c".repeat(64), running: false, exitCode: 0 };
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

  it("keeps the record settling when the fence settlement fails, and a later settle retries", async () => {
    admit();
    const maintenance = new ConfigurationMaintenance(installation, adapters);
    await maintenance.prepare(maintenanceId, AbortSignal.timeout(5000));
    const settleFence = adapters.settleFence;
    adapters.settleFence = async () => {
      throw Error("data-manager unreachable");
    };
    await expect(
      maintenance.settle(maintenanceId, "abandon", AbortSignal.timeout(5000)),
    ).rejects.toThrow();
    expect(readMaintenance(installation, maintenanceId).record.state).toBe("settling");
    adapters.settleFence = settleFence;
    expect(
      (await maintenance.settle(maintenanceId, "complete", AbortSignal.timeout(5000))).state,
    ).toBe("settled");
    expect(order).toEqual(["prepare-fence", "settle-fence:unused", "release"]);
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
    helper = { id: "c".repeat(64), running: false, exitCode: 1 };
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
    helper = { id: "c".repeat(64), running: true, exitCode: null };
    progress("applied", "verified");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("running");
  });

  it("is committed only for exit 0 with every target verified, contained for a clean cancel", async () => {
    admit({ handoff: true });
    const record = {
      ...readMaintenance(installation, maintenanceId).record,
      handoff: { handoffId, containerId: null },
    };
    helper = { id: "c".repeat(64), running: false, exitCode: 0 };
    progress("applied", "verified");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("committed");
    helper = { id: "c".repeat(64), running: false, exitCode: 1 };
    progress("cancelled", "pending");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("contained");
    progress("cancelled", "recreate_attempted");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
    progress("failed", "pending");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
    helper = null;
    progress("applying", "recreate_attempted");
    expect(await readHandoffOutcome(installation, adapters, record)).toBe("unknown");
  });
});
