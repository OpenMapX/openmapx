/** Private fixed final producer records. Parsing is never final authority. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { ownedServiceSnapshotSchema } from "../ops/owned-service-records";
import {
  configurationFinalEvidenceProjectionSchema,
  configurationFinalEvidenceSchema,
  configurationOwnerFinalSchema,
  configurationSettlementDomains,
  configurationSettlementOwnerIdentitySchema,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import type { ConfigurationMaintenanceOwnerRecord } from "./configuration-maintenance-owner-records";
import { controlDigest } from "./control-records";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  epoch = z.number().int().nonnegative().safe();
const signed = <T extends z.ZodType>(payload: T) =>
  z.strictObject({ payload, signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export const configurationMaintenanceRequiredChecksSchema = z
  .array(
    z.strictObject({
      serviceId: z
        .string()
        .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
        .nullable(),
      ordinal: z.number().int().min(0).max(31).nullable(),
      check: z.enum([
        "generation",
        "owner-containers",
        "frozen-attempts",
        "candidate-not-consumed",
        "dm-guard",
        "configuration",
        "image",
        "mount",
        "readiness",
      ]),
      expectedRevisionId: z
        .string()
        .regex(/^cfg1_[A-Za-z0-9_-]{43}$/)
        .nullable(),
      expectedImageId: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .nullable(),
    }),
  )
  .max(1024);
export const configurationMaintenanceRuntimeInspectionSchema = z.strictObject({
  version: z.literal(2),
  identity: z.lazy(() => configurationSettlementOwnerIdentitySchema),
  inspectionId: z.uuid(),
  ownerSequence: epoch,
  ownerSourceDigest: digest,
  requiredChecks: configurationMaintenanceRequiredChecksSchema,
  observations: z
    .array(
      z.strictObject({
        checkIndex: z.number().int().min(0).max(1023),
        passed: z.literal(true),
        detail: z.string().max(16384),
      }),
    )
    .max(1024),
  runtime: z.lazy(() => configurationFinalEvidenceSchema.shape.runtime),
});
export const signedConfigurationMaintenanceRuntimeInspectionSchema = signed(
  configurationMaintenanceRuntimeInspectionSchema,
);
export const configurationMaintenanceFinalRecordSchema = z.strictObject({
  ownerFinal: signed(z.lazy(() => configurationOwnerFinalSchema)),
  evidence: z.lazy(() => configurationFinalEvidenceSchema),
  evidenceProjection: z.lazy(() => configurationFinalEvidenceProjectionSchema),
  evidenceDigest: digest,
  ownerReceiptDigest: digest,
});
const unusedCandidateObservationSchema = z.strictObject({
  candidateId: z.uuid(),
  revisionId: z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/),
  recordDigest: digest,
  directories: z
    .array(
      z.strictObject({
        name: z.enum(["queue", "claimed"]),
        dev: epoch,
        ino: epoch,
        uid: epoch,
        gid: epoch,
        mode: z.literal(0o700),
        entries: z.number().int().min(0).max(1024),
        matchingCandidateEntries: z.literal(0),
      }),
    )
    .length(2),
});
/** Consistency only. The caller must authenticate/index the ACTUAL owner,
 * inspection and final first. No parsed state creates final authority. */
export function assertUnusedConfigurationMaintenanceFinalState(
  owner: ConfigurationMaintenanceOwnerRecord,
): void {
  const final = owner.final,
    signedInspection = owner.inspection,
    decision = owner.apiControls.decide;
  if (
    !final ||
    !signedInspection ||
    !decision?.receiptDelivery ||
    !owner.guardSource ||
    owner.noGuard ||
    owner.issuance !== "open"
  )
    throw Error("Actual unused original final source required");
  const inspection = signedInspection.payload,
    original = final.ownerFinal.payload,
    evidence = final.evidence,
    same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
    requiredChecks = configurationMaintenanceRequiredChecksSchema.parse([
      ...["generation", "owner-containers", "candidate-not-consumed", "dm-guard"].map((check) => ({
        serviceId: null,
        ordinal: null,
        check,
        expectedRevisionId: owner.plan.operation.expectedCurrentRevisionId,
        expectedImageId: null,
      })),
      ...owner.plan.steps.map((step) => ({
        serviceId: null,
        ordinal: step.ordinal,
        check: "frozen-attempts",
        expectedRevisionId: owner.plan.operation.revisionId,
        expectedImageId: null,
      })),
    ]),
    settle = owner.apiControls.settle,
    beforeInspection = {
      ...owner,
      sequence: inspection.ownerSequence,
      final: null,
      inspection: null,
      apiControls: {
        ...owner.apiControls,
        settle: settle
          ? {
              ...settle,
              completedAt: null,
              result: null,
              canonicalDigest: null,
              receiptDelivery: null,
            }
          : null,
      },
      receipt: {
        ...owner.receipt,
        sequence: inspection.ownerSequence,
        state: "authorized",
        dmFence: owner.guardSource.preparedReceipt,
      },
    };
  const details = inspection.observations.map((value) => {
      const parsed: unknown = JSON.parse(value.detail);
      if (canonicalJson(parsed) !== value.detail)
        throw Error("Original unused observation encoding changed");
      return parsed;
    }),
    candidate = unusedCandidateObservationSchema.parse(details[2]);
  if (
    !same(details[0], { currentRevisionId: owner.plan.operation.expectedCurrentRevisionId }) ||
    !same(details[1], { containers: owner.originalContainers }) ||
    !same(details[3], { guard: owner.guardSource.preparedReceipt }) ||
    candidate.candidateId !== owner.plan.operation.candidateId ||
    candidate.revisionId !== owner.plan.operation.revisionId ||
    candidate.recordDigest !== owner.plan.candidateRecordDigest ||
    candidate.directories[0]!.name !== "queue" ||
    candidate.directories[1]!.name !== "claimed" ||
    candidate.directories[0]!.uid !== candidate.directories[1]!.uid ||
    candidate.directories[0]!.gid !== candidate.directories[1]!.gid ||
    !owner.plan.steps.every((step, index) =>
      same(details[index + 4], {
        phase: step.phase,
        ordinal: step.ordinal,
        operationKey: step.operationKey,
        binding: null,
        publication: "unissued",
      }),
    )
  )
    throw Error("Actual original unused runtime observations changed");
  if (
    original.outcome !== "unused" ||
    evidence.outcome !== "unused" ||
    inspection.runtime.mode !== "unused" ||
    owner.receipt.generation !== "not_started" ||
    owner.receipt.followUp !== "not_started" ||
    owner.apiControls.steps.length ||
    inspection.ownerSourceDigest !== controlDigest(beforeInspection) ||
    original.ownerSequence !== inspection.ownerSequence + 1 ||
    original.ownerSequence > owner.sequence ||
    original.privateInspectionId !== inspection.inspectionId ||
    !same(inspection.requiredChecks, requiredChecks) ||
    inspection.observations.length !== requiredChecks.length ||
    !inspection.observations.every((value, index) => value.checkIndex === index && value.passed) ||
    inspection.runtime.requiredCheckSetDigest !==
      settlementRecordDigest(configurationSettlementDomains.inspection, requiredChecks) ||
    !same(inspection.identity, original.identity) ||
    !same(evidence.identity, original.identity) ||
    !same(evidence.runtime, inspection.runtime) ||
    original.identity.installationId !== owner.installationId ||
    !same(original.identity.origin, owner.origin) ||
    !same(original.identity.ownerPrepare, owner.plan.prepare) ||
    original.identity.admissionDigest !== owner.admissionDigest ||
    original.identity.rootCertificateDigest !== owner.rootCertificateDigest ||
    original.identity.maintenanceId !== owner.plan.operation.maintenanceId ||
    original.identity.candidateId !== owner.plan.operation.candidateId ||
    original.identity.planDigest !== owner.plan.planDigest ||
    original.identity.settlementId !== owner.plan.dmSettle.settlementId ||
    evidence.children.length ||
    evidence.generation.state !== "not_committed" ||
    evidence.followUp.state !== "not_started" ||
    evidence.followUp.receiptDigests.length ||
    evidence.decision.decision !== "abandon" ||
    evidence.decision.decisionId !== owner.receipt.decision?.decisionId ||
    evidence.decision.checkpointVersion !== decision.operation.checkpointVersion ||
    evidence.decision.checkpointDigest !== decision.operation.checkpointDigest ||
    evidence.decision.apiParentAttestationDigest !== decision.apiParent.assertionDigest ||
    !same(evidence.guard.preparedReceipt, owner.guardSource.preparedReceipt) ||
    evidence.guard.fenceId !== owner.guardSource.preparedReceipt.fenceId ||
    evidence.guard.preparedReceiptDigest !== owner.guardSource.preparedReceiptDigest ||
    evidence.guard.preparedCanonicalDigest !== owner.guardSource.preparedCanonicalDigest ||
    evidence.guard.preparedTerminalAt !== owner.guardSource.preparedTerminalAt ||
    original.expectedDmSequence !== owner.guardSource.preparedReceipt.sequence ||
    !same(final.evidenceProjection, evidence) ||
    final.evidenceDigest !==
      settlementRecordDigest(
        configurationSettlementDomains.finalEvidence,
        final.evidenceProjection,
      ) ||
    original.evidenceDigest !== final.evidenceDigest ||
    final.ownerReceiptDigest !==
      settlementRecordDigest(configurationSettlementDomains.ownerFinal, original)
  )
    throw Error("Actual original unused final evidence changed");
}
/** Consistency only; actual canonical/effect/tree sources are checked by the
 * fixed producer/restorer and the mandatory root closure predicate. */
export function assertAppliedConfigurationMaintenanceFinalState(
  owner: ConfigurationMaintenanceOwnerRecord,
): void {
  assertExecutedConfigurationMaintenanceFinalState(owner, "applied");
}
export function assertContainedConfigurationMaintenanceFinalState(
  owner: ConfigurationMaintenanceOwnerRecord,
): void {
  assertExecutedConfigurationMaintenanceFinalState(owner, "contained");
}
function assertExecutedConfigurationMaintenanceFinalState(
  owner: ConfigurationMaintenanceOwnerRecord,
  mode: "applied" | "contained",
): void {
  const final = owner.final,
    signedInspection = owner.inspection,
    decision = owner.apiControls.decide;
  if (
    !final ||
    !signedInspection ||
    !decision?.receiptDelivery ||
    !owner.guardSource ||
    owner.noGuard ||
    owner.issuance !== "open"
  )
    throw Error("Actual applied final sources required");
  const inspection = signedInspection.payload,
    original = final.ownerFinal.payload,
    evidence = final.evidence,
    same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b),
    contained = mode === "contained",
    inspectedRevision = contained
      ? owner.plan.operation.expectedCurrentRevisionId
      : owner.plan.operation.revisionId,
    ids = [
      ...new Set([
        ...owner.plan.steps
          .filter((value) => value.phase === "maintenance-recreate")
          .map((value) => ("serviceId" in value.operation ? value.operation.serviceId : "")),
        ...(owner.plan.handoff?.serviceIds ?? []),
      ]),
    ].sort(),
    releaseImage = (serviceId: string) => {
      const release = owner.plan.release;
      if (contained || !release) return undefined;
      const index = 3 + owner.plan.steps.length + ids.indexOf(serviceId) * 4 + 1,
        observation = inspection.observations[index];
      if (!observation || observation.checkIndex !== index)
        throw Error("Original release image observation required");
      const image = z
          .strictObject({
            containerId: z.string().regex(/^[a-f0-9]{64}$/),
            imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            expectedImageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
            releaseReference: z.string(),
            releasePlatformManifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
          })
          .parse(JSON.parse(observation.detail)),
        reference = release.serviceImages[serviceId as keyof typeof release.serviceImages],
        download = release.downloads.images.find((value) => value.reference === reference),
        containers = z
          .strictObject({ containers: z.array(ownedServiceSnapshotSchema).max(256) })
          .parse(JSON.parse(inspection.observations[1]!.detail))
          .containers.filter((value) => value.serviceId === serviceId);
      if (
        containers.length !== 1 ||
        containers[0]!.containerId !== image.containerId ||
        containers[0]!.provenance.imageId !== image.imageId ||
        !download ||
        image.releaseReference !== reference ||
        image.releasePlatformManifestDigest !== download.platformManifestDigest ||
        image.imageId !== image.expectedImageId
      )
        throw Error("Original checked release image observation changed");
      return image.expectedImageId;
    },
    requiredChecks = configurationMaintenanceRequiredChecksSchema.parse([
      ...["generation", "owner-containers", "dm-guard"].map((check) => ({
        serviceId: null,
        ordinal: null,
        check,
        expectedRevisionId: inspectedRevision,
        expectedImageId: null,
      })),
      ...owner.plan.steps.map((step) => ({
        serviceId: null,
        ordinal: step.ordinal,
        check: "frozen-attempts",
        expectedRevisionId: owner.plan.operation.revisionId,
        expectedImageId: null,
      })),
      ...ids.flatMap((serviceId) =>
        ["configuration", "image", "mount", "readiness"].map((check) => ({
          serviceId,
          ordinal: null,
          check,
          expectedRevisionId: inspectedRevision,
          expectedImageId:
            releaseImage(serviceId) ??
            (!contained && serviceId === "data-manager" && owner.plan.coordinatorImage
              ? owner.plan.coordinatorImage.imageId
              : owner.originalContainers.find((value) => value.serviceId === serviceId)?.provenance
                  .imageId),
        })),
      ),
    ]),
    settle = owner.apiControls.settle,
    before = {
      ...owner,
      sequence: inspection.ownerSequence,
      final: null,
      inspection: null,
      apiControls: {
        ...owner.apiControls,
        settle: settle
          ? {
              ...settle,
              completedAt: null,
              result: null,
              canonicalDigest: null,
              receiptDelivery: null,
            }
          : null,
      },
      receipt: {
        ...owner.receipt,
        sequence: inspection.ownerSequence,
        state: "applying",
        dmFence: owner.guardSource.preparedReceipt,
      },
    },
    details = inspection.observations.map((value) => {
      const parsed: unknown = JSON.parse(value.detail);
      if (canonicalJson(parsed) !== value.detail)
        throw Error("Applied observation encoding changed");
      return parsed;
    }),
    { children, ...base } = evidence,
    projection = {
      ...base,
      children: children.map(({ execution, ...child }) => ({
        ...child,
        executionDigest: controlDigest(execution),
      })),
    };
  const generation = owner.apiControls.steps.find((value) => value.ordinal === 0)?.canonical?.status
    .result as { outcome?: string; cleanupFailed?: boolean } | undefined;
  if (
    original.outcome !== mode ||
    evidence.outcome !== mode ||
    inspection.runtime.mode !== mode ||
    (contained
      ? !inspectedRevision ||
        owner.receipt.generation !== "not_committed" ||
        owner.receipt.appliedRevisionId !== null ||
        owner.receipt.followUp !== "contained" ||
        owner.apiControls.steps.length !== 1 ||
        generation?.outcome !== "not_committed" ||
        generation.cleanupFailed ||
        children.length !== 1 ||
        !same(details[1], { containers: owner.originalContainers })
      : owner.receipt.generation !== "committed" ||
        owner.receipt.appliedRevisionId !== owner.plan.operation.revisionId ||
        owner.receipt.followUp !== "complete" ||
        owner.apiControls.steps.length !== owner.plan.steps.length) ||
    owner.apiControls.steps.some((value) => !value.canonical || !value.receiptDelivery) ||
    inspection.ownerSourceDigest !== controlDigest(before) ||
    original.ownerSequence !== inspection.ownerSequence + 1 ||
    original.ownerSequence > owner.sequence ||
    original.privateInspectionId !== inspection.inspectionId ||
    !same(inspection.requiredChecks, requiredChecks) ||
    inspection.observations.length !== requiredChecks.length ||
    !inspection.observations.every((value, index) => value.checkIndex === index && value.passed) ||
    !same(details[0], {
      currentRevisionId: inspectedRevision,
      ...(!contained && owner.plan.release
        ? {
            currentRelease: {
              releaseId: owner.plan.release.releaseId,
              digest: owner.plan.release.manifestDigest,
              updateJobId:
                owner.plan.apiParent.issuer === "api" ? owner.plan.apiParent.apiJobId : null,
            },
          }
        : {}),
    }) ||
    !same(details[2], { guard: owner.guardSource.preparedReceipt }) ||
    !owner.plan.steps.every((step, index) =>
      same(details[index + 3], {
        children: evidence.children.filter((value) => value.planIndex === step.ordinal),
      }),
    ) ||
    inspection.runtime.requiredCheckSetDigest !==
      settlementRecordDigest(configurationSettlementDomains.inspection, requiredChecks) ||
    !same(inspection.identity, original.identity) ||
    !same(evidence.identity, original.identity) ||
    !same(evidence.runtime, inspection.runtime) ||
    original.identity.installationId !== owner.installationId ||
    !same(original.identity.origin, owner.origin) ||
    !same(original.identity.ownerPrepare, owner.plan.prepare) ||
    original.identity.admissionDigest !== owner.admissionDigest ||
    original.identity.rootCertificateDigest !== owner.rootCertificateDigest ||
    original.identity.maintenanceId !== owner.plan.operation.maintenanceId ||
    original.identity.candidateId !== owner.plan.operation.candidateId ||
    original.identity.planDigest !== owner.plan.planDigest ||
    original.identity.settlementId !== owner.plan.dmSettle.settlementId ||
    evidence.decision.decision !== "continue" ||
    evidence.decision.decisionId !== owner.receipt.decision?.decisionId ||
    evidence.decision.checkpointVersion !== decision.operation.checkpointVersion ||
    evidence.decision.checkpointDigest !== decision.operation.checkpointDigest ||
    evidence.decision.apiParentAttestationDigest !== decision.apiParent.assertionDigest ||
    !same(evidence.guard.preparedReceipt, owner.guardSource.preparedReceipt) ||
    evidence.guard.preparedReceiptDigest !== owner.guardSource.preparedReceiptDigest ||
    evidence.guard.preparedCanonicalDigest !== owner.guardSource.preparedCanonicalDigest ||
    evidence.guard.preparedTerminalAt !== owner.guardSource.preparedTerminalAt ||
    original.expectedDmSequence !== owner.guardSource.preparedReceipt.sequence ||
    (contained
      ? evidence.generation.state !== "not_committed" ||
        evidence.generation.revisionId !== null ||
        evidence.generation.commitReceiptDigest !== null ||
        evidence.followUp.state !== "contained" ||
        evidence.followUp.receiptDigests.length !== 0
      : evidence.generation.state !== "committed" ||
        evidence.generation.revisionId !== owner.plan.operation.revisionId ||
        evidence.followUp.state !== "complete") ||
    !same(final.evidenceProjection, projection) ||
    final.evidenceDigest !==
      settlementRecordDigest(configurationSettlementDomains.finalEvidence, projection) ||
    original.evidenceDigest !== final.evidenceDigest ||
    final.ownerReceiptDigest !==
      settlementRecordDigest(configurationSettlementDomains.ownerFinal, original)
  )
    throw Error("Actual original applied final evidence changed");
}
