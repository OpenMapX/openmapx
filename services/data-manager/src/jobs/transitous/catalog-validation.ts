/** The admitted validation root owns the inactive slot through proxy restoration and final stop. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  controlDigest,
  executionAuthorityState,
  signControl,
} from "@openmapx/core/build-artifacts";
import {
  CATALOG_VALIDATION_DOMAIN,
  type CatalogRuntimeInputs,
  type CatalogValidation,
  catalogRuntimeInputsSchema,
  catalogValidationRecordSchema,
  sameCatalogRuntimeInputs,
  scopeCatalogRuntimeInputs,
  withCatalogProposalDirectory,
} from "@openmapx/core/catalog-pins";
import { canonicalJson } from "@openmapx/core/ops";
import { catalogCompilerSettings, catalogReviewInputDigests } from "@openmapx/transitous-core";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import { asJobLogger, jobChildLogger } from "../../logger.js";
import { runOpsOperation } from "../../ops-client.js";
import type { StateStore } from "../../state.js";
import { dataExecutionDiagnostic } from "../execution/diagnostics.js";
import { DataOpsObservationPending, runOwnedDataOpsOperation } from "../execution/ops-children.js";
import type { DataExecutionContext } from "../execution/runtime.js";
import { DataPublicationUnknown, publishDataChange } from "../execution/worker-scope.js";
import { readFeedOverlay } from "../transitous-feeds-overlay.js";
import { CANDIDATE_MANIFEST_FILENAME, verifyCandidateManifestAsync } from "./candidate.js";
import { retainPreviousHealthyCatalogSlot } from "./catalog-rollback-retention.js";
import { loadOwnedCatalogSelection, ownedCatalogSelectionEvidence } from "./catalog-selection.js";
import { publishCatalogValidationCurrent } from "./catalog-validation-current.js";
import { resolveTransitOverlayPath } from "./internal.js";
import { isolateOwnedTransitProducer } from "./isolate-producer.js";
import type { MotisOperationsPolicy } from "./operations-profile.js";
import { makePersistingOnStageComplete } from "./persistence.js";
import { buildJobContext, runTransitousPipeline, stagePolicyFor } from "./pipeline.js";
import { rollbackProxyTransaction } from "./proxy-transaction.js";
import { readMotisSlotState } from "./slot-state.js";

export function unchangedCatalogRuntimeInputs(
  before: CatalogRuntimeInputs,
  after: CatalogRuntimeInputs,
): boolean {
  return sameCatalogRuntimeInputs(before, after);
}
export async function runCatalogValidation(options: {
  context: DataExecutionContext;
  dataDir: string;
  store: StateStore;
  operationsPolicy: MotisOperationsPolicy;
}): Promise<CatalogValidation> {
  const { context, dataDir, operationsPolicy } = options,
    record = await context.record();
  if (record.input.kind !== "catalog.validate")
    throw Error("Original catalog validation input required");
  if (process.env.MOTIS_TWO_SLOT !== "true" || process.env.MOTIS_GBFS_CATALOG_ENABLED !== "true")
    throw Error("Enable and apply two-slot MOTIS and the paired GBFS compiler before validation");
  const input = record.input,
    selection = await loadOwnedCatalogSelection(context, input.proposalId),
    evidence = ownedCatalogSelectionEvidence(selection, context);
  if (!evidence.runtimeInputs)
    throw Error("Verified catalog runtime inputs required before validation");
  const runtimeInputs = scopeCatalogRuntimeInputs(evidence.runtimeInputs, input.countries);
  if (runtimeInputs.requiredKeys.some((key) => !runtimeInputs.configuredKeys.includes(key)))
    throw Error(
      "Configure the credentials required by the selected validation countries and enabled sources",
    );
  if (Buffer.byteLength(canonicalJson(runtimeInputs), "utf8") > 48 * 1024)
    throw Error("Catalog input evidence exceeds its retained budget");
  const source = catalogReviewInputDigests(
    operationsPolicy,
    readFeedOverlay(resolveTransitOverlayPath(dataDir)),
    catalogCompilerSettings(process.env),
  );
  if (
    source.sourcePolicyRevision !== evidence.proposal.sourcePolicyRevision ||
    source.sourcePolicyRevision !== runtimeInputs.sourcePolicyRevision ||
    source.overlayDigest !== runtimeInputs.overlayDigest
  )
    throw Error("Catalog policy changed; create a fresh proposal");
  const initialSlots = readMotisSlotState(dataDir);
  if (!initialSlots) throw Error("Initialize the two-slot MOTIS layout before validation");
  const slot = initialSlots.activeSlot === "A" ? "B" : "A";
  const child = async (ordinal: number) => {
    const reserved = record.reservations.find((entry) => entry.ordinal === ordinal);
    if (!reserved || reserved.operation.kind !== "motis.staging.stop")
      throw Error("Original validation stop reservation required");
    await runOwnedDataOpsOperation(reserved.operation, {
      context,
      phase: reserved.phase,
      ordinal,
      serviceIds: reserved.serviceIds,
    });
  };
  await child(0);
  await publishDataChange(() =>
    publishCatalogValidationCurrent(context.authority, context.targetAuthority),
  );
  await retainPreviousHealthyCatalogSlot(
    context,
    dataDir,
    input.proposalId,
    operationsPolicy.resourceEnvelope.minimumDiskGb * 1024 ** 3,
  );
  await isolateOwnedTransitProducer(
    context,
    operationsPolicy.resourceEnvelope.minimumDiskGb * 1024 ** 3,
  );
  const logger = asJobLogger(
    jobChildLogger({ job: "catalog.validate", jobId: context.execution.executionId }),
  );
  const stages = stagePolicyFor(operationsPolicy.acquisition);
  const ctx = await publishDataChange(() =>
    buildJobContext({
      dataDir,
      store: options.store,
      countries: input.countries,
      source: operationsPolicy.acquisition,
      operationsPolicy: { ...operationsPolicy, countries: input.countries },
      jobId: context.execution.executionId,
      reviewedCatalog: selection,
      executionContext: context,
      abortSignal: context.signal,
      logger,
      onStageComplete: async (stage) => {
        await makePersistingOnStageComplete(context.execution.executionId, logger)(stage);
        const diagnostic = dataExecutionDiagnostic(stage.message ?? stage.stage);
        await context.checkpoint({
          progress: Math.min(
            0.95,
            (stages.findIndex((entry) => entry.name === stage.stage) + 1) / stages.length,
          ),
          diagnostics: {
            tail: [{ stream: "stdout", message: diagnostic.message }],
            truncated: diagnostic.truncated,
          },
        });
      },
    }),
  );
  let failure = false;
  try {
    await runTransitousPipeline(ctx, { stopAt: "motis-health", requireCompleteStages: true });
  } catch (error) {
    if (error instanceof DataOpsObservationPending || error instanceof DataPublicationUnknown)
      throw error;
    context.assertForward();
    failure = true;
  }
  // Restoration is part of validation, not best-effort cleanup. An uncertain
  // child throws and keeps this root fenced; it cannot publish passing evidence.
  await rollbackProxyTransaction(ctx);
  await child(4);
  context.assertForward();
  const fresh = await runOpsOperation(
    { kind: "transitousLock.inspect", proposalId: input.proposalId, offset: 0 },
    { signal: context.signal },
  );
  if (
    controlDigest(fresh.proposal) !== controlDigest(evidence.proposal) ||
    !fresh.validationInputs ||
    !unchangedCatalogRuntimeInputs(
      runtimeInputs,
      scopeCatalogRuntimeInputs(
        catalogRuntimeInputsSchema.parse(fresh.validationInputs),
        input.countries,
      ),
    )
  )
    throw Error("Catalog inputs changed during validation");
  if (readMotisSlotState(dataDir)?.activeSlot !== initialSlots.activeSlot)
    throw Error("Validation changed the active MOTIS slot");
  const completedAt = new Date().toISOString(),
    common = {
      validationId: context.execution.executionId,
      proposalId: input.proposalId,
      pinDigest: evidence.proposal.pins.generationId,
      diffDigest: evidence.proposal.diffDigest,
      sourcePolicyRevision: runtimeInputs.sourcePolicyRevision,
      overlayDigest: runtimeInputs.overlayDigest,
      credentialsRevision: runtimeInputs.credentialsRevision,
      countries: input.countries,
      completedAt,
      expiresAt: new Date(Date.parse(completedAt) + 24 * 60 * 60 * 1000).toISOString(),
    };
  let validation: CatalogValidation;
  if (failure)
    validation = {
      ...common,
      status: "failed",
      reason:
        "A required import or functional probe did not complete. Inspect the validation job and create a new validation after resolving its failure.",
    };
  else {
    const manifest = await verifyCandidateManifestAsync(ctx.motisStagingDataDir, context.signal);
    if (
      manifest.epoch !== context.execution.executionId ||
      ctx.slotLayout?.record.activeSlot !== initialSlots.activeSlot
    )
      throw Error("Validation candidate identity changed");
    const directory = new AnchoredDirectory(realpathSync(ctx.motisStagingDataDir));
    let manifestHash: string;
    try {
      manifestHash = createHash("sha256")
        .update(directory.read(CANDIDATE_MANIFEST_FILENAME, 32 * 1024 * 1024, false))
        .digest("hex");
    } finally {
      directory.close();
    }
    validation = {
      ...common,
      status: "passed",
      slot,
      epoch: manifest.epoch,
      manifestHash,
      imageDigest: runtimeInputs.imageDigest,
    };
  }
  const owner = executionAuthorityState(context.authority),
    retained = catalogValidationRecordSchema.parse({
      version: 1,
      installationId: context.installation.installationId,
      sourceExecution: context.execution,
      proposalDigest: controlDigest(evidence.proposal),
      runtimeInputs,
      validation,
    });
  await publishDataChange(() =>
    withCatalogProposalDirectory(context.installation, input.proposalId, (directory) =>
      directory.write(
        `validation-${context.execution.executionId}.json`,
        canonicalJson(
          signControl(owner.installation.privateKey, CATALOG_VALIDATION_DOMAIN, retained),
        ),
        true,
      ),
    ),
  );
  if (validation.status === "passed")
    await publishDataChange(() =>
      publishCatalogValidationCurrent(context.authority, context.targetAuthority, input.proposalId),
    );
  return validation;
}
