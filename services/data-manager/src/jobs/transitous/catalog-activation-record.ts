/** The fixed approval child receives the actual already-settled promotion, never a caller assertion. */
import {
  controlDigest,
  executionAuthorityState,
  inspectArtifactTargetLeaseChildSettlement,
} from "@openmapx/core/build-artifacts";
import {
  catalogActivationRecordSchema,
  readCatalogValidation,
  scopeCatalogRuntimeInputs,
  withCatalogProposalDirectory,
} from "@openmapx/core/catalog-pins";
import { canonicalJson, type ExecutionRef } from "@openmapx/core/ops";
import { runOpsOperation } from "../../ops-client.js";
import { ownedLease } from "../execution/owned-lease.js";
import type { DataExecutionContext } from "../execution/runtime.js";
import { publishDataChange } from "../execution/worker-scope.js";
export async function retainCatalogActivationRecord(
  context: DataExecutionContext,
  approval: ExecutionRef,
): Promise<void> {
  context.assertForward();
  const record = await context.record();
  if (record.input.kind !== "catalog.activate") throw Error("Original activation input required");
  const input = record.input,
    selected = await runOpsOperation(
      { kind: "transitousLock.inspect", proposalId: input.proposalId, offset: 0 },
      { signal: context.signal },
    );
  const validation = readCatalogValidation(
    context.installation,
    input.proposalId,
    input.validationId,
  );
  const promotion = record.children.find((child) => child.phase === "promote-primary");
  if (
    !selected.proposal ||
    !selected.validationInputs ||
    !promotion ||
    promotion.state !== "terminal" ||
    promotion.settlement.outcome !== "committed" ||
    !record.reservations.some(
      (child) =>
        child.phase === "paired-pin-commit" &&
        child.proposedId === approval.executionId &&
        child.operationFingerprint === approval.operationFingerprint,
    )
  )
    throw Error("Original settled promotion and fixed approval reservation required");
  const physical = await inspectArtifactTargetLeaseChildSettlement(
    ownedLease(context),
    promotion.execution,
  );
  if (
    physical?.outcome !== "committed" ||
    physical.terminalReceiptDigest !== promotion.settlement.terminalReceiptDigest
  )
    throw Error("Original promotion physical settlement required");
  const body = catalogActivationRecordSchema.parse({
    version: 1,
    parent: context.execution,
    proposalId: input.proposalId,
    validationId: input.validationId,
    proposalDigest: controlDigest(selected.proposal),
    validationDigest: controlDigest(validation),
    diffDigest: input.diffDigest,
    runtimeInputs: scopeCatalogRuntimeInputs(
      selected.validationInputs,
      validation.validation.countries,
    ),
    promotion: {
      execution: promotion.execution,
      terminalReceiptDigest: physical.terminalReceiptDigest,
      leaseChild: { leaseId: promotion.leaseId, childKey: promotion.childKey },
    },
    approval,
  });
  executionAuthorityState(context.authority);
  await publishDataChange(() =>
    withCatalogProposalDirectory(context.installation, input.proposalId, (directory) => {
      const name = `activation-${context.execution.executionId}.json`,
        bytes = canonicalJson(body);
      try {
        const previous = directory.read(name, 128 * 1024, true).toString("utf8");
        if (previous !== bytes) throw Error("Original immutable catalog activation record changed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        directory.write(name, bytes, true);
      }
    }),
  );
}
