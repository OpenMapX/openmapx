/** A proposal becomes a pipeline input only through its actual admitted owner. */
import {
  assertControlExecutionForward,
  controlDigest,
  executionAuthorityState,
} from "@openmapx/core/build-artifacts";
import {
  type CatalogProposal,
  type CatalogRuntimeInputs,
  catalogProposalSchema,
  catalogRuntimeInputsSchema,
  parseCatalogPinSet,
} from "@openmapx/core/catalog-pins";
import { runOpsOperation } from "../../ops-client.js";
import type { DataExecutionContext } from "../execution/runtime.js";
import { dataExecutionInputFingerprint } from "../execution/store.js";
import type { JobContext } from "./types.js";

declare const selectionBrand: unique symbol;
export type ReviewedCatalogSelection = Readonly<{
  proposalId: string;
  catalogRevisionId: string;
  [selectionBrand]: true;
}>;
const selections = new WeakMap<
  object,
  { context: DataExecutionContext; proposal: CatalogProposal; runtimeInputs?: CatalogRuntimeInputs }
>();
export async function loadOwnedCatalogSelection(
  context: DataExecutionContext,
  proposalId: string,
): Promise<ReviewedCatalogSelection> {
  const owner = executionAuthorityState(context.authority),
    record = await context.record();
  assertControlExecutionForward(context.authority);
  context.assertForward();
  if (
    owner.kind !== "catalog.validate" ||
    record.input.kind !== "catalog.validate" ||
    record.input.proposalId !== proposalId ||
    dataExecutionInputFingerprint(record.input) !== owner.execution.operationFingerprint ||
    controlDigest(owner.execution) !== controlDigest(context.execution)
  )
    throw Error("Original catalog validation execution required");
  const [selected, active] = await Promise.all([
    runOpsOperation(
      { kind: "transitousLock.inspect", proposalId, offset: 0 },
      { signal: context.signal },
    ),
    runOpsOperation({ kind: "catalogPins.inspect" }, { signal: context.signal }),
  ]);
  const proposal = catalogProposalSchema.parse(selected.proposal);
  parseCatalogPinSet(proposal.pins);
  if (proposal.proposalId !== proposalId || proposal.baseGenerationId !== active.catalogRevisionId)
    throw Error("Catalog proposal base changed");
  const handle = Object.freeze({
    proposalId,
    catalogRevisionId: proposal.pins.generationId,
  }) as ReviewedCatalogSelection;
  selections.set(handle, {
    context,
    proposal,
    ...(selected.validationInputs
      ? { runtimeInputs: catalogRuntimeInputsSchema.parse(selected.validationInputs) }
      : {}),
  });
  return handle;
}
export function selectedCatalogPins(ctx: JobContext) {
  const selected = ctx.reviewedCatalog && selections.get(ctx.reviewedCatalog);
  if (
    !selected ||
    selected.context !== ctx.executionContext ||
    selected.context.execution.executionId !== ctx.jobId
  )
    throw Error("Verified owned catalog proposal required");
  assertControlExecutionForward(selected.context.authority);
  selected.context.assertForward();
  return parseCatalogPinSet(structuredClone(selected.proposal.pins));
}

export function ownedCatalogSelectionEvidence(
  handle: ReviewedCatalogSelection,
  context: DataExecutionContext,
) {
  const selected = selections.get(handle);
  if (!selected || selected.context !== context) throw Error("Original catalog selection required");
  assertControlExecutionForward(context.authority);
  return {
    proposal: structuredClone(selected.proposal),
    runtimeInputs: selected.runtimeInputs && structuredClone(selected.runtimeInputs),
  };
}
