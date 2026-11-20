import {
  type ControlInstallation,
  cancelArtifactTargetLease,
  cancelControlExecution,
  type ExecutionHandle,
  inspectConfigurationPreEffectRefusal,
  inspectFeedProxyValidationFailure,
  releaseArtifactTargetLease,
  reserveFeedProxyValidation,
  retainControlEffectReceipt,
  settleArtifactTargetLeaseChild,
  verifyControlEffectSettlement,
  verifyLocalArtifactTargetRootRelease,
} from "@openmapx/core/build-artifacts";
import { retainUnstartedArtifactImport } from "@openmapx/core/build-artifacts/publication";
import {
  canonicalJson,
  isTrustedConfigurationApplyOperation,
  type OpsOperation,
  type OpsOperationKind,
} from "@openmapx/core/ops";
import { inspectConfigurationGenerationNonCommit } from "../../../packages/core/src/build-artifacts/execution-record";
import type { ArtifactTransferStore } from "./artifact-transfer/store";
import { readCommittedCatalogApproval } from "./catalog-approval-runtime";
import type {
  JobHandles,
  JobRecord,
  TerminalOutcome,
  TerminalSettlement,
  TerminalState,
  TransitionUpdates,
} from "./job-table";
import type { OpsExecutionContext, OpsRuntime } from "./runtime";

/**
 * Operations that change containers claim their targets in the lease store
 * before any effect. Pulls, builds, execs and probes leave running containers
 * alone and claim nothing.
 */
export const LEASED_KINDS = new Set<OpsOperationKind>([
  "configurationMaintenance.prepare",
  "artifactTransfer.import",
  "artifactTransfer.export",
  "stack.start",
  "stack.stop",
  "coreService.restart",
  "service.start",
  "service.stop",
  "service.restart",
  "service.remove",
  "service.recreate",
  "service.recreateIsolated",
  "service.update",
  "serviceRepository.remove",
  "backup.create",
  "backup.restore",
  "configuration.hardlinks.apply",
  "valhalla.traffic.maintain",
  "valhalla.traffic.refreshWaysToEdges",
]);

/** How a root ends when its kind records its own terminal evidence. */
type KindVerdict =
  /** The kind's producer recorded the terminal record itself. */
  | { type: "own" }
  /** Nothing started: the root is released without a receipt. */
  | { type: "unstarted" }
  /** The kind's receipt replaces the generic one. */
  | { type: "receipt"; record: Parameters<typeof retainControlEffectReceipt>[1] };

interface SettlementDeps {
  runtime: OpsRuntime;
  installation: ControlInstallation;
  artifactTransfers: ArtifactTransferStore | undefined;
}

/** What one operation kind adds to running and settling a root. */
interface KindSettlement {
  /** The fixed runtime begins its effect itself, immediately before its first host call. */
  beginsOwnEffect?: (operation: OpsOperation) => boolean;
  /** Recorded under the root's authority before the effect begins. */
  beforeEffect?: (job: JobRecord, authority: ExecutionHandle, claim: Claim) => Promise<void>;
  /** A failed run records that it was refused before any effect, unless one began. */
  refusesBeforeEffectOnError?: true;
  /** Completes with its validated result after a cancel or timeout: its host call had settled. */
  completesAfterCancel?: (job: JobRecord, result: unknown) => boolean;
  /** Outside the admission lock, before the terminal write. */
  observe?: (
    job: JobRecord,
    state: TerminalState,
    handles: JobHandles,
    deps: SettlementDeps,
  ) => Promise<Observation | undefined>;
  /** Under the admission lock: the kind's own terminal evidence. */
  verdict?: (input: {
    job: JobRecord;
    state: TerminalState;
    updates: TransitionUpdates;
    authority: ExecutionHandle;
    committed: boolean;
    deps: SettlementDeps;
  }) => KindVerdict | undefined | Promise<KindVerdict | undefined>;
  /** The maintenance record, not the operation, settles and releases the root lease. */
  keepsRootLease?: true;
  /** A released root reconciles the kind's prepared files. */
  reconcilesAfterRelease?: true;
  /** The result an unstarted root ends with instead of its failure. */
  unstartedResult?: unknown;
  /** Its success replaces the evidence its failure would keep. */
  dropsFailureResultOnSuccess?: true;
}
type Claim = OpsExecutionContext["claim"];
interface Observation {
  outcome?: TerminalOutcome;
  verdict?: KindVerdict;
}

const onlyFor =
  (role: JobRecord["role"]) =>
  (job: JobRecord): boolean =>
    job.role === role;
const always = () => true;
const motisLeaf: KindSettlement = { completesAfterCancel: onlyFor("data-manager") };

const KIND_SETTLEMENT: Partial<Record<OpsOperationKind, KindSettlement>> = {
  "coreService.restart": { beginsOwnEffect: always },
  "service.image.stage": { beginsOwnEffect: always, refusesBeforeEffectOnError: true },
  "backup.prune": {
    beginsOwnEffect: always,
    refusesBeforeEffectOnError: true,
    completesAfterCancel: onlyFor("api"),
  },
  // The fixed DM pull runtime performs its source/target-index checks under
  // writer -> release lock, then begins immediately before Docker.
  "service.pull": {
    beginsOwnEffect: (operation) =>
      operation.kind === "service.pull" &&
      operation.serviceId === "data-manager" &&
      !!operation.candidateId,
  },
  "services.buildAll": { dropsFailureResultOnSuccess: true },
  // A cancelled maintenance ends with the step that was in flight.
  "configurationMaintenance.apply": { completesAfterCancel: onlyFor("api") },
  // A preparation that did not prepare is settled by its maintenance record,
  // which released its lease when nothing ran and keeps it otherwise.
  "configurationMaintenance.prepare": {
    keepsRootLease: true,
    verdict: ({ committed }) => (committed ? undefined : { type: "own" }),
  },
  "artifactTransfer.import": {
    // This fixed publisher begins only after validation, destination
    // materialization and compatibility checks, immediately before its
    // journaled managed-directory transaction.
    beginsOwnEffect: always,
    completesAfterCancel: (job, result) =>
      job.role === "api" && (result as { outcome?: string }).outcome === "committed",
    verdict: async ({ state, updates, authority, committed }) => {
      if (state === "failed") {
        try {
          await retainUnstartedArtifactImport(authority);
          return { type: "unstarted" };
        } catch {
          return undefined; /* Attempted publication remains fenced. */
        }
      }
      return committed && (updates.result as { outcome?: string })?.outcome === "not_committed"
        ? {
            type: "receipt",
            record: {
              outcome: "contained",
              publication: "not_started",
              receipt: { kind: "ops-result", result: updates.result },
            },
          }
        : undefined;
    },
    reconcilesAfterRelease: true,
    unstartedResult: { outcome: "not_committed", reason: "failed", cleanupFailed: false },
  },
  "artifactTransfer.validate": {
    // The fixed runtime's validated result is own-effect evidence; a failure
    // is contained here, or stays unknown.
    observe: async (_job, state, { authority }, deps) => {
      if (state !== "failed" || !authority || !deps.artifactTransfers) return undefined;
      try {
        const contained = await deps.artifactTransfers.containPreparedValidation(authority);
        await retainControlEffectReceipt(authority, {
          outcome: "committed",
          publication: "committed",
          receipt: { kind: "ops-result", result: contained },
        });
        return { verdict: { type: "own" } };
      } catch {
        return undefined; /* Uncontained extraction remains unknown. */
      }
    },
  },
  "feedProxy.validateAndReload": {
    completesAfterCancel: onlyFor("data-manager"),
    beforeEffect: async (job, authority, claim) => {
      if (job.operation.kind !== "feedProxy.validateAndReload") return;
      const digest = claim.capability.values.candidateDigest;
      if (typeof digest !== "string") throw Error("Original candidate claim missing");
      await reserveFeedProxyValidation(authority, job.operation.candidateId, digest);
    },
    verdict: ({ state, authority }) => {
      if (state !== "failed") return undefined;
      let validationFailure: string | null = null;
      try {
        validationFailure = inspectFeedProxyValidationFailure(authority);
      } catch {
        /* Missing/corrupt producer evidence stays unknown. */
      }
      return validationFailure
        ? {
            type: "receipt",
            record: {
              outcome: "contained",
              publication: "not_started",
              receipt: {
                kind: "feed-proxy-validation-failure",
                commitmentDigest: validationFailure,
              },
            },
          }
        : undefined;
    },
  },
  "transitousLock.approve": {
    completesAfterCancel: onlyFor("data-manager"),
    // A committed catalog approval is the outcome, whatever the worker reported.
    observe: async (job, _state, { authority, lease }, deps) => {
      if (!authority || !lease || job.operation.kind !== "transitousLock.approve") return undefined;
      const published = await readCommittedCatalogApproval(
        deps.runtime,
        authority,
        lease,
        job.operation,
      );
      return published
        ? {
            outcome: {
              state: "succeeded",
              updatedAt: new Date(published.terminalAt).toISOString(),
              updates: {
                result: published.result,
                terminalAt: published.terminalAt,
                errorClass: undefined,
                failureResult: undefined,
              },
            },
          }
        : undefined;
    },
  },
  "motis.primary.stop": motisLeaf,
  "motis.staging.stop": motisLeaf,
  "motis.staging.restart": motisLeaf,
  "motis.primary.restart": motisLeaf,
  "motis.primary.promote": motisLeaf,
};

/** A trusted apply that did not commit has its writer's own non-commit record. */
const TRUSTED_APPLY: KindSettlement = {
  verdict: async ({ state, updates, authority, deps }) => {
    if (
      state !== "succeeded" ||
      !updates.result ||
      (updates.result as { outcome?: string }).outcome !== "not_committed"
    )
      return undefined;
    const actual = await inspectConfigurationGenerationNonCommit(
      deps.installation,
      authority.execution,
    );
    if (canonicalJson(actual.result) !== canonicalJson(updates.result))
      throw Error("Original writer noncommit result changed");
    return { type: "own" };
  },
};

function kindSettlement(operation: OpsOperation): KindSettlement | undefined {
  return (
    KIND_SETTLEMENT[operation.kind] ??
    (isTrustedConfigurationApplyOperation(operation) ? TRUSTED_APPLY : undefined)
  );
}

/** Whether the server begins the root's effect before dispatching it. */
export function beginsEffectAtDispatch(operation: OpsOperation): boolean {
  return !kindSettlement(operation)?.beginsOwnEffect?.(operation);
}
export async function beforeEffect(
  job: JobRecord,
  authority: ExecutionHandle,
  claim: Claim,
): Promise<void> {
  await kindSettlement(job.operation)?.beforeEffect?.(job, authority, claim);
}
export function refusesBeforeEffectOnError(operation: OpsOperation): boolean {
  return kindSettlement(operation)?.refusesBeforeEffectOnError === true;
}
export function completesAfterCancel(job: JobRecord, result: unknown): boolean {
  return kindSettlement(job.operation)?.completesAfterCancel?.(job, result) ?? false;
}

/**
 * Settles a root's terminal outcome: its effect receipt (the kind's own
 * evidence, or committed, reported failure or unknown), its lease child, and
 * the release of a lease whose outcome is known. Unknown never releases.
 */
export function createTerminalSettlement(options: {
  runtime: OpsRuntime;
  installation: ControlInstallation | undefined;
  artifactTransfers: ArtifactTransferStore | undefined;
}): TerminalSettlement<Observation> & { reportedFailures: Set<string> } {
  const reportedFailures = new Set<string>();
  const deps = (): SettlementDeps => {
    if (!options.installation) throw Error("Missing control settlement installation");
    return {
      runtime: options.runtime,
      installation: options.installation,
      artifactTransfers: options.artifactTransfers,
    };
  };
  return {
    reportedFailures,
    async observe(job, state, handles) {
      const entry = kindSettlement(job.operation);
      if (!entry?.observe || !handles.authority) return {};
      return (await entry.observe(job, state, handles, deps())) ?? {};
    },
    async cancel({ authority, lease }) {
      if (authority) await cancelControlExecution(authority);
      if (lease) await cancelArtifactTargetLease(lease);
    },
    dropsFailureResultOnSuccess(job) {
      return kindSettlement(job.operation)?.dropsFailureResultOnSuccess === true;
    },
    async settle({ job, state: requested, updates: requestedUpdates, handles, observation }) {
      const { authority, lease } = handles;
      if (!authority) throw Error("Original execution authority missing");
      const resolved = deps();
      let state = observation?.outcome?.state ?? requested;
      let updates = observation?.outcome
        ? { ...requestedUpdates, ...observation.outcome.updates }
        : requestedUpdates;
      const updatedAt = observation?.outcome?.updatedAt;
      if (state !== "succeeded" && state !== "failed" && state !== "timed_out")
        return { state, updates, updatedAt };
      const entry = kindSettlement(job.operation);
      const committed = state === "succeeded" && updates.result !== undefined;
      const verdict =
        observation?.verdict ??
        (await entry?.verdict?.({ job, state, updates, authority, committed, deps: resolved }));
      let unstartedConfiguration = false;
      if (state === "failed") {
        try {
          await inspectConfigurationPreEffectRefusal(authority);
          unstartedConfiguration = true;
        } catch {
          /* Only the actual fixed pre-effect source qualifies. */
        }
      }
      // A command that failed by its own report releases its targets with a
      // failed result; a crash, timeout or lost daemon stays unknown.
      const reportedFailure = state === "failed" && reportedFailures.delete(job.operationId);
      const unstarted = unstartedConfiguration || verdict?.type === "unstarted";
      if (!unstarted && verdict?.type !== "own")
        await retainControlEffectReceipt(
          authority,
          verdict?.type === "receipt"
            ? verdict.record
            : {
                outcome: committed ? "committed" : reportedFailure ? "contained" : "unknown",
                publication: committed || reportedFailure ? "committed" : "unknown",
                receipt: committed
                  ? { kind: "ops-result", result: updates.result }
                  : reportedFailure
                    ? { kind: "reported-failure" }
                    : { kind: "unresolved" },
              },
        );
      let releaseUnstartedRoot = false;
      if (lease && !entry?.keepsRootLease) {
        await settleArtifactTargetLeaseChild(
          lease,
          await verifyControlEffectSettlement(resolved.installation, authority.execution),
        );
        if (lease.mode === "owner" && (committed || reportedFailure)) {
          await releaseArtifactTargetLease(lease);
          if (entry?.reconcilesAfterRelease) {
            try {
              await resolved.artifactTransfers?.reconcileReleasedPreparedImport(authority);
            } catch {
              /* Keep unexplained purpose state pinned. */
            }
          }
        }
        if (lease.mode === "owner" && unstarted) releaseUnstartedRoot = true;
      }
      if (releaseUnstartedRoot && entry?.unstartedResult !== undefined) {
        state = "succeeded";
        updates = {
          ...updates,
          result: entry.unstartedResult,
          errorClass: undefined,
          failureResult: undefined,
        };
      }
      return {
        state,
        updates,
        updatedAt,
        ...(releaseUnstartedRoot && lease?.mode === "owner"
          ? {
              async beforeWrite() {
                await releaseArtifactTargetLease(lease);
                await verifyLocalArtifactTargetRootRelease(authority);
                if (entry?.reconcilesAfterRelease)
                  await resolved.artifactTransfers?.reconcileReleasedPreparedImport(authority);
              },
            }
          : {}),
      };
    },
  };
}
