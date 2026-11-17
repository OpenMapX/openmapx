/** The agent's configuration maintenance against the host: the data-manager
 * fence, each step as a child of the maintenance's lease, the helper container
 * and the release of the lease. The record and its transitions are in
 * `maintenance.ts`; the server calls the operation handlers here. */
import { createHash } from "node:crypto";
import {
  type ArtifactTargetLease,
  adoptArtifactTargetLease,
  bindBorrowedControlExecution,
  bindControlChildPhase,
  type ControlInstallation,
  closeArtifactTargetLeaseHandle,
  consumeControlChildDispatch,
  controlDigest,
  inspectArtifactDelegation,
  inspectConfigurationPreEffectRefusal,
  issueControlChildPhase,
  type LeaseStore,
  localLeaseBackend,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  releaseArtifactTargetLease,
  restoreAdmittedControlExecution,
  restoreArtifactTargetLeaseForSettlement,
  restoreConfigurationMaintenancePhaseIssuer,
  retainAdmittedControlExecution,
  retainControlEffectReceipt,
  retainGenerationHardlinksOwnerPlan,
  settleArtifactTargetLeaseChild,
  settleIssuedLeaseChild,
  type VerifiedExecutionAuthority,
  verifiedParentForArtifactDelegation,
  verifyControlEffectSettlement,
  verifyRetainedLocalControlPeer,
} from "@openmapx/core/build-artifacts";
import {
  DataManagerHttpError,
  prepareDataConfigurationFence,
  settleDataConfigurationFence,
} from "@openmapx/core/data-manager-sdk";
import {
  type ConfigurationApplyResult,
  canonicalJson,
  configurationApplyResultSchema,
  type ExecutionRef,
  isTrustedConfigurationApplyOperation,
  type MaintenanceRecord,
  type MaintenanceStepOutcome,
  type OpsOperation,
  type OpsResultFor,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import {
  childSettlementState,
  inspectConfigurationGenerationNonCommit,
} from "../../../packages/core/src/build-artifacts/control-authority";
import type { ControlChildReservation } from "../../../packages/core/src/build-artifacts/control-child-records";
import { readConfigurationCandidate } from "./configuration-candidate-source";
import {
  configurationHandoffRunArgs,
  inspectConfigurationHandoffPrerequisite,
} from "./configuration-handoff";
import {
  configurationDataManagerTransport,
  prepareConfigurationHardlinksAdmission,
} from "./configuration-hardlinks-runtime";
import { isReportedProcessFailure } from "./docker-runtime";
import type { OpsJobJournal } from "./journal";
import {
  ConfigurationMaintenance,
  type MaintenanceAdapters,
  MaintenanceFenceRefused,
  type MaintenanceFile,
} from "./maintenance";
import { maintenanceSource, planConfigurationMaintenance } from "./maintenance-source";
import { type OpsExecutionContext, OpsExecutionFailure, type OpsRuntime } from "./runtime";

/** What the server gives the maintenance: its installation, lease store and a
 * way to run one step operation as it runs any other. */
export interface MaintenanceRuntimeDeps {
  runtime: OpsRuntime;
  installation: ControlInstallation;
  store: LeaseStore;
  journal: Pick<OpsJobJournal, "records">;
  /** Claims and dispatches one step operation under its own child execution. */
  runStepOperation(
    operation: OpsOperation,
    context: Omit<OpsExecutionContext, "claim">,
    payload?: TrustedConfigurationPayload,
  ): Promise<unknown>;
  /** Operations other than the running apply that replacing the agent would end. */
  otherActiveOperations(): number;
  now?: () => Date;
}

/** A lease child key derived from the handoff id, so a restarted agent finds it. */
function derivedKey(handoffId: string, purpose: string): string {
  const d = createHash("sha256")
    .update(`openmapx-configuration-handoff-${purpose}\0${handoffId}`)
    .digest("hex");
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}

/** A reserved child's execution, for a child recorded in the store directly. */
function reservedExecution(reservation: ControlChildReservation, deadlineAt: number): ExecutionRef {
  return {
    ...reservation.execution,
    operationFingerprint: reservation.operationFingerprint,
    deadlineAt,
    fingerprint: controlDigest({
      kind: reservation.kind,
      operationFingerprint: reservation.operationFingerprint,
      deadlineAt,
    }),
  };
}

/** Repeats one idempotent data-manager call while it answers a server error or
 * nothing, until the deadline; any other answer is final. */
async function retryDataManager<T>(
  signal: AbortSignal,
  deadlineAt: number,
  call: () => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (
        signal.aborted ||
        Date.now() >= deadlineAt ||
        (error instanceof DataManagerHttpError && error.status < 500 && error.status !== 429)
      )
        throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(5000, 250 * 2 ** attempt)));
  }
}

const settlementDigest = (value: unknown) => controlDigest(value);

export function createMaintenanceRuntime(deps: MaintenanceRuntimeDeps) {
  const { installation, store } = deps;
  const leases = localLeaseBackend(store);
  /** The lease handle of each preparation while its operation runs. */
  const preparing = new Map<string, ArtifactTargetLease>();
  const root = (file: MaintenanceFile): VerifiedExecutionAuthority =>
    restoreAdmittedControlExecution(installation, file.plan.prepare);
  const reservationOf = (file: MaintenanceFile, phase: string, ordinal?: number) => {
    const found = file.plan.reservations.find(
      (value) => value.phase === phase && (ordinal === undefined || value.ordinal === ordinal),
    );
    if (!found) throw Error("Maintenance reservation missing");
    return found;
  };
  const fenceAssertion = (file: MaintenanceFile): string => {
    const attempt = lookupControlChildPhaseAttempt(
      root(file),
      reservationOf(file, "configuration-fence"),
    );
    if (!attempt || attempt.channel !== "delegation") throw Error("Fence child was not issued");
    return attempt.assertion;
  };
  const handoffKeys = (file: MaintenanceFile) => {
    const handoffId = file.plan.handoff?.handoffId;
    if (!handoffId) throw Error("Maintenance has no handoff");
    return { step: derivedKey(handoffId, "step"), helper: handoffId };
  };

  /** Settles one agent-run step child from its run, as the server settles an operation. */
  async function settleStep(
    authority: VerifiedExecutionAuthority,
    lease: Parameters<typeof settleArtifactTargetLeaseChild>[0],
    execution: ExecutionRef,
    operation: OpsOperation,
    run: { result: unknown } | { error: unknown },
  ): Promise<MaintenanceStepOutcome> {
    const succeeded = "result" in run && run.result !== undefined;
    let recorded = false;
    if (
      succeeded &&
      isTrustedConfigurationApplyOperation(operation) &&
      (run.result as { outcome?: string }).outcome === "not_committed"
    ) {
      const actual = inspectConfigurationGenerationNonCommit(installation, execution);
      if (canonicalJson(actual.result) !== canonicalJson(run.result))
        throw Error("Generation non-commit changed");
      recorded = true;
    } else if (!succeeded) {
      try {
        inspectConfigurationPreEffectRefusal(authority);
        recorded = true;
      } catch {
        /* Only a recorded refusal before the effect is known. */
      }
    }
    const reported =
      "error" in run &&
      (isReportedProcessFailure(run.error) ||
        isReportedProcessFailure((run.error as { cause?: unknown } | undefined)?.cause));
    if (!recorded)
      retainControlEffectReceipt(authority, {
        outcome: succeeded ? "committed" : reported ? "contained" : "unknown",
        publication: succeeded || reported ? "committed" : "unknown",
        receipt: succeeded
          ? { kind: "ops-result", result: (run as { result: unknown }).result }
          : reported
            ? { kind: "reported-failure" }
            : { kind: "unresolved" },
      });
    const evidence = verifyControlEffectSettlement(installation, execution);
    await settleArtifactTargetLeaseChild(lease, evidence);
    return childSettlementState(evidence).evidence.outcome;
  }

  const adapters: MaintenanceAdapters = {
    now: deps.now ?? (() => new Date()),
    fenceDelegated(file) {
      return !!lookupControlChildPhaseBinding(
        root(file),
        reservationOf(file, "configuration-fence"),
      );
    },
    async prepareFence(file, signal) {
      const authority = root(file);
      // The plan is made again under the lease: a host that changed since
      // admission is refused before anything is recorded for the data-manager.
      let current: Awaited<ReturnType<typeof planConfigurationMaintenance>>;
      try {
        current = await planConfigurationMaintenance(deps.runtime, {
          installation,
          execution: file.plan.prepare,
          operation: file.plan.operation,
          apiParent: file.plan.apiParent,
          journal: deps.journal,
          signal,
        });
      } catch {
        throw new MaintenanceFenceRefused();
      }
      if (canonicalJson(current.plan) !== canonicalJson(file.plan))
        throw new MaintenanceFenceRefused();
      const reserved = reservationOf(file, "configuration-fence");
      // The preparation's own lease handle issues the fence child.
      const lease = preparing.get(file.record.maintenanceId);
      if (!lease) throw Error("Preparation lease unavailable");
      const child = await bindControlChildPhase(authority, reserved);
      const issued = await issueControlChildPhase(authority, {
        phase: reserved.phase,
        ordinal: reserved.ordinal,
        lease,
        childId: "data-manager",
        // What an operator's `openmapx control resolve` needs to settle the fence.
        evidence: {
          maintenanceId: file.plan.dmPrepare.maintenanceId,
          candidateId: file.plan.dmPrepare.candidateId,
          planDigest: file.plan.dmPrepare.planDigest,
        },
      });
      consumeControlChildDispatch(issued.dispatchTicket);
      const assertion = issued.assertion;
      let receipt: Awaited<ReturnType<typeof prepareDataConfigurationFence>>;
      try {
        receipt = await retryDataManager(
          signal,
          Math.min(file.plan.prepare.deadlineAt, Date.now() + 15_000),
          () =>
            prepareDataConfigurationFence(file.plan.dmPrepare, {
              transport: configurationDataManagerTransport(),
              controlAssertion: assertion,
              signal,
            }),
        );
      } catch (error) {
        // A busy refusal wrote nothing: the fence child failed without effect.
        if (
          error instanceof DataManagerHttpError &&
          error.status === 409 &&
          error.message.includes("configuration_maintenance_busy")
        ) {
          await settleIssuedLeaseChild(lease, child.execution, {
            outcome: "failed_without_effect",
            publication: "not_started",
            terminalReceiptDigest: settlementDigest({
              kind: "data-configuration-fence-refused",
              maintenanceId: file.plan.operation.maintenanceId,
              reason: "busy",
            }),
          });
          throw new MaintenanceFenceRefused();
        }
        throw error;
      }
      if (
        receipt.state !== "prepared" ||
        receipt.fenceId !== child.execution.executionId ||
        canonicalJson(receipt.ownerPrepare) !== canonicalJson(file.plan.prepare) ||
        receipt.planDigest !== file.plan.planDigest ||
        receipt.revisionId !== file.plan.operation.revisionId ||
        receipt.hardlinkPlanDigest !== file.plan.dmPrepare.hardlinkPlanDigest
      )
        throw Error("Data-manager prepared another fence");
      await settleIssuedLeaseChild(lease, child.execution, {
        outcome: "committed",
        publication: "committed",
        terminalReceiptDigest: settlementDigest({
          kind: "data-configuration-fence",
          receipt: { ...receipt, sequence: 0, state: "prepared" },
        }),
      });
      return receipt;
    },
    async settleFence(file, outcome, signal) {
      const receipt = await retryDataManager(signal, Date.now() + 30_000, () =>
        settleDataConfigurationFence(
          {
            maintenanceId: file.plan.operation.maintenanceId,
            candidateId: file.plan.operation.candidateId,
            planDigest: file.plan.planDigest,
            outcome,
          },
          {
            transport: configurationDataManagerTransport(),
            controlAssertion: fenceAssertion(file),
            signal,
          },
        ),
      );
      if (receipt.state !== "settled") throw Error("Data-manager did not settle the fence");
      return receipt;
    },
    async runStep(file, ordinal, _signal, emitLog) {
      const step = file.record.steps[ordinal]!;
      const planned = file.plan.steps[ordinal]!;
      const operation = planned.operation as OpsOperation;
      const reservation = reservationOf(file, step.phase, ordinal);
      const authority = root(file);
      // A binding left by an earlier run is an attempt this run cannot repeat.
      if (lookupControlChildPhaseBinding(authority, reservation)) return { outcome: "unknown" };
      const issuer = restoreConfigurationMaintenancePhaseIssuer(
        authority,
        step.phase as Parameters<typeof restoreConfigurationMaintenancePhaseIssuer>[1],
      );
      let child: Awaited<ReturnType<typeof bindControlChildPhase>>;
      let assertion: string;
      try {
        child = await bindControlChildPhase(authority, reservation);
        const issued = await issueControlChildPhase(authority, {
          phase: reservation.phase,
          ordinal,
          lease: issuer,
          childId: "ops-agent",
        });
        consumeControlChildDispatch(issued.dispatchTicket);
        assertion = issued.assertion;
      } finally {
        closeArtifactTargetLeaseHandle(issuer);
      }
      // The child is attempted from here: anything that fails is unknown.
      const execution = child.execution;
      const binding = lookupControlChildPhaseBinding(authority, reservation)!;
      const inspected = inspectArtifactDelegation({ installation, assertion });
      const lease = await adoptArtifactTargetLease({
        assertion,
        peer: verifyRetainedLocalControlPeer(installation, {
          assertion,
          execution,
          kind: operation.kind,
        }),
        execution,
        serviceIds: inspected.serviceIds,
      });
      try {
        const childAuthority = retainAdmittedControlExecution(installation, {
          execution,
          kind: operation.kind,
          operation,
          admittedAt: binding.boundAt,
          requestedDeadlineAt: binding.requestedDeadlineAt,
          parent: verifiedParentForArtifactDelegation(installation, assertion, execution),
          serviceIds: lease.serviceIds,
          reservations:
            step.phase === "maintenance-hardlinks" && file.plan.nestedHardlinks
              ? [file.plan.nestedHardlinks]
              : [],
        });
        bindBorrowedControlExecution(lease, childAuthority);
        if (operation.kind === "configuration.hardlinks.apply")
          retainGenerationHardlinksOwnerPlan(
            childAuthority,
            prepareConfigurationHardlinksAdmission(
              deps.runtime,
              execution,
              operation,
              lease.serviceIds,
            ),
          );
        const payload =
          step.phase === "configuration-commit"
            ? (
                await readConfigurationCandidate(
                  maintenanceSource(deps.runtime).candidateSource!,
                  file.plan.operation.candidateId,
                )
              ).payload
            : undefined;
        let run: { result: unknown } | { error: unknown };
        try {
          run = {
            result: await deps.runStepOperation(
              operation,
              {
                execution,
                artifactLease: lease,
                controlAuthority: childAuthority,
                signal: AbortSignal.timeout(Math.max(1, execution.deadlineAt - Date.now())),
                emitLog,
                otherActiveOperations: deps.otherActiveOperations,
              },
              payload,
            ),
          };
        } catch (error) {
          run = { error };
        }
        const outcome = await settleStep(childAuthority, lease, execution, operation, run);
        if (step.phase !== "configuration-commit" || !("result" in run)) return { outcome };
        const generation = configurationApplyResultSchema.parse(run.result);
        return {
          outcome,
          result: generation,
          ...(generation.outcome === "committed"
            ? { appliedRevisionId: generation.revisionId }
            : {}),
        };
      } finally {
        closeArtifactTargetLeaseHandle(lease);
      }
    },
    async launchHelper(file, signal) {
      const source = maintenanceSource(deps.runtime);
      const handoff = file.plan.handoff;
      const nested = file.plan.nestedHandoff;
      const agent = file.originalContainers.find((value) => value.serviceId === "ops-agent");
      if (!handoff || !nested || !agent || agent.state !== "running" || !source.rootDir)
        throw Error("Original running agent required for the handoff");
      const facts = await inspectConfigurationHandoffPrerequisite({
        runDocker: async (args, command) =>
          (
            await source.execFile("docker", args, {
              signal: command.signal,
              timeout: 15000,
              maxBuffer: 65536,
            })
          ).stdout,
        containerId: agent.containerId,
        imageId: agent.provenance.imageId,
        rootDir: source.rootDir,
        signal,
      });
      const reservation = reservationOf(file, "maintenance-handoff");
      const keys = handoffKeys(file);
      const stepExecution = reservedExecution(reservation, file.plan.prepare.deadlineAt);
      // Both children are recorded before the container exists.
      await leases.delegate({
        leaseId: file.record.leaseId,
        child: {
          key: keys.step,
          parentKey: null,
          parent: file.plan.prepare,
          execution: stepExecution,
          kind: reservation.kind,
          phase: reservation.phase,
          recipient: "ops-agent",
          targets: [...reservation.serviceIds],
        },
      });
      await leases.delegate({
        leaseId: file.record.leaseId,
        child: {
          key: keys.helper,
          parentKey: keys.step,
          parent: stepExecution,
          execution: reservedExecution(nested, file.plan.prepare.deadlineAt),
          kind: nested.kind,
          phase: nested.phase,
          recipient: "configuration-helper",
          targets: [...nested.serviceIds],
        },
      });
      // Admissions are closed while the handoff runs; what still runs finishes
      // before the helper may replace the agent.
      while (deps.otherActiveOperations() > 0) {
        signal.throwIfAborted();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const started = await source.execFile(
        "docker",
        configurationHandoffRunArgs(facts, source.rootDir, {
          handoffId: handoff.handoffId,
          maintenanceId: file.record.maintenanceId,
          leaseId: file.record.leaseId,
          leaseChild: keys.helper,
        }),
        { signal, timeout: 30000, maxBuffer: 65536 },
      );
      const id = started.stdout.trim();
      return { containerId: /^[a-f0-9]{64}$/.test(id) ? id : null };
    },
    async findHelper(handoffId) {
      const source = maintenanceSource(deps.runtime);
      const listed = await source.execFile(
        "docker",
        [
          "ps",
          "-a",
          "--no-trunc",
          "--filter",
          `label=openmapx.configuration-handoff=${handoffId}`,
          "--format",
          "{{.ID}}",
        ],
        { signal: AbortSignal.timeout(15000), timeout: 15000, maxBuffer: 65536 },
      );
      const ids = listed.stdout
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean);
      if (ids.length > 1) throw Error("More than one configuration helper container");
      if (!ids[0]) return null;
      const inspected = await source.execFile(
        "docker",
        ["container", "inspect", "--format", "{{json .State}}", ids[0]],
        { signal: AbortSignal.timeout(15000), timeout: 15000, maxBuffer: 65536 },
      );
      const state = JSON.parse(inspected.stdout) as { Running?: boolean; ExitCode?: number };
      return {
        id: ids[0],
        running: state.Running === true,
        exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      };
    },
    async removeHelper(containerId) {
      await maintenanceSource(deps.runtime).execFile("docker", ["rm", containerId], {
        signal: AbortSignal.timeout(15000),
        timeout: 15000,
        maxBuffer: 65536,
      });
    },
    async settleHandoff(file, outcome) {
      if (outcome === "unknown") return;
      const keys = handoffKeys(file);
      const lease = leases.readSync(file.record.leaseId);
      const helper = lease?.children.find((child) => child.key === keys.helper);
      const step = lease?.children.find((child) => child.key === keys.step);
      // A helper settles its own child; one that never started, or exited
      // before it settled, is settled here from the outcome its progress shows.
      if (helper && helper.state !== "settled") {
        if (helper.adopted && outcome === "failed_without_effect")
          throw Error("A started configuration helper cannot be without effect");
        await leases.settle({
          leaseId: file.record.leaseId,
          key: helper.key,
          settlement: {
            identity: helper.execution,
            outcome,
            publication: outcome === "failed_without_effect" ? "not_started" : "committed",
            terminalReceiptDigest: settlementDigest({
              kind: "configuration-helper-outcome",
              handoffId: keys.helper,
              outcome,
            }),
          },
        });
      }
      if (step && step.state !== "settled")
        await leases.settle({
          leaseId: file.record.leaseId,
          key: step.key,
          settlement: {
            identity: step.execution,
            outcome,
            publication: outcome === "failed_without_effect" ? "not_started" : "committed",
            terminalReceiptDigest: settlementDigest({
              kind: "configuration-handoff-step",
              handoffId: keys.helper,
              outcome,
            }),
          },
        });
    },
    async cancelLease(file) {
      const lease = leases.readSync(file.record.leaseId);
      if (!lease) return;
      await leases.cancel({ leaseId: lease.leaseId, key: null });
      for (const child of lease.children)
        if (child.state === "held") await leases.cancel({ leaseId: lease.leaseId, key: child.key });
    },
    async releaseLease(file) {
      const authority = root(file);
      // The root's own effect is the preparation's: committed once it prepared,
      // otherwise nothing ran under it.
      try {
        verifyControlEffectSettlement(installation, file.plan.prepare);
      } catch {
        retainControlEffectReceipt(authority, {
          outcome: "failed_without_effect",
          publication: "not_started",
          receipt: {
            kind: "configuration-fence-not-prepared",
            maintenanceId: file.record.maintenanceId,
          },
        });
      }
      if (!leases.readSync(file.record.leaseId)) return;
      const lease = restoreArtifactTargetLeaseForSettlement(authority);
      try {
        await settleArtifactTargetLeaseChild(
          lease,
          verifyControlEffectSettlement(installation, file.plan.prepare),
        );
        await releaseArtifactTargetLease(lease);
      } finally {
        closeArtifactTargetLeaseHandle(lease);
      }
    },
  };
  const maintenance = new ConfigurationMaintenance(installation, adapters);

  /** Turns a record a handler cannot return into the operation's failure. */
  const failIf = (record: MaintenanceRecord) => {
    if (record.state === "recovery_required")
      throw new OpsExecutionFailure("recovery_required", {});
    return record;
  };

  return {
    maintenance,
    async prepare(
      operation: Extract<OpsOperation, { kind: "configurationMaintenance.prepare" }>,
      context: OpsExecutionContext,
    ): Promise<OpsResultFor<"configurationMaintenance.prepare">> {
      if (!context.ownedTargetLease) throw Error("Preparation lease unavailable");
      preparing.set(operation.maintenanceId, context.ownedTargetLease);
      let record: MaintenanceRecord;
      try {
        record = await maintenance.prepare(operation.maintenanceId, context.signal);
      } finally {
        preparing.delete(operation.maintenanceId);
      }
      if (record.state === "prepared") return record;
      // Nothing was prepared and the lease is released: the targets were busy.
      if (record.state === "settled") throw new OpsExecutionFailure("busy", {});
      throw new OpsExecutionFailure("recovery_required", {});
    },
    async apply(
      operation: Extract<OpsOperation, { kind: "configurationMaintenance.apply" }>,
      context: OpsExecutionContext,
      apiJobId: string,
    ): Promise<OpsResultFor<"configurationMaintenance.apply">> {
      // A termination request cancels the maintenance: the step in flight ends
      // and no further step starts.
      const cancel = () =>
        void maintenance
          .cancel(operation.maintenanceId, AbortSignal.timeout(30_000))
          .catch(() => undefined);
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        const out = await maintenance.applySteps(
          operation.maintenanceId,
          apiJobId,
          AbortSignal.timeout(Math.max(1, context.execution.deadlineAt - Date.now())),
          (stream, message) => context.emitLog(stream, message),
        );
        if (out.outcome === "unknown") throw new OpsExecutionFailure("recovery_required", {});
        return {
          outcome: out.outcome,
          record: out.record,
          generation: (out.generation as ConfigurationApplyResult | null) ?? null,
        };
      } finally {
        context.signal.removeEventListener("abort", cancel);
      }
    },
    async settle(
      operation: Extract<OpsOperation, { kind: "configurationMaintenance.settle" }>,
      context: OpsExecutionContext,
    ): Promise<OpsResultFor<"configurationMaintenance.settle">> {
      return failIf(
        await maintenance.settle(operation.maintenanceId, operation.outcome, context.signal),
      );
    },
    async inspect(
      operation: Extract<OpsOperation, { kind: "configurationMaintenance.inspect" }>,
    ): Promise<OpsResultFor<"configurationMaintenance.inspect">> {
      return maintenance.inspect(operation.maintenanceId);
    },
  };
}
export type MaintenanceRuntime = ReturnType<typeof createMaintenanceRuntime>;
