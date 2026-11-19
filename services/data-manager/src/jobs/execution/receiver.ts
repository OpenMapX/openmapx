import { createHash, randomBytes } from "node:crypto";
import {
  type ControlInstallation,
  inspectDataExecutionAdmission,
  inspectSenderLease,
  TargetBusyError,
} from "@openmapx/core/build-artifacts";
import {
  type DataExecutionInput,
  type DataExecutionStatus,
  isDataExecutionTerminal,
  LOCAL_DATA_EXECUTION_KINDS,
  linkRequestSchema,
  normalizeDataExecutionInput,
} from "@openmapx/core/data-manager-contracts";
import {
  canonicalJson,
  createControlRootOperationKey,
  OpsClientError,
  opsExecutionBudget,
} from "@openmapx/core/ops";
import { applyHardlinkPlan } from "@openmapx/hardlinks";
import {
  type MotisOperationsPolicy,
  transitAllowedCountries,
} from "../transitous/operations-profile.js";
import type { DataExecutionReceiver } from "./api.js";
import type { DataConfigurationMaintenance } from "./configuration-maintenance.js";
import type { createDataExecutionDispatcher } from "./dispatch.js";
import { transitChildCandidateId } from "./ops-children.js";
import type { DataExecutionRuntime } from "./runtime.js";
import { DataExecutionConflict, dataExecutionInputFingerprint } from "./store.js";
import { retainDataPublication } from "./worker-scope.js";

/** Whether a refusal before any work came from another holder rather than an
 * agent that did not answer. */
function refusedBusy(error: unknown): boolean {
  return (
    error instanceof TargetBusyError ||
    (error instanceof OpsClientError &&
      (error.errorClass === "busy" || error.errorClass === "conflict"))
  );
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createDataExecutionReceiver(deps: {
  runtime: DataExecutionRuntime;
  installation: ControlInstallation;
  configurationFence: DataConfigurationMaintenance;
  dispatcher: ReturnType<typeof createDataExecutionDispatcher>;
  operationsPolicy: MotisOperationsPolicy;
}): DataExecutionReceiver {
  const { runtime, installation, configurationFence } = deps;
  const validate = (value: Parameters<DataExecutionRuntime["admit"]>[0]) => {
    const input = normalizeDataExecutionInput(value);
    if (
      (input.kind === "transit-sync" || input.kind === "catalog.validate") &&
      deps.operationsPolicy.profile !== "planet" &&
      (input.countries.length === 0 ||
        input.countries.some(
          (country) => !transitAllowedCountries(deps.operationsPolicy).includes(country),
        ))
    )
      throw Object.assign(Error("Countries outside configured operations profile"), {
        statusCode: 422,
      });
    return input;
  };
  const admitRoot = (
    input: DataExecutionInput,
    source: Pick<
      Parameters<DataExecutionRuntime["admit"]>[1],
      "triggeredBy" | "idempotencyKey" | "work" | "refused"
    >,
  ) => {
    const requestedDeadlineAt = Date.now() + opsExecutionBudget(input.kind).processMs,
      operationKey = createControlRootOperationKey({
        notAfter: requestedDeadlineAt,
        nonce: randomBytes(16),
      });
    return runtime.admit(input, { operationKey, requestedDeadlineAt, ...source });
  };
  return {
    async observeReviewedTransit(request) {
      const record = await runtime.lookupByIdempotencyKey?.(request.key);
      if (!record) return null;
      const input = record.input,
        countries = [...new Set(request.countries.map((c) => c.toLowerCase()))].sort();
      if (
        input.kind !== "transit-sync" ||
        canonicalJson(input.countries) !== canonicalJson(countries) ||
        record.triggeredBy !== (request.triggeredBy ?? null) ||
        input.preflight?.preflightId !== request.preflightId ||
        input.preflight.fingerprint !== request.fingerprint
      )
        throw new DataExecutionConflict("Idempotency key body or actor conflict");
      return runtime.inspect(record.status.id);
    },
    async admit(value, options) {
      const input = validate(value);
      if (
        input.kind === "transit-maintenance" ||
        (LOCAL_DATA_EXECUTION_KINDS as readonly string[]).includes(input.kind)
      )
        throw Object.assign(Error("Service-internal data input"), { statusCode: 403 });
      const verified = inspectDataExecutionAdmission(installation, {
        ...options,
        input,
        operationFingerprint: dataExecutionInputFingerprint(input),
      });
      return runtime.admit(input, {
        operationKey: options.operationKey,
        requestedDeadlineAt: options.requestedDeadlineAt,
        ...(verified
          ? {
              parent: verified.parent,
              id: verified.execution.executionId,
              principal: verified.execution.principal,
              adopt: verified.adopt,
            }
          : {}),
      });
    },
    async link(value, transportPrincipal) {
      const request = linkRequestSchema.parse(value),
        prune = request.prune ?? false,
        leaseId = request.leaseId ?? null;
      let linkSender: Parameters<DataExecutionRuntime["admit"]>[1]["linkSender"];
      if (leaseId) {
        if (transportPrincipal !== "ops-agent" && transportPrincipal !== "host-cli")
          throw Object.assign(Error("Only the agent or the host CLI links under its own lease"), {
            statusCode: 403,
          });
        // Read before admission, outside its lock. Admission checks the answer
        // unless the request repeats an application or belongs to the prepared fence.
        linkSender = {
          caller: transportPrincipal,
          lease: await inspectSenderLease(installation, leaseId, transportPrincipal),
        };
      }
      const input = normalizeDataExecutionInput({
        kind: "generation-link",
        revisionId: request.revisionId,
        planDigest: createHash("sha256")
          .update(canonicalJson({ plan: request.plan, prune }))
          .digest("hex"),
        leaseId,
      });
      let refusal: unknown;
      const admitted = await runtime.admit(input, {
        operationKey: request.operationKey,
        requestedDeadlineAt: request.requestedDeadlineAt,
        ...(linkSender ? { linkSender } : {}),
        // From the first link on, a failure part-way may have changed links: it
        // is a known partial outcome, never an unknown publication.
        work: async (context) => {
          await retainDataPublication();
          const applied = applyHardlinkPlan(request.plan, { rootDir: context.dataRoot, prune });
          return {
            kind: "generation-link",
            hardlinks: {
              applied: true,
              entries: request.plan.length,
              linked: applied.linked,
              skipped: applied.skipped,
              pruned: applied.pruned,
              via: "data-manager",
            },
          };
        },
        refused: (error) => {
          refusal = error;
        },
      });
      // A repeated request, or one whose application outlives this wait, asks again.
      const until = Date.now() + 10_000;
      let status: DataExecutionStatus = admitted;
      while (!isDataExecutionTerminal(status) && Date.now() < until) {
        await Promise.race([runtime.settled(status.id), sleep(250)]);
        status = (await runtime.inspect(status.id)) ?? status;
      }
      if (!isDataExecutionTerminal(status)) return { state: "running" as const, status };
      if (status.status === "ok" && status.result?.kind === "generation-link") {
        const { linked, skipped, pruned } = status.result.hardlinks;
        return { state: "applied" as const, linked, skipped, pruned };
      }
      const reason =
        status.diagnostics.tail.at(-1)?.message ?? `Hardlink application ${status.status}`;
      if (status.publication === "not_started")
        throw Object.assign(Error(`Hardlink plan not applied: ${reason}`), {
          statusCode: refusal === undefined || refusedBusy(refusal) ? 409 : 503,
        });
      throw Object.assign(Error(`Hardlink plan failed and links may have changed: ${reason}`), {
        statusCode: 500,
      });
    },
    admitLocal: async (value, source) => admitRoot(validate(value), source ?? {}),
    async runLocal(input, run, options) {
      let outcome: { value: Awaited<ReturnType<typeof run>> } | { error: unknown } | undefined;
      let refusal: unknown;
      const status = await admitRoot(normalizeDataExecutionInput(input), {
        ...options,
        work: async (context) => {
          try {
            outcome = { value: await run(context.sql) };
          } catch (error) {
            outcome = { error };
            throw error;
          }
          return { kind: input.kind };
        },
        refused: (error) => {
          refusal = error;
        },
      });
      const completion = runtime.settled(status.id).then(async () => {
        if (outcome && "error" in outcome) throw outcome.error;
        const final = await runtime.inspect(status.id);
        if (!outcome || !final || (final.status !== "ok" && final.status !== "partial"))
          throw Object.assign(
            Error(
              final?.diagnostics.tail.at(-1)?.message ??
                `Data execution ${status.id} ended ${final?.status ?? "unobserved"}`,
            ),
            // Refused before it ran: busy when another holder has data-manager,
            // unavailable when the agent did not answer the lease request.
            { statusCode: refusal === undefined || refusedBusy(refusal) ? 409 : 503 },
          );
        return outcome.value;
      });
      void completion.catch(() => {});
      return { status, completion };
    },
    async admitMaintenance(action, options) {
      const requestedDeadlineAt = Date.now() + 120000,
        operationKey = createControlRootOperationKey({
          notAfter: requestedDeadlineAt,
          nonce: randomBytes(16),
        });
      const input =
        action === "restart-primary"
          ? { kind: "transit-maintenance" as const, action }
          : {
              kind: "transit-maintenance" as const,
              action,
              candidateId: transitChildCandidateId({ operationKey }, "proxy-commit", 0),
            };
      return runtime.admit(input, { operationKey, requestedDeadlineAt, ...options });
    },
    inspect: runtime.inspect,
    lookup: runtime.lookup,
    requestCancel: runtime.requestCancel,
    prepareFence: (input, transportPrincipal) =>
      configurationFence.prepare(input, transportPrincipal),
    inspectFence: (id, expected, transportPrincipal) =>
      configurationFence.inspect(id, expected, transportPrincipal),
    settleFence: (input, transportPrincipal) =>
      configurationFence.settle(input, transportPrincipal),
    subscribe: deps.dispatcher.subscribe,
    legacyResult: deps.dispatcher.legacyResult,
  };
}
