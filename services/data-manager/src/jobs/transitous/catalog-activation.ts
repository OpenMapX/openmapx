/** Activate exactly one reviewed candidate under the existing finite root and child reservations. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { controlDigest, verifyDataControlTerminalWitness } from "@openmapx/core/build-artifacts";
import {
  catalogProposalSchema,
  catalogRuntimeInputsSchema,
  readCatalogValidation,
  readCurrentCatalogValidation,
  sameCatalogRuntimeInputs,
  scopeCatalogRuntimeInputs,
} from "@openmapx/core/catalog-pins";
import type { DataExecutionResult } from "@openmapx/core/data-manager-contracts";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import { asJobLogger, jobChildLogger } from "../../logger.js";
import { runOpsOperation } from "../../ops-client.js";
import type { StateStore } from "../../state.js";
import { dataExecutionDiagnostic } from "../execution/diagnostics.js";
import { DataOpsObservationPending, runOwnedDataOpsOperation } from "../execution/ops-children.js";
import type { DataExecutionContext } from "../execution/runtime.js";
import { DataPublicationUnknown, publishDataChange } from "../execution/worker-scope.js";
import { CANDIDATE_MANIFEST_FILENAME, verifyCandidateManifestAsync } from "./candidate.js";
import { run as checkHealth } from "./motis-health.js";
import type { MotisOperationsPolicy } from "./operations-profile.js";
import { runTransitOwnedPhase } from "./owned-ops.js";
import { makePersistingOnStageComplete } from "./persistence.js";
import { buildJobContext } from "./pipeline.js";
import { run as promote } from "./promote.js";
import { rollbackProxyTransaction, run as stageProxy } from "./proxy-transaction.js";
import { readMotisSlotState } from "./slot-state.js";
export async function runCatalogActivation(options: {
  context: DataExecutionContext;
  dataDir: string;
  store: StateStore;
  operationsPolicy: MotisOperationsPolicy;
}): Promise<Extract<DataExecutionResult, { kind: "catalog.activate" }>> {
  const { context, dataDir } = options,
    record = await context.record();
  if (record.input.kind !== "catalog.activate" || !record.input.acknowledgeLicenseChanges)
    throw Error("Acknowledge the complete catalog diff before activation");
  const input = record.input,
    validation = readCatalogValidation(context.installation, input.proposalId, input.validationId),
    passed = validation.validation;
  if (
    passed.status !== "passed" ||
    Date.now() >= Date.parse(passed.expiresAt) ||
    Date.parse(passed.completedAt) > Date.now() ||
    Date.parse(passed.expiresAt) > Date.parse(passed.completedAt) + 86400000
  )
    throw Error("Catalog validation is failed or expired");
  const currentValidation = readCurrentCatalogValidation(context.installation);
  if (
    currentValidation?.selected?.proposalId !== input.proposalId ||
    currentValidation.selected.validationId !== input.validationId ||
    currentValidation.selected.validationDigest !== controlDigest(validation)
  )
    throw Error("Validation was invalidated before slot reuse; validate again");
  const terminal = verifyDataControlTerminalWitness(
    context.installation,
    validation.sourceExecution,
  );
  if (
    terminal.status.status !== "ok" ||
    terminal.status.result?.kind !== "catalog.validate" ||
    terminal.status.result.status !== "passed" ||
    terminal.status.result.validationId !== input.validationId
  )
    throw Error("Original successful validation completion required");
  const selected = await runOpsOperation(
      { kind: "transitousLock.inspect", proposalId: input.proposalId, offset: 0 },
      { signal: context.signal },
    ),
    proposal = catalogProposalSchema.parse(selected.proposal),
    active = await runOpsOperation({ kind: "catalogPins.inspect" }, { signal: context.signal });
  if (
    controlDigest(proposal) !== validation.proposalDigest ||
    proposal.pins.generationId !== passed.pinDigest ||
    proposal.diffDigest !== input.diffDigest ||
    proposal.baseGenerationId !== input.expectedGenerationId ||
    active.catalogRevisionId !== input.expectedGenerationId ||
    !selected.validationInputs ||
    !sameCatalogRuntimeInputs(
      validation.runtimeInputs,
      scopeCatalogRuntimeInputs(
        catalogRuntimeInputsSchema.parse(selected.validationInputs),
        passed.countries,
      ),
    )
  )
    throw Error("Catalog validation inputs changed; validate again");
  const initial = readMotisSlotState(dataDir);
  if (!initial || initial.activeSlot === passed.slot)
    throw Error("Validated inactive slot is no longer available");
  const logger = asJobLogger(
    jobChildLogger({ job: "catalog.activate", jobId: context.execution.executionId }),
  );
  const ctx = await publishDataChange(() =>
    buildJobContext({
      dataDir,
      store: options.store,
      countries: passed.countries,
      source: options.operationsPolicy.acquisition,
      operationsPolicy: { ...options.operationsPolicy, countries: passed.countries },
      jobId: context.execution.executionId,
      executionContext: context,
      abortSignal: context.signal,
      logger,
      onStageComplete: async (stage) => {
        await makePersistingOnStageComplete(context.execution.executionId, logger)(stage);
        const diagnostic = dataExecutionDiagnostic(stage.message ?? stage.stage);
        await context.checkpoint({
          diagnostics: {
            tail: [{ stream: "stdout", message: diagnostic.message }],
            truncated: diagnostic.truncated,
          },
        });
      },
    }),
  );
  if (!ctx.slotLayout) throw Error("Paired activation requires the two-slot layout");
  const manifest = await verifyCandidateManifestAsync(ctx.motisStagingDataDir, context.signal),
    directory = new AnchoredDirectory(realpathSync(ctx.motisStagingDataDir));
  try {
    if (
      manifest.epoch !== passed.epoch ||
      createHash("sha256")
        .update(directory.read(CANDIDATE_MANIFEST_FILENAME, 32 * 1024 * 1024, false))
        .digest("hex") !== passed.manifestHash
    )
      throw Error("Validated candidate was replaced");
  } finally {
    directory.close();
  }
  ctx.state.catalogPins = proposal.pins;
  ctx.state.transitousLock = proposal.pins.transitous;
  try {
    const proxy = await stageProxy(ctx);
    await ctx.onStageComplete(proxy);
    await context.checkpoint({ progress: 0.2 });
    if (proxy.status !== "ok") throw Error("Candidate proxy preparation failed");
    await runTransitOwnedPhase(ctx, "restart-staging");
    const health = await checkHealth(ctx);
    await ctx.onStageComplete(health);
    await context.checkpoint({ progress: 0.5 });
    if (health.status !== "ok") throw Error("Validated candidate no longer passes staging probes");
    const result = await promote(ctx);
    await ctx.onStageComplete(result);
    await context.checkpoint({ progress: 0.8 });
    if (result.status !== "ok") throw Error("Candidate promotion did not complete");
  } catch (error) {
    if (error instanceof DataOpsObservationPending || error instanceof DataPublicationUnknown)
      throw error;
    context.assertForward();
    await rollbackProxyTransaction(ctx);
    await runTransitOwnedPhase(ctx, "stop-staging");
    const current = readMotisSlotState(dataDir);
    if (
      current?.activeSlot !== initial.activeSlot ||
      current?.datasetEpoch !== initial.datasetEpoch
    )
      throw new DataOpsObservationPending(context.execution.operationKey);
    return {
      kind: input.kind,
      proposalId: input.proposalId,
      validationId: input.validationId,
      outcome: "not_activated",
      generationId: input.expectedGenerationId,
      reason:
        "Candidate probes or promotion failed; the previous active slot and catalog pins remain selected.",
    };
  }
  const slot = record.reservations.find(
    (child) => child.phase === "paired-pin-commit" && child.ordinal === 0,
  );
  if (!slot || slot.operation.kind !== "transitousLock.approve")
    throw Error("Original paired publication reservation required");
  // From here the dataset is active. Any missing pin receipt is unknown and
  // fenced, never reported as rolled back or retried as a different attempt.
  const committed = await runOwnedDataOpsOperation(slot.operation, {
    context,
    phase: slot.phase,
    ordinal: slot.ordinal,
    serviceIds: slot.serviceIds,
  });
  return {
    kind: input.kind,
    proposalId: input.proposalId,
    validationId: input.validationId,
    outcome: "activated",
    generationId: committed.generationId,
    reason: null,
  };
}
