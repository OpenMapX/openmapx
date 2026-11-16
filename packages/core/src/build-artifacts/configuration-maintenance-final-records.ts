/** Private fixed final producer records. Parsing is never final authority. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { executionRefSchema } from "../ops/execution-ref";
import { ownedServiceSnapshotSchema } from "../ops/owned-service-records";
import { dataConfigurationFenceReceiptSchema } from "../services/data-manager/contracts/configuration-maintenance";
import type { ConfigurationMaintenanceOwnerRecord } from "./configuration-maintenance-owner-records";
import { controlDigest, controlOriginSchema } from "./control-records";

const digest = z.string().regex(/^[a-f0-9]{64}$/),
  epoch = z.number().int().nonnegative().safe();
const id = z.uuid();
const uniqueSorted = <T extends z.ZodType<string>>(schema: T, max: number) =>
  z
    .array(schema)
    .max(max)
    .refine((items) => items.every((item, i) => i === 0 || items[i - 1]! < item));
const digests = uniqueSorted(digest, 64);
const revision = z.string().regex(/^cfg1_[A-Za-z0-9_-]{43}$/);
export const configurationFinalDomains = Object.freeze({
  finalEvidence: "openmapx-configuration-final-evidence-v2",
  ownerFinal: "openmapx-configuration-owner-final-v2",
  inspection: "openmapx-configuration-runtime-inspection-v2",
});
export const finalRecordDigest = (
  domain: (typeof configurationFinalDomains)[keyof typeof configurationFinalDomains],
  value: unknown,
) =>
  createHash("sha256")
    .update(`${domain}\0${canonicalJson(value)}`)
    .digest("hex");
export const configurationOwnerIdentitySchema = z
  .strictObject({
    origin: controlOriginSchema,
    ownerPrepare: executionRefSchema,
    admissionDigest: digest,
    leaseId: id,
    maintenanceId: id,
    candidateId: id,
    planDigest: digest,
  })
  .refine(
    (value) =>
      value.origin.issuer === "ops-agent" &&
      value.ownerPrepare.executor === "ops-agent" &&
      value.ownerPrepare.principal === "api" &&
      value.ownerPrepare.deadlineAt <= value.origin.notAfter,
  );
const preparedGuardSchema = z.strictObject({
  fenceId: id,
  preparedReceipt: dataConfigurationFenceReceiptSchema.refine(
    (receipt) => receipt.state === "prepared",
  ),
});
const configurationDecisionEvidenceSchema = z.strictObject({
  decisionId: id,
  decision: z.enum(["continue", "abandon"]),
  checkpointVersion: epoch,
  checkpointDigest: digest,
  apiParentAttestationDigest: digest,
});
export const configurationChildEvidenceSchema = z.strictObject({
  planIndex: z.number().int().min(0).max(31),
  execution: executionRefSchema,
  terminalDigest: digest,
  terminalAt: epoch,
  effectSettlementDigest: digest,
  publication: z.enum(["not_started", "committed"]),
});
const childProjection = configurationChildEvidenceSchema
  .omit({ execution: true })
  .extend({ executionDigest: digest });
const generation = z
  .strictObject({
    state: z.enum(["not_committed", "committed"]),
    revisionId: revision.nullable(),
    commitReceiptDigest: digest.nullable(),
  })
  .refine((value) =>
    value.state === "committed"
      ? value.revisionId !== null && value.commitReceiptDigest !== null
      : value.revisionId === null && value.commitReceiptDigest === null,
  );
const followUp = z.strictObject({
  state: z.enum(["not_started", "complete", "contained"]),
  receiptDigests: digests,
});
const runtime = z.strictObject({
  verificationId: id,
  mode: z.enum(["unused", "applied", "contained"]),
  requiredCheckSetDigest: digest,
  checkedAt: epoch,
});
const finalFields = {
  identity: configurationOwnerIdentitySchema,
  guard: preparedGuardSchema,
  decision: configurationDecisionEvidenceSchema,
  generation,
  followUp,
  runtime,
  outcome: z.enum(["unused", "applied", "contained"]),
};
function eligible(value: z.infer<z.ZodObject<typeof finalFields>>) {
  return (
    value.runtime.mode === value.outcome &&
    (value.outcome === "unused"
      ? value.decision.decision === "abandon" &&
        value.generation.state === "not_committed" &&
        value.followUp.state === "not_started"
      : value.decision.decision === "continue" &&
        (value.outcome !== "applied" ||
          (value.generation.state === "committed" &&
            value.generation.revisionId === value.guard.preparedReceipt.revisionId &&
            value.followUp.state === "complete")))
  );
}
export const configurationFinalEvidenceSchema = z
  .strictObject({ ...finalFields, children: z.array(configurationChildEvidenceSchema).max(64) })
  .refine(eligible);
export const configurationFinalEvidenceProjectionSchema = z
  .strictObject({ ...finalFields, children: z.array(childProjection).max(64) })
  .refine(eligible);
export const configurationOwnerFinalSchema = z.strictObject({
  version: z.literal(2),
  identity: configurationOwnerIdentitySchema,
  ownerSequence: epoch,
  settlingAt: epoch,
  expectedDmSequence: epoch,
  evidenceDigest: digest,
  outcome: z.enum(["unused", "applied", "contained"]),
  privateInspectionId: id,
});
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
  identity: z.lazy(() => configurationOwnerIdentitySchema),
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
export const configurationMaintenanceFinalRecordSchema = z.strictObject({
  ownerFinal: z.lazy(() => configurationOwnerFinalSchema),
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
  if (!final || !signedInspection || !decision || !owner.preparedFence)
    throw Error("Actual unused original final source required");
  const inspection = signedInspection,
    original = final.ownerFinal,
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
            }
          : null,
      },
      receipt: {
        ...owner.receipt,
        sequence: inspection.ownerSequence,
        state: "authorized",
        dmFence: owner.preparedFence,
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
    !same(details[3], { guard: owner.preparedFence }) ||
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
      finalRecordDigest(configurationFinalDomains.inspection, requiredChecks) ||
    !same(inspection.identity, original.identity) ||
    !same(evidence.identity, original.identity) ||
    !same(evidence.runtime, inspection.runtime) ||
    !same(original.identity.origin, owner.origin) ||
    !same(original.identity.ownerPrepare, owner.plan.prepare) ||
    original.identity.admissionDigest !== owner.admissionDigest ||
    original.identity.leaseId !== owner.leaseId ||
    original.identity.maintenanceId !== owner.plan.operation.maintenanceId ||
    original.identity.candidateId !== owner.plan.operation.candidateId ||
    original.identity.planDigest !== owner.plan.planDigest ||
    evidence.children.length ||
    evidence.generation.state !== "not_committed" ||
    evidence.followUp.state !== "not_started" ||
    evidence.followUp.receiptDigests.length ||
    evidence.decision.decision !== "abandon" ||
    evidence.decision.decisionId !== owner.receipt.decision?.decisionId ||
    evidence.decision.checkpointVersion !== decision.operation.checkpointVersion ||
    evidence.decision.checkpointDigest !== decision.operation.checkpointDigest ||
    evidence.decision.apiParentAttestationDigest !== decision.apiParent.assertionDigest ||
    !same(evidence.guard.preparedReceipt, owner.preparedFence) ||
    evidence.guard.fenceId !== owner.preparedFence.fenceId ||
    original.expectedDmSequence !== owner.preparedFence.sequence ||
    !same(final.evidenceProjection, evidence) ||
    final.evidenceDigest !==
      finalRecordDigest(configurationFinalDomains.finalEvidence, final.evidenceProjection) ||
    original.evidenceDigest !== final.evidenceDigest ||
    final.ownerReceiptDigest !== finalRecordDigest(configurationFinalDomains.ownerFinal, original)
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
  if (!final || !signedInspection || !decision || !owner.preparedFence)
    throw Error("Actual applied final sources required");
  const inspection = signedInspection,
    original = final.ownerFinal,
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
            }
          : null,
      },
      receipt: {
        ...owner.receipt,
        sequence: inspection.ownerSequence,
        state: "applying",
        dmFence: owner.preparedFence,
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
    owner.apiControls.steps.some((value) => !value.canonical) ||
    inspection.ownerSourceDigest !== controlDigest(before) ||
    original.ownerSequence !== inspection.ownerSequence + 1 ||
    original.ownerSequence > owner.sequence ||
    original.privateInspectionId !== inspection.inspectionId ||
    !same(inspection.requiredChecks, requiredChecks) ||
    inspection.observations.length !== requiredChecks.length ||
    !inspection.observations.every((value, index) => value.checkIndex === index && value.passed) ||
    !same(details[0], { currentRevisionId: inspectedRevision }) ||
    !same(details[2], { guard: owner.preparedFence }) ||
    !owner.plan.steps.every((step, index) =>
      same(details[index + 3], {
        children: evidence.children.filter((value) => value.planIndex === step.ordinal),
      }),
    ) ||
    inspection.runtime.requiredCheckSetDigest !==
      finalRecordDigest(configurationFinalDomains.inspection, requiredChecks) ||
    !same(inspection.identity, original.identity) ||
    !same(evidence.identity, original.identity) ||
    !same(evidence.runtime, inspection.runtime) ||
    !same(original.identity.origin, owner.origin) ||
    !same(original.identity.ownerPrepare, owner.plan.prepare) ||
    original.identity.admissionDigest !== owner.admissionDigest ||
    original.identity.leaseId !== owner.leaseId ||
    original.identity.maintenanceId !== owner.plan.operation.maintenanceId ||
    original.identity.candidateId !== owner.plan.operation.candidateId ||
    original.identity.planDigest !== owner.plan.planDigest ||
    evidence.decision.decision !== "continue" ||
    evidence.decision.decisionId !== owner.receipt.decision?.decisionId ||
    evidence.decision.checkpointVersion !== decision.operation.checkpointVersion ||
    evidence.decision.checkpointDigest !== decision.operation.checkpointDigest ||
    evidence.decision.apiParentAttestationDigest !== decision.apiParent.assertionDigest ||
    !same(evidence.guard.preparedReceipt, owner.preparedFence) ||
    original.expectedDmSequence !== owner.preparedFence.sequence ||
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
      finalRecordDigest(configurationFinalDomains.finalEvidence, projection) ||
    original.evidenceDigest !== final.evidenceDigest ||
    final.ownerReceiptDigest !== finalRecordDigest(configurationFinalDomains.ownerFinal, original)
  )
    throw Error("Actual original applied final evidence changed");
}
