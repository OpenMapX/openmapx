import { setTimeout as settleDelay } from "node:timers/promises";
import {
  type ArtifactTargetLease,
  acquireArtifactTargetLease,
  assertArtifactTargetLeaseForward,
  assertControlExecutionForward,
  ControlExecutionFencedError,
  type ControlInstallation,
  cancelArtifactTargetLease,
  cancelControlExecution,
  closeArtifactTargetLeaseHandle,
  releaseArtifactTargetLease,
  restoreAdmittedControlExecution,
  restoreArtifactTargetLeaseForSettlement,
  retainAdmittedControlExecution,
  settleArtifactTargetLeaseChild,
  settleOwnLeaseChild,
  TargetBusyError,
  type VerifiedExecutionAuthority,
  type VerifiedPreparedGenerationAdmission,
  verifyControlEffectSettlement,
} from "@openmapx/core/build-artifacts";
import {
  type DataExecutionIdentity,
  type DataExecutionInput,
  type DataExecutionResult,
  type DataExecutionStatus,
  dataExecutionResultSchema,
  isDataExecutionTerminal,
} from "@openmapx/core/data-manager-contracts";
import {
  type ExecutionRef,
  OpsClientError,
  type VerifiedParentExecution,
} from "@openmapx/core/ops";
import { jobChildLogger } from "../../logger.js";
import { cancelAndSettleRetainedTransitousScripts } from "../transitous/script-runner.js";
import { dataExecutionDiagnostic } from "./diagnostics.js";
import {
  cancelAndSettleOwnedDataOpsChildren,
  type DataOpsChildAttempt,
  dataChildControlReservation,
} from "./ops-children.js";
import { ownedLease } from "./owned-lease.js";
import type { DataExecutionPatch, DataExecutionRecord, DataExecutionStore } from "./store.js";
import { withDataExecutionScope } from "./worker-scope.js";
export type DataExecutionProgressPatch = Partial<
  Pick<DataExecutionStatus, "progress" | "diagnostics" | "publication">
>;
export class DataExecutionOwnershipLost extends Error {}
export class DataExecutionRuntimeUnavailable extends Error {
  readonly statusCode = 503;
}
export interface DataExecutionContext {
  readonly execution: ExecutionRef;
  readonly executionVersion: number;
  readonly signal: AbortSignal;
  /** The execution's own lease in the agent's store. A hardlink leaf runs under
   * its caller's lease and has none. */
  readonly targetAuthority?: ArtifactTargetLease;
  readonly authority: VerifiedExecutionAuthority;
  readonly installation: ControlInstallation;
  readonly store: DataExecutionStore;
  readonly dataRoot: string;
  record(): Promise<DataExecutionRecord>;
  checkpoint(patch: DataExecutionProgressPatch): Promise<void>;
  checkpointChild(attempt: DataOpsChildAttempt): Promise<void>;
  write<T>(
    run: (record: DataExecutionRecord) => Promise<{ record: DataExecutionRecord; value: T }>,
  ): Promise<T>;
  assertForward(): void;
}
export interface DataExecutionRuntime {
  admit(
    input: DataExecutionInput,
    options: {
      preparedGeneration?: VerifiedPreparedGenerationAdmission;
      operationKey: string;
      requestedDeadlineAt?: number;
      parent?: VerifiedParentExecution;
      id?: string;
      principal?: ExecutionRef["principal"];
      hardlinkPlan?: unknown;
      /** For a hardlink leaf: the targets of the issuer's lease it runs under. */
      serviceIds?: readonly string[];
      sourceJobId?: string;
      triggeredBy?: string;
      idempotencyKey?: string;
      /** Checks the normalized identity against what the caller named. */
      adopt?: (execution: ExecutionRef) => Promise<undefined>;
    },
  ): Promise<DataExecutionStatus>;
  inspect(id: string): Promise<DataExecutionStatus | null>;
  lookup(key: string): Promise<DataExecutionStatus | null>;
  lookupByIdempotencyKey?(key: string): Promise<DataExecutionRecord | null>;
  requestCancel(identity: DataExecutionIdentity): Promise<DataExecutionStatus>;
  reconcile(): Promise<void>;
  close(): Promise<void>;
}
/** Settles the execution's own lease after its terminal record, or, for a
 * hardlink leaf, its child in the issuer's lease; checks the terminal while
 * the lease still shows how its children settled; then releases the lease. */
async function releaseOwnLease(
  journal: {
    installation: ControlInstallation;
    verifyContainedTerminal(e: ExecutionRef): Promise<void>;
  },
  execution: ExecutionRef,
  lease: ArtifactTargetLease | undefined,
) {
  if (!lease) {
    await settleOwnLeaseChild(journal.installation, execution);
    await journal.verifyContainedTerminal(execution);
    return;
  }
  await settleArtifactTargetLeaseChild(
    lease,
    verifyControlEffectSettlement(journal.installation, execution),
  );
  await journal.verifyContainedTerminal(execution);
  await releaseArtifactTargetLease(lease);
}
/** Agent answers that refuse a lease acquisition before it records anything. */
const PRE_EFFECT_REFUSALS = new Set(["authorization", "validation", "busy", "conflict"]);
/** Repeats of a lost acquisition: 250 ms doubling to 8 s, about 32 s in all. */
const ACQUIRE_RETRIES = 8;
export function dataExecutionTargetIds(input: DataExecutionInput): string[] {
  return ["transit-sync", "catalog.validate", "catalog.activate"].includes(input.kind)
    ? ["data-manager", "motis", "motis-feed-proxy", "motis-staging"]
    : input.kind === "transit-maintenance"
      ? input.action === "restart-primary"
        ? ["data-manager", "motis"]
        : ["data-manager", "motis-feed-proxy"]
      : ["data-manager"];
}
export function createDataExecutionRuntime(deps: {
  store: DataExecutionStore;
  dispatch(input: DataExecutionInput, context: DataExecutionContext): Promise<DataExecutionResult>;
  now?: () => number;
}): DataExecutionRuntime {
  const { store } = deps,
    journal = store.controlJournal,
    now = deps.now ?? Date.now;
  type LiveEntry = {
    record: DataExecutionRecord;
    context: DataExecutionContext;
    controller: AbortController;
    task: Promise<void>;
    tail: Promise<unknown>;
  };
  const active = new Map<string, LiveEntry>();
  const recovering = new Map<string, Promise<void>>();
  let closed = false;
  function requireJournal() {
    if (!journal)
      throw new DataExecutionRuntimeUnavailable("Durable control prerequisites are unavailable");
    return journal;
  }
  function observationContext(record: DataExecutionRecord): DataExecutionContext {
    const owner = requireJournal(),
      authority = restoreAdmittedControlExecution(owner.installation, record.execution),
      lease =
        record.input.kind === "generation-hardlinks"
          ? undefined
          : restoreArtifactTargetLeaseForSettlement(authority);
    let tail: Promise<unknown> = Promise.resolve(),
      version = record.version;
    const context: DataExecutionContext = {
      execution: record.execution,
      get executionVersion() {
        return version;
      },
      signal: AbortSignal.abort(
        new DOMException("Recovery permits cancellation/observation only", "AbortError"),
      ),
      targetAuthority: lease,
      authority,
      installation: owner.installation,
      store,
      dataRoot: owner.dataRoot,
      async record() {
        const value = await store.inspect(record.status.id);
        if (!value) throw new DataExecutionOwnershipLost("Original execution disappeared");
        return value;
      },
      async write(run) {
        const work = tail.then(async () => {
          const current = await context.record(),
            saved = await run(current);
          version = saved.record.version;
          return saved.value;
        });
        tail = work.catch(() => {});
        return work;
      },
      async checkpoint(patch) {
        await context.write(async (current) => {
          const saved = await store.checkpoint(current.status.id, current.version, patch);
          if (!saved) throw new DataExecutionOwnershipLost("Recovery CAS lost");
          return { record: saved, value: undefined };
        });
      },
      async checkpointChild(child) {
        await context.write(async (current) => {
          const saved = await store.checkpointChild(current.status.id, current.version, child);
          if (!saved) throw new DataExecutionOwnershipLost("Recovery child CAS lost");
          return { record: saved, value: undefined };
        });
      },
      assertForward() {
        throw new DataExecutionOwnershipLost("Recovery permits observation/settlement only");
      },
    };
    return context;
  }
  function cancelRecovered(record: DataExecutionRecord): void {
    if (recovering.has(record.status.id)) return;
    const task = Promise.resolve()
      .then(async () => {
        let context: DataExecutionContext | undefined;
        try {
          context = observationContext(record);
          // A stale or contended forward writer is not containment evidence.
          // It must not prevent authenticated cancellation of an already live child.
          const owned = context;
          const cancelOwnership = async () => {
            const signal = AbortSignal.timeout(15000);
            for (;;) {
              let executionCanceled = false,
                leaseCanceled = false;
              try {
                cancelControlExecution(owned.authority);
                executionCanceled = true;
              } catch {}
              try {
                if (owned.targetAuthority) await cancelArtifactTargetLease(owned.targetAuthority);
                leaseCanceled = true;
              } catch {}
              if (executionCanceled && leaseCanceled) return;
              // Retry only cancellation; never steal a busy writer or renew time.
              await settleDelay(50, undefined, { signal });
            }
          };
          await Promise.allSettled([
            cancelOwnership(),
            cancelAndSettleOwnedDataOpsChildren(context),
            cancelAndSettleRetainedTransitousScripts(context),
          ]);
          // Remote containment cannot manufacture the dead local worker's proof.
          await context.checkpoint({ publication: "unknown" });
        } catch {
          /* Original identity/lease gaps retain the durable cancellation intent. */
        } finally {
          if (context?.targetAuthority) closeArtifactTargetLeaseHandle(context.targetAuthority);
        }
      })
      .finally(() => recovering.delete(record.status.id));
    recovering.set(record.status.id, task);
  }
  async function start(
    record: DataExecutionRecord,
    adopt?: (execution: ExecutionRef) => Promise<undefined>,
    parent?: VerifiedParentExecution,
    hardlinkPlan?: unknown,
    leafTargets?: readonly string[],
  ) {
    const owner = requireJournal(),
      leaf = record.input.kind === "generation-hardlinks",
      targets = leaf && leafTargets ? [...leafTargets] : dataExecutionTargetIds(record.input);
    await adopt?.(record.execution);
    const authority = retainAdmittedControlExecution(owner.installation, {
      execution: record.execution,
      kind: record.input.kind,
      operation: record.input,
      admittedAt: record.status.admittedAt,
      ...(record.requestedDeadlineAt !== null
        ? { requestedDeadlineAt: record.requestedDeadlineAt }
        : {}),
      ...(parent ? { parent } : {}),
      serviceIds: targets,
      reservations: record.reservations.map(dataChildControlReservation),
    });
    if (leaf) {
      if (hardlinkPlan === undefined) throw Error("Durable generation plan required");
      await owner.retainHardlinksPlan(authority, hardlinkPlan);
    }
    // A hardlink leaf runs under the lease of the agent or host CLI that issued it.
    // Other executions claim their targets first: a held target, or an agent
    // that cannot answer, ends the execution as failed before any effect, with
    // its publication unchanged.
    // A timeout or transport failure may come after the agent recorded the lease,
    // so the same acquisition, which returns an existing lease, is repeated for
    // about 30 seconds, long enough for the agent to restart.
    let lease: ArtifactTargetLease | undefined;
    let refusal: unknown;
    for (let attempt = 0; !leaf && !lease && !refusal; attempt += 1)
      try {
        lease = await acquireArtifactTargetLease({ serviceIds: targets, owner: authority });
      } catch (error) {
        if (!(error instanceof TargetBusyError || error instanceof OpsClientError)) throw error;
        const delayMs = Math.min(250 * 2 ** attempt, 8000);
        if (
          error instanceof TargetBusyError ||
          PRE_EFFECT_REFUSALS.has(error.errorClass) ||
          attempt >= ACQUIRE_RETRIES ||
          now() + delayMs >= record.status.deadlineAt
        )
          refusal = error;
        else await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    await owner.begin(authority);
    const controller = new AbortController();
    let entry: LiveEntry;
    const context: DataExecutionContext = {
      execution: record.execution,
      get executionVersion() {
        return entry.record.version;
      },
      signal: controller.signal,
      targetAuthority: lease,
      authority,
      installation: owner.installation,
      store,
      dataRoot: owner.dataRoot,
      async record() {
        const latest = await store.inspect(record.status.id);
        if (!latest) throw new DataExecutionOwnershipLost("Original execution disappeared");
        return latest;
      },
      async write(run) {
        const work = entry.tail.then(async () => {
          const result = await run(entry.record);
          entry.record = result.record;
          return result.value;
        });
        entry.tail = work.catch(() => {});
        return work;
      },
      async checkpoint(patch) {
        await context.write(async (current) => {
          const saved = await store.checkpoint(current.status.id, current.version, patch);
          if (!saved) throw new DataExecutionOwnershipLost("Data execution CAS lost");
          return { record: saved, value: undefined };
        });
      },
      async checkpointChild(child) {
        await context.write(async (current) => {
          const saved = await store.checkpointChild(current.status.id, current.version, child);
          if (!saved) throw new DataExecutionOwnershipLost("Data child CAS lost");
          return { record: saved, value: undefined };
        });
      },
      assertForward() {
        controller.signal.throwIfAborted();
        assertControlExecutionForward(authority);
        if (lease) assertArtifactTargetLeaseForward(lease);
      },
    };
    entry = { record, controller, context, task: Promise.resolve(), tail: Promise.resolve() };
    active.set(record.status.id, entry);
    const timer = setTimeout(
      () => {
        void cancel({
          id: record.status.id,
          operationKey: record.status.operationKey,
          fingerprint: record.status.fingerprint,
        }).catch(() => {});
      },
      Math.max(0, record.status.deadlineAt - now()),
    );
    timer.unref();
    const ancestry = setInterval(() => {
      if (controller.signal.aborted) return;
      try {
        assertControlExecutionForward(authority);
      } catch (error) {
        if (error instanceof ControlExecutionFencedError || now() >= record.status.deadlineAt)
          void cancel({
            id: record.status.id,
            operationKey: record.status.operationKey,
            fingerprint: record.status.fingerprint,
          }).catch(() => {});
      }
    }, 250);
    ancestry.unref();
    entry.task = (async () => {
      try {
        await context.checkpoint({});
        await context.write(async (current) => {
          const saved = await store.checkpoint(current.status.id, current.version, {
            status: "running",
          });
          if (!saved) throw new DataExecutionOwnershipLost("Data start CAS lost");
          return { record: saved, value: undefined };
        });
        const contained = await owner.contain(
          authority,
          Promise.resolve()
            .then(() => {
              if (refusal) throw refusal;
              context.assertForward();
              return withDataExecutionScope(context, () => deps.dispatch(record.input, context));
            })
            .then(
              async (result) => {
                await settleChildren();
                return result;
              },
              async (error) => {
                const diagnostic = dataExecutionDiagnostic(
                  error instanceof Error ? error.message : "Data worker failed",
                );
                await context.checkpoint({
                  diagnostics: {
                    tail: [{ stream: "stderr", message: diagnostic.message }],
                    truncated: diagnostic.truncated,
                  },
                });
                await settleChildren();
                throw error;
              },
            ),
          lease,
        );
        async function settleChildren() {
          for (;;) {
            if ((await cancelAndSettleOwnedDataOpsChildren(context)) === "settled") return;
            await context.checkpoint({ publication: "unknown" });
            await settleDelay(1000);
          }
        }
        await owner.assertOwnedProxyRecoverySettled(record.execution);
        await context.write(async (current) => {
          const result =
            contained.result === undefined
              ? undefined
              : dataExecutionResultSchema.parse(contained.result);
          if (result && result.kind !== record.input.kind)
            throw Error("Dispatcher result kind mismatch");
          const canceled = current.status.cancellationRequestedAt !== null;
          const status = result
            ? result.kind === "catalog.validate" && result.status === "failed"
              ? "error"
              : result.kind === "catalog.activate" && result.outcome !== "activated"
                ? "error"
                : result.kind === "transit-sync"
                  ? result.finalStatus
                  : contained.partial
                    ? "partial"
                    : "ok"
            : canceled
              ? "canceled"
              : "error";
          const patch: DataExecutionPatch = {
            status,
            publication: contained.publication,
            ...(result ? { result } : {}),
            progress: result ? 1 : current.status.progress,
          };
          if (patch.publication === "unknown") {
            const saved = await store.checkpoint(current.status.id, current.version, {
              publication: "unknown",
            });
            if (!saved) throw new DataExecutionOwnershipLost("Data unknown-outcome CAS lost");
            return { record: saved, value: undefined };
          }
          const saved = await store.finalize(
            current.status.id,
            current.version,
            patch,
            contained.completion,
          );
          if (!saved) throw new DataExecutionOwnershipLost("Data terminal CAS lost");
          return { record: saved, value: undefined };
        });
        if (isDataExecutionTerminal(entry.record.status)) {
          await owner.assertOwnedProxyRecoverySettled(record.execution);
          if (!refusal) await releaseOwnLease(owner, record.execution, lease);
        }
      } catch (error) {
        // An I/O/CAS/containment gap is not a terminal receipt or permission to
        // release. Keep original identities and reconcile by observation only.
        jobChildLogger({ job: "data-execution", jobId: record.status.id }).error(
          {
            reason: dataExecutionDiagnostic(
              error instanceof Error ? error.message : "Unknown containment failure",
            ).message,
            trace: dataExecutionDiagnostic(
              error instanceof Error
                ? (error.stack ?? error.message)
                : "Unknown containment failure",
            ).message,
          },
          "Data execution requires original receipt reconciliation",
        );
        try {
          await context.checkpoint({ publication: "unknown" });
        } catch {}
      } finally {
        clearTimeout(timer);
        clearInterval(ancestry);
        if (lease) closeArtifactTargetLeaseHandle(lease);
        active.delete(record.status.id);
      }
    })();
  }
  async function cancel(identity: DataExecutionIdentity) {
    const entry = active.get(identity.id);
    const apply = async () => {
      const saved = await store.requestCancel(identity);
      if (!saved) {
        const e = new Error("Unknown data execution");
        Object.assign(e, { statusCode: 404 });
        throw e;
      }
      if (!isDataExecutionTerminal(saved.status)) {
        const owner = requireJournal(),
          authority =
            entry?.context.authority ??
            restoreAdmittedControlExecution(owner.installation, saved.execution);
        if (entry) cancelControlExecution(authority);
        else cancelRecovered(saved);
        const own = entry?.context.targetAuthority;
        if (own) {
          const until = now() + 15000;
          for (;;) {
            try {
              await cancelArtifactTargetLease(own);
              break;
            } catch (error) {
              if (now() >= until) throw error;
              await settleDelay(50);
            }
          }
        }
        if (entry)
          entry.controller.abort(
            new DOMException("Execution cancellation requested", "AbortError"),
          );
      }
      return saved;
    };
    if (entry)
      return entry.context.write(async () => {
        const saved = await apply();
        return { record: saved, value: saved.status };
      });
    return (await apply()).status;
  }
  return {
    async admit(input, options) {
      if (closed) throw new DataExecutionRuntimeUnavailable("Data execution runtime is closed");
      requireJournal();
      const { created, record } = await store.admit(input, options);
      if (created)
        try {
          await start(
            record,
            options.adopt,
            options.parent,
            options.hardlinkPlan,
            options.serviceIds,
          );
        } catch (cause) {
          await store.checkpoint(record.status.id, record.version, { publication: "unknown" });
          throw new DataExecutionRuntimeUnavailable("Data admission requires ownership recovery", {
            cause,
          });
        }
      return record.status;
    },
    inspect: async (id) => (await store.inspect(id))?.status ?? null,
    lookup: async (key) => (await store.lookup(key))?.status ?? null,
    lookupByIdempotencyKey: async (key) => (await store.lookupByIdempotencyKey?.(key)) ?? null,
    requestCancel: cancel,
    async reconcile() {
      const owner = requireJournal();
      for (const record of await store.listUnsettled()) {
        if (active.has(record.status.id) || recovering.has(record.status.id)) continue;
        if (isDataExecutionTerminal(record.status)) {
          try {
            await owner.assertOwnedProxyRecoverySettled(record.execution);
            await owner.repairTerminal(record.execution);
            await owner.publishTerminal(record.execution);
            const authority = restoreAdmittedControlExecution(owner.installation, record.execution),
              lease =
                record.input.kind === "generation-hardlinks"
                  ? undefined
                  : restoreArtifactTargetLeaseForSettlement(authority);
            try {
              await releaseOwnLease(owner, record.execution, lease);
            } finally {
              if (lease) closeArtifactTargetLeaseHandle(lease);
            }
          } catch {
            /* Original absent proof or released lease grants no new authority. */
            await owner.fenceUnsettledProxyRecovery(record.execution).catch(() => {});
          }
          continue;
        }
        let recovered: Awaited<ReturnType<typeof owner.restoreCompletion>> | undefined,
          observation: DataExecutionContext | undefined;
        try {
          // Recover authentic observation authority without assuming that the
          // killed local producer ever reached worker completion publication.
          observation = observationContext(record);
          try {
            recovered = await owner.restoreCompletion(record.execution);
          } catch (error) {
            if (
              record.input.kind !== "catalog.activate" ||
              (error as NodeJS.ErrnoException).code !== "ENOENT"
            )
              throw error;
            // Final approval is the fixed graph's last effect. Reconcile only
            // its original address and authenticated, fully settled child tree.
            cancelControlExecution(observation.authority);
            await cancelArtifactTargetLease(ownedLease(observation));
            if ((await cancelAndSettleOwnedDataOpsChildren(observation)) !== "settled") throw error;
            await owner.repairCommittedCatalogActivation(record.execution);
            recovered = await owner.restoreCompletion(record.execution);
          }
          cancelControlExecution(recovered.authority);
          if (recovered.lease) await cancelArtifactTargetLease(recovered.lease);
          const context = observation;
          if (
            (await cancelAndSettleOwnedDataOpsChildren(context)) !== "settled" ||
            recovered.publication === "unknown"
          )
            throw Error("Original containment/publication remains unknown");
          const current = await context.record(),
            result = recovered.result,
            status = result
              ? result.kind === "catalog.validate" && result.status === "failed"
                ? "error"
                : result.kind === "catalog.activate" && result.outcome !== "activated"
                  ? "error"
                  : result.kind === "transit-sync"
                    ? result.finalStatus
                    : recovered.partial
                      ? "partial"
                      : "ok"
              : current.status.cancellationRequestedAt
                ? "canceled"
                : "error";
          const saved = await store.finalize(
            current.status.id,
            current.version,
            {
              status,
              publication: recovered.publication,
              ...(result ? { result, progress: 1 } : {}),
            },
            recovered.completion,
          );
          if (!saved) throw new DataExecutionOwnershipLost("Recovery terminal CAS lost");
          await owner.assertOwnedProxyRecoverySettled(record.execution);
          await releaseOwnLease(owner, record.execution, recovered.lease);
        } catch (error) {
          jobChildLogger({ job: "data-execution-recovery", jobId: record.status.id }).warn(
            {
              reason: dataExecutionDiagnostic(
                error instanceof Error ? error.message : "Original recovery evidence unavailable",
              ).message,
              trace: dataExecutionDiagnostic(
                error instanceof Error ? (error.stack ?? error.message) : "",
              ).message,
            },
            "Original execution remains fenced",
          );
          try {
            const latest = await store.inspect(record.status.id);
            if (latest && !isDataExecutionTerminal(latest.status)) {
              try {
                cancelControlExecution(
                  restoreAdmittedControlExecution(owner.installation, record.execution),
                );
              } catch {}
              await store.checkpoint(latest.status.id, latest.version, {
                status: latest.status.cancellationRequestedAt ? "cancel_pending" : "interrupted",
                publication: "unknown",
              });
              if (latest.status.cancellationRequestedAt || now() >= latest.status.deadlineAt)
                cancelRecovered(latest);
            }
          } catch {}
        } finally {
          if (recovered?.lease) closeArtifactTargetLeaseHandle(recovered.lease);
          if (observation?.targetAuthority)
            closeArtifactTargetLeaseHandle(observation.targetAuthority);
        }
      }
    },
    async close() {
      closed = true;
      await Promise.allSettled(
        [...active.values()].map((entry) =>
          cancel({
            id: entry.record.status.id,
            operationKey: entry.record.status.operationKey,
            fingerprint: entry.record.status.fingerprint,
          }),
        ),
      );
      await Promise.race([
        Promise.allSettled(
          [...active.values()].map((entry) => entry.task).concat([...recovering.values()]),
        ),
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 30000);
          t.unref();
        }),
      ]);
    },
  };
}
