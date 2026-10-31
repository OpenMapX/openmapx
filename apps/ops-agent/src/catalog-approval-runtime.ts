/** The only production pin publisher: independent evidence, original promotion and original borrowed leaf. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
import type {
  TargetLeaseAuthority,
  VerifiedExecutionAuthority,
} from "@openmapx/core/build-artifacts";
import {
  assertControlExecutionForward,
  controlDigest,
  executionAuthorityState,
  inspectArtifactDelegation,
  inspectDataTransitCandidate,
  restoreAdmittedControlExecution,
  retainedControlAdoptionAssertion,
  retainedControlParent,
  verifyControl,
  verifyControlEffectSettlement,
  verifyDataControlTerminalWitness,
  verifyRetainedArtifactTargetSettlement,
} from "@openmapx/core/build-artifacts";
import {
  catalogApprovalAdmissionSchema,
  catalogPromotionEffectSchema,
  catalogRuntimeInputsSchema,
  publishCatalogPinSet,
  readCatalogActivation,
  readCatalogPinCommit,
  readCatalogPinSet,
  readCatalogProposal,
  readCatalogValidation,
  readCurrentCatalogValidation,
  sameCatalogRuntimeInputs,
  scopeCatalogRuntimeInputs,
} from "@openmapx/core/catalog-pins";
import {
  canonicalJson,
  type OpsOperation,
  opsOperationFingerprint,
  parseOpsResult,
} from "@openmapx/core/ops";
import {
  childSettlementState,
  readPrivateRecord,
} from "../../../packages/core/src/build-artifacts/control-authority";
import { originRecordDomain } from "../../../packages/core/src/build-artifacts/control-records";
import { verifyDataTransitCandidateForExecution } from "../../../packages/core/src/build-artifacts/data-execution-candidate";
import { AnchoredDirectory } from "../../../packages/core/src/build-artifacts/filesystem";
import type { OpsRuntime } from "./runtime";

const installedRoots = new WeakMap<OpsRuntime, string>();

/** Lookup-only original publication recovery. This never invokes the handler,
 * reevaluates eligibility, acquires a root, or changes the active pointer. */
export async function readCommittedCatalogApproval(
  runtime: OpsRuntime,
  authority: VerifiedExecutionAuthority,
  lease: TargetLeaseAuthority,
  operation: Extract<OpsOperation, { kind: "transitousLock.approve" }>,
) {
  const rootDir = installedRoots.get(runtime);
  if (!rootDir) return null;
  const own = executionAuthorityState(authority);
  if (
    own.kind !== operation.kind ||
    own.execution.operationFingerprint !== opsOperationFingerprint(operation) ||
    lease.mode !== "borrowed" ||
    lease.owner.executor !== "data-manager"
  )
    throw Error("Original catalog approval borrower required");
  const activation = readCatalogActivation(
    own.installation.installation,
    operation.proposalId,
    lease.owner.executionId,
  );
  if (
    controlDigest(activation.approval) !== controlDigest(own.execution) ||
    controlDigest(activation.parent) !== controlDigest(lease.owner)
  )
    throw Error("Original catalog approval source changed");
  const receipt = await readCatalogPinCommit({
    rootDir,
    commit: {
      commitId: catalogApprovalCommitId(own.execution.operationKey, own.execution.fingerprint),
      execution: own.execution,
      proposalId: operation.proposalId,
      validationId: operation.validationId,
      diffDigest: operation.diffDigest,
    },
  });
  if (receipt?.phase !== "committed" || !receipt.committedAt) return null;
  const proposal = readCatalogProposal({
    rootDir,
    installation: own.installation.installation,
    proposalId: operation.proposalId,
  });
  if (
    !proposal ||
    receipt.previousGenerationId !== operation.expectedGenerationId ||
    receipt.generationId !== proposal.pins.generationId ||
    activation.proposalDigest !== controlDigest(proposal)
  )
    throw Error("Original committed catalog result changed");
  return {
    terminalAt: Date.parse(receipt.committedAt),
    result: {
      outcome: "activated" as const,
      proposalId: operation.proposalId,
      validationId: operation.validationId,
      previousGenerationId: operation.expectedGenerationId,
      generationId: receipt.generationId,
      commitId: receipt.identity.commitId,
      committedAt: receipt.committedAt,
    },
  };
}
export function catalogApprovalCommitId(operationKey: string, fingerprint: string): string {
  const value = createHash("sha256")
    .update(`openmapx-paired-pin-commit-v1\0${operationKey}\0${fingerprint}`)
    .digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}
export function installCatalogApprovalRuntime(
  runtime: OpsRuntime,
  options: { rootDir: string },
): void {
  installedRoots.set(runtime, options.rootDir);
  runtime["transitousLock.approve"] = async (operation, context) => {
    const authority = context.controlAuthority,
      lease = context.artifactLease;
    if (
      !authority ||
      !lease ||
      lease.mode !== "borrowed" ||
      lease.owner.executor !== "data-manager" ||
      !operation.acknowledgeLicenseChanges
    )
      throw Error("Original reviewed activation borrower required");
    assertControlExecutionForward(authority);
    const own = executionAuthorityState(authority),
      installation = own.installation.installation;
    if (
      own.kind !== operation.kind ||
      controlDigest(context.execution) !== controlDigest(own.execution)
    )
      throw Error("Original approval identity required");
    const activation = readCatalogActivation(
        installation,
        operation.proposalId,
        lease.owner.executionId,
      ),
      proposal = readCatalogProposal({
        rootDir: options.rootDir,
        installation,
        proposalId: operation.proposalId,
      }),
      validation = readCatalogValidation(
        installation,
        operation.proposalId,
        operation.validationId,
      ),
      passed = validation.validation;
    if (
      !proposal ||
      passed.status !== "passed" ||
      activation.validationId !== operation.validationId ||
      controlDigest(activation.parent) !== controlDigest(lease.owner) ||
      controlDigest(activation.approval) !== controlDigest(context.execution) ||
      activation.proposalDigest !== controlDigest(proposal) ||
      activation.validationDigest !== controlDigest(validation) ||
      validation.proposalDigest !== controlDigest(proposal) ||
      passed.pinDigest !== proposal.pins.generationId ||
      passed.diffDigest !== operation.diffDigest ||
      proposal.diffDigest !== operation.diffDigest ||
      activation.diffDigest !== operation.diffDigest ||
      proposal.baseGenerationId !== operation.expectedGenerationId ||
      Date.now() >= Date.parse(passed.expiresAt) ||
      Date.parse(passed.completedAt) > Date.now() ||
      Date.parse(passed.expiresAt) > Date.parse(passed.completedAt) + 86400000
    )
      throw Error("Catalog approval evidence changed or expired");
    const currentValidation = readCurrentCatalogValidation(installation);
    if (
      currentValidation?.selected?.proposalId !== operation.proposalId ||
      currentValidation.selected.validationId !== operation.validationId ||
      currentValidation.selected.validationDigest !== controlDigest(validation)
    )
      throw Error("Validation was invalidated before slot reuse");
    const validated = verifyDataControlTerminalWitness(installation, validation.sourceExecution);
    if (
      validated.status.status !== "ok" ||
      validated.status.result?.kind !== "catalog.validate" ||
      validated.status.result.status !== "passed" ||
      validated.status.result.validationId !== passed.validationId
    )
      throw Error("Successful original validation completion required");
    const admission = verifyControl(
      installation.publicKey,
      originRecordDomain(
        "openmapx-control-execution",
        readPrivateRecord(
          own.installation,
          "executions",
          `${context.execution.operationKey}.json`,
          65536,
        ),
      ),
      readPrivateRecord(
        own.installation,
        "executions",
        `${context.execution.operationKey}.json`,
        65536,
      ),
      catalogApprovalAdmissionSchema,
    );
    if (
      canonicalJson(admission.parent) !== canonicalJson(retainedControlParent(activation.parent)) ||
      canonicalJson(admission.operation) !== canonicalJson(operation)
    )
      throw Error("Approval differs from its actual parent admission");
    const promoted = restoreAdmittedControlExecution(installation, activation.promotion.execution),
      promotion = executionAuthorityState(promoted);
    if (
      promotion.kind !== "motis.primary.promote" ||
      activation.promotion.adoption.leaseId !== lease.leaseId
    )
      throw Error("Promotion must belong to this exact original physical root");
    const assertion = retainedControlAdoptionAssertion(
        installation,
        activation.promotion.adoption,
        activation.promotion.execution,
      ),
      grant = inspectArtifactDelegation({
        dataRoot: own.installation.dataRoot,
        installation,
        assertion,
      });
    if (
      grant.phase !== "promote-primary" ||
      controlDigest(grant.parent) !== controlDigest(activation.parent) ||
      controlDigest(grant.owner) !== controlDigest(lease.owner)
    )
      throw Error("Original promotion grant required");
    verifyRetainedArtifactTargetSettlement(
      installation,
      activation.promotion.adoption,
      activation.promotion.execution,
    );
    const settlement = childSettlementState(
      verifyControlEffectSettlement(installation, activation.promotion.execution),
    ).evidence;
    if (
      settlement.outcome !== "committed" ||
      settlement.publication !== "committed" ||
      settlement.terminalReceiptDigest !== activation.promotion.terminalReceiptDigest
    )
      throw Error("Original successful promotion settlement required");
    const effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(
        own.installation,
        "effects",
        `${activation.promotion.execution.operationKey}.json`,
        65536,
      ),
      catalogPromotionEffectSchema,
    );
    if (parseOpsResult("motis.primary.promote", effect.receipt.result).activeRunId !== passed.epoch)
      throw Error("Promotion activated a different candidate");
    const selected = await runtime["transitousLock.inspect"](
      { kind: "transitousLock.inspect", proposalId: operation.proposalId, offset: 0 },
      context,
    );
    if (
      !selected.validationInputs ||
      !sameCatalogRuntimeInputs(
        validation.runtimeInputs,
        scopeCatalogRuntimeInputs(
          catalogRuntimeInputsSchema.parse(selected.validationInputs),
          passed.countries,
        ),
      ) ||
      !sameCatalogRuntimeInputs(
        activation.runtimeInputs,
        scopeCatalogRuntimeInputs(
          catalogRuntimeInputsSchema.parse(selected.validationInputs),
          passed.countries,
        ),
      )
    )
      throw Error("Effective policy, image or credential mount changed");
    const rootPath = realpathSync(own.installation.dataRoot),
      livePath = realpathSync(join(rootPath, "motis/live"));
    if (!livePath.startsWith(rootPath + sep))
      throw Error("Live candidate escaped its installation");
    const live = new AnchoredDirectory(livePath);
    try {
      const bytes = live.read("motis-candidate-manifest.json", 32 * 1024 * 1024, false);
      if (createHash("sha256").update(bytes).digest("hex") !== passed.manifestHash)
        throw Error("Activated manifest differs from validation");
      // The host independently rejoins its actual promotion's signed candidate
      // publication and current inode/size/mtime/ctime inventory. Re-reading
      // multi-hundred-GB datasets inside a 120-second pin leaf is not viable;
      // the owned DM validation/activation worker hashes their complete bytes.
      const promotedBody = { kind: "motis.primary.promote" as const, preparedRunId: passed.epoch };
      const candidate = inspectDataTransitCandidate(
        installation,
        activation.promotion.execution.operationKey,
        promotedBody,
      );
      verifyDataTransitCandidateForExecution(promoted, promotedBody, candidate.digest);
    } finally {
      live.close();
    }
    const commit = {
      commitId: catalogApprovalCommitId(
        context.execution.operationKey,
        context.execution.fingerprint,
      ),
      execution: context.execution,
      proposalId: operation.proposalId,
      validationId: operation.validationId,
      diffDigest: operation.diffDigest,
    };
    const current = readCatalogPinSet(options.rootDir);
    if ((current?.generationId ?? null) !== operation.expectedGenerationId)
      throw Error("Active catalog pair changed");
    const receipt = await publishCatalogPinSet({
      rootDir: options.rootDir,
      lease,
      pins: proposal.pins,
      expectedGenerationId: operation.expectedGenerationId,
      commit,
    });
    if (receipt.phase !== "committed" || !receipt.committedAt)
      throw Error("Catalog pin publication requires exact attempt recovery");
    return {
      outcome: "activated",
      proposalId: operation.proposalId,
      validationId: operation.validationId,
      previousGenerationId: operation.expectedGenerationId,
      generationId: receipt.generationId,
      commitId: commit.commitId,
      committedAt: receipt.committedAt,
    };
  };
}
