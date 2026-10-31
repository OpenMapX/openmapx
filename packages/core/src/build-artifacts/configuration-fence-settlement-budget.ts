/** Prospective encoding bounds, not settlement authority. Empty signatures in
 * these LOCAL width expressions are invalid proof by construction. Their exact
 * Ed25519 wire width is added arithmetically; no hypothetical signed packet is
 * published or returned. Actual source producers/verifiers remain mandatory. */
import type { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { parseControlRootOperationKey } from "../ops/control-root-key";
import {
  type ConfigurationSettlementProjection,
  configurationSettlementRecordDescriptors,
} from "./configuration-fence-settlement-descriptors";
import {
  configurationFinalEvidenceProjectionSchema,
  configurationOwnerFinalSchema,
  configurationPreparedGuardSchema,
  configurationSettlementCapacitySchema,
  configurationSettlementDomains,
  configurationSettlementOwnerIdentitySchema,
  configurationSettlementReservationProjectionSchema,
  configurationSettlementTerminalTupleSchema,
  settlementRecordDigest,
  type signedConfigurationReservationProjectionSchema,
} from "./configuration-fence-settlement-records";
import { controlDigest } from "./control-records";
import type { FixedConfigurationMaintenancePlan } from "./fixed-configuration-maintenance";

const uuid = "ffffffff-ffff-4fff-bfff-ffffffffffff",
  hash = "f".repeat(64),
  at = Number.MAX_SAFE_INTEGER;
const hashes = (count: number) =>
  Array.from({ length: count }, (_, index) => controlDigest({ index })).sort();
const wrap = <T>(payload: T) => ({ payload, signature: "" });
function width(value: unknown): number {
  let missingSignatures = 0;
  const count = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (!Array.isArray(item) && "signature" in item && item.signature === "") missingSignatures++;
    for (const child of Object.values(item)) count(child);
  };
  count(value);
  return Buffer.byteLength(canonicalJson(value)) + missingSignatures * 86;
}
export function assertConfigurationSettlementPacketBudget(
  plan: FixedConfigurationMaintenancePlan,
  projection: ConfigurationSettlementProjection,
  signedProjection: z.infer<typeof signedConfigurationReservationProjectionSchema>,
): Readonly<Record<string, number>> {
  const prepare = plan.reservations.find((value) => value.phase === "configuration-fence");
  if (
    !prepare ||
    canonicalJson(projection.ownerPrepare) !== canonicalJson(plan.prepare) ||
    projection.planDigest !== plan.planDigest ||
    canonicalJson(signedProjection.payload) !== canonicalJson(projection) ||
    signedProjection.signature.length !== 86
  )
    throw Error("Original fixed settlement encoding source required");
  return packetWidths(plan, projection, signedProjection);
}
/** Before root acquisition there is no certificate/family/signature to trust.
 * Size their fixed-width fields arithmetically; return ONLY byte counts. */
export function assertProspectiveConfigurationSettlementPacketBudget(
  plan: FixedConfigurationMaintenancePlan,
  installationId: string,
) {
  const reservation = plan.reservations.find(
    (value) => value.phase === "configuration-fence-settle",
  );
  if (!reservation) throw Error("Original planned settlement reservation required");
  const projection = configurationSettlementReservationProjectionSchema.parse({
    version: 2,
    purpose: "configuration-fence-settlement-reservation",
    installationId,
    origin: {
      version: 1,
      issuer: "ops-agent",
      rootKey: plan.prepare.operationKey,
      notAfter: parseControlRootOperationKey(plan.prepare.operationKey).notAfter,
    },
    ownerPrepare: plan.prepare,
    rootAdmissionDigest: hash,
    rootCertificateDigest: hash,
    maintenanceId: plan.operation.maintenanceId,
    candidateId: plan.operation.candidateId,
    planDigest: plan.planDigest,
    settlementId: plan.dmSettle.settlementId,
    reservation,
    operation: { kind: "configuration-maintenance.settle", ...plan.dmSettle },
    reservationDigest: settlementRecordDigest(
      configurationSettlementDomains.reservationTuple,
      reservation,
    ),
    issuerMembership: {
      role: "ops-agent",
      familyId: uuid,
      rootMemberOrdinal: 255,
      rootExecutionDigest: hash,
      rootAdmissionDigest: hash,
    },
  });
  return packetWidths(plan, projection, wrap(projection));
}
function packetWidths(
  plan: FixedConfigurationMaintenancePlan,
  projection: ConfigurationSettlementProjection,
  signedProjection: { payload: ConfigurationSettlementProjection; signature: string },
): Readonly<Record<string, number>> {
  const prepare = plan.reservations.find((value) => value.phase === "configuration-fence");
  if (!prepare) throw Error("Original planned preparation required");
  const descriptors = configurationSettlementRecordDescriptors(
      projection,
      prepare.execution.operationKey,
    ),
    all = [...descriptors.sender, ...descriptors.receiver],
    identity = configurationSettlementOwnerIdentitySchema.parse({
      installationId: projection.installationId,
      origin: projection.origin,
      ownerPrepare: plan.prepare,
      admissionDigest: projection.rootAdmissionDigest,
      rootCertificateDigest: projection.rootCertificateDigest,
      maintenanceId: projection.maintenanceId,
      candidateId: projection.candidateId,
      planDigest: projection.planDigest,
      settlementId: projection.settlementId,
    }),
    originalReceipt = {
      fenceId: prepare.execution.executionId,
      maintenanceId: projection.maintenanceId,
      candidateId: projection.candidateId,
      ownerPrepare: plan.prepare,
      planDigest: plan.planDigest,
      revisionId: plan.operation.revisionId,
      hardlinkPlanDigest: plan.dmPrepare.hardlinkPlanDigest,
      sequence: 0,
      state: "prepared" as const,
    },
    guard = configurationPreparedGuardSchema.parse({
      fenceId: prepare.execution.executionId,
      preparedReceipt: originalReceipt,
      preparedReceiptDigest: hash,
      preparedCanonicalDigest: hash,
      preparedTerminalAt: at,
    }),
    runtime = {
      verificationId: uuid,
      mode: "contained" as const,
      requiredCheckSetDigest: hash,
      checkedAt: at,
    },
    attempts = [
      ...plan.steps.map((step) => ({
        index: step.ordinal,
        reservation: plan.reservations.find(
          (value) => value.phase === step.phase && value.ordinal === step.ordinal,
        )!,
      })),
      ...(plan.nestedHardlinks
        ? [
            {
              index: plan.steps.find((step) => step.phase === "maintenance-hardlinks")!.ordinal,
              reservation: plan.nestedHardlinks,
            },
          ]
        : []),
    ],
    evidence = configurationFinalEvidenceProjectionSchema.parse({
      identity,
      guard,
      decision: {
        decisionId: uuid,
        decision: "continue",
        checkpointVersion: at,
        checkpointDigest: hash,
        apiParentAttestationDigest: hash,
      },
      generation: {
        state: "committed",
        revisionId: plan.operation.revisionId,
        commitReceiptDigest: hash,
      },
      followUp: { state: "contained", receiptDigests: hashes(attempts.length) },
      runtime,
      outcome: "contained",
      children: attempts.map((attempt) => ({
        planIndex: attempt.index,
        executionDigest: hash,
        terminalDigest: hash,
        terminalAt: at,
        effectSettlementDigest: hash,
        publication: "committed",
      })),
    }),
    final = configurationOwnerFinalSchema.parse({
      version: 2,
      identity,
      ownerSequence: at,
      settlingAt: at,
      expectedDmSequence: 0,
      evidenceDigest: hash,
      outcome: "contained",
      privateInspectionId: uuid,
    }),
    committed = {
      version: 2,
      phase: "committed",
      identity,
      referenceOperationFingerprint: projection.reservation.operationFingerprint,
      final,
      evidence,
      evidenceDigest: hash,
      ownerReceiptDigest: hash,
      committedAt: at,
    },
    execution = {
      ...projection.reservation.execution,
      deadlineAt: at,
      operationFingerprint: projection.reservation.operationFingerprint,
      fingerprint: hash,
    },
    envelope = {
      version: 2,
      bindingVersion: 3,
      purpose: "configuration-fence-settlement",
      installationId: projection.installationId,
      origin: projection.origin,
      ownerPrepare: plan.prepare,
      admissionDigest: projection.rootAdmissionDigest,
      rootCertificateDigest: projection.rootCertificateDigest,
      settlementId: projection.settlementId,
      projectionDigest: hash,
      reservationDigest: projection.reservationDigest,
      commitmentDigest: hash,
      execution,
      operation: projection.operation,
      serviceIds: projection.reservation.serviceIds,
      controlStartedAt: at - 60000,
      controlDeadlineAt: at,
      originalParentForwardDeadlineAt: plan.prepare.deadlineAt,
      dispatchId: uuid,
    },
    terminal = configurationSettlementTerminalTupleSchema.parse({
      execution,
      settlementId: projection.settlementId,
      commitmentDigest: hash,
      fenceId: prepare.execution.executionId,
      result: { ...originalReceipt, state: "settled", sequence: 1 },
      publication: "committed",
      terminalAt: at,
      terminalDigest: hash,
    }),
    publishedTerminalBase = {
      version: 2,
      origin: projection.origin,
      admissionDigest: hash,
      tuple: terminal,
    },
    ack = {
      version: 2,
      installationId: projection.installationId,
      origin: projection.origin,
      settlementId: projection.settlementId,
      controlExecutionDigest: hash,
      terminalDigest: hash,
      terminalAt: at,
      commitmentDigest: hash,
    },
    capacity = configurationSettlementCapacitySchema.parse({
      version: 2,
      installationId: projection.installationId,
      origin: projection.origin,
      ownerPrepareDigest: hash,
      settlementId: projection.settlementId,
      proposedExecutionAddress: projection.reservation.execution,
      reservedExecutionOrdinal: 127,
      reservedIntentOrdinal: 255,
      recordDescriptorsDigest: hash,
      maxBytes: descriptors.receiver.reduce((sum, descriptor) => sum + descriptor.cap, 0),
      projectionDigest: hash,
      reservationDigest: hash,
    });
  const unused = (role: "ops-agent" | "data-manager") => {
    const local = role === "ops-agent" ? descriptors.sender : descriptors.receiver;
    return {
      intent: wrap({
        version: 2,
        installationId: projection.installationId,
        origin: projection.origin,
        role,
        ownerPrepareDigest: hash,
        prepareExecutionDigest: hash,
        settlementId: projection.settlementId,
        projectionDigest: hash,
        capacityReceiptDigest: hash,
        sourceProofDigest: hash,
        executionOrdinal: 127,
        intentOrdinal: 255,
        recordDescriptorsDigest: hash,
        allocatedDescriptorDigests: local.map((value) => controlDigest(value)).sort(),
        createdAt: at,
      }),
      confirmation: wrap({
        version: 2,
        installationId: projection.installationId,
        origin: projection.origin,
        role,
        ownerPrepareDigest: hash,
        settlementId: projection.settlementId,
        projectionDigest: hash,
        intentDigest: hash,
        slotStateDigest: hash,
        confirmedAt: at,
      }),
    };
  };
  const publications = plan.reservations.map((value) => ({
      phase: value.phase,
      ordinal: value.ordinal,
      operationKey: value.execution.operationKey,
      grantState: "unissued",
      intentState: "not_attempted",
    })),
    noGuard = {
      kind: "receiver_refused",
      issuerFreezeProofDigest: hash,
      prepareExecutionDigest: hash,
      prepareAdmissionDigest: hash,
      refusalProjectionDigest: hash,
      effectSettlementDigest: hash,
      canonicalTerminalDigest: hash,
      canonicalTerminalAt: at,
      dmUnusedIntentDigest: hash,
      dmUnusedConfirmationDigest: hash,
      capacityReceiptDigest: hash,
    },
    closure = {
      version: 2,
      identity,
      ownerSequence: at,
      closedAt: at,
      noGuardEvidence: noGuard,
      originalContainmentDigests: hashes(2),
      unusedSlotDigests: ["data-manager", "ops-agent"].map((role) => ({
        role,
        intentDigest: hash,
        confirmationDigest: hash,
      })),
      closureDigest: hash,
    },
    refusedFreeze = {
      version: 2,
      kind: "issued_preparation_refused",
      identity,
      issuerSequence: at,
      frozenAt: at,
      prepareGrantDigest: hash,
      prepareExecutionDigest: hash,
      refusalProjectionDigest: hash,
      remainingPublicationStates: publications.filter(
        (value) => value.phase !== "configuration-fence",
      ),
      candidateClaimState: "not_consumed",
    },
    neverIssuedFreeze = {
      version: 2,
      identity,
      issuerSequence: at,
      frozenAt: at,
      prepareReservationDigest: hash,
      publicationStates: publications,
    },
    bundle = {
      version: 2,
      phase: "unused",
      settlementId: projection.settlementId,
      projectionDigest: hash,
      closure: wrap(closure),
      issuerFreezeProof: wrap(refusedFreeze),
      issuerUnused: unused("ops-agent"),
    },
    neverIssuedBundle = {
      ...bundle,
      closure: wrap({
        ...closure,
        noGuardEvidence: {
          kind: "never_issued",
          issuerFreezeProofDigest: hash,
          prepareReservationDigest: hash,
          publicationStatesDigest: hash,
          issuerSequence: at,
          frozenAt: at,
        },
      }),
      issuerFreezeProof: wrap(neverIssuedFreeze),
    },
    linked = {
      version: 2,
      projection: signedProjection,
      binding: null,
      unused: {
        bundleDigest: hash,
        closureDigest: hash,
        issuerFreezeProofDigest: hash,
        issuerUnusedIntentDigest: hash,
        issuerUnusedConfirmationDigest: hash,
      },
    },
    dmRefusal = {
      version: 2,
      installationId: projection.installationId,
      origin: projection.origin,
      ownerPrepare: plan.prepare,
      rootAdmissionDigest: projection.rootAdmissionDigest,
      rootCertificateDigest: projection.rootCertificateDigest,
      maintenanceId: projection.maintenanceId,
      candidateId: projection.candidateId,
      planDigest: projection.planDigest,
      settlementId: projection.settlementId,
      projectionDigest: hash,
      reservationDigest: projection.reservationDigest,
      prepareExecution: {
        ...prepare.execution,
        operationFingerprint: prepare.operationFingerprint,
        deadlineAt: plan.prepare.deadlineAt,
        fingerprint: hash,
      },
      prepareAdmissionDigest: hash,
      refusalReceipt: {
        kind: "data-configuration-fence-refused",
        maintenanceId: projection.maintenanceId,
        reason: "capacity",
      },
      effectReceiptDigest: hash,
      effectSettlementDigest: hash,
      canonicalTerminalDigest: hash,
      canonicalTerminalAt: at,
      capacityReceiptDigest: hash,
    },
    sqlSession = { pid: 2147483647, backendStart: "x".repeat(64), sessionNonce: uuid },
    effect = {
      version: 2,
      origin: projection.origin,
      settlementId: projection.settlementId,
      controlExecutionDigest: hash,
      controlEnvelopeDigest: hash,
      admissionDigest: hash,
      commitmentDigest: hash,
      preparedReceiptDigest: hash,
      expectedDmSequence: 0,
      attemptedAt: at,
      sqlSession,
      phase: "committed",
      terminal,
      observation: null,
    },
    contained = {
      ...effect,
      phase: "contained_not_settled",
      terminal: null,
      observation: {
        version: 2,
        state: "contained_not_settled",
        settlementId: projection.settlementId,
        controlExecutionDigest: hash,
        controlEnvelopeDigest: hash,
        commitmentDigest: hash,
        preparedReceiptDigest: hash,
        expectedDmSequence: 0,
        attemptedAt: at,
        observationAt: at,
        sqlSession,
        containment: "original_session_absent",
      },
    };
  const { terminal: _effectTerminal, ...effectFields } = effect,
    publishedTerminal = {
      ...publishedTerminalBase,
      effectSettlementDigest: hash,
      effectSource: { fields: effectFields, signature: "" },
      admissionSource: { boundAt: at, signature: "" },
    };
  const variants: unknown[][] = [
    [wrap(committed), wrap(bundle), wrap(neverIssuedBundle)],
    [wrap(envelope)],
    [wrap({ version: 2, projection: signedProjection, binding: wrap(envelope) }), wrap(linked)],
    [
      wrap({
        version: 2,
        origin: projection.origin,
        settlementId: projection.settlementId,
        phase: "attempted",
        dispatchId: uuid,
        controlEnvelopeDigest: hash,
        controlExecutionDigest: hash,
        commitmentDigest: hash,
        attemptedAt: at,
      }),
    ],
    [{ version: 2, terminal: wrap(publishedTerminal), ack: wrap(ack) }],
    [wrap(ack)],
    [
      {
        version: 2,
        capacity: wrap(capacity),
        refusal: wrap(dmRefusal),
        unused: unused("data-manager"),
      },
    ],
    [
      wrap({
        version: 2,
        purpose: "configuration-fence-settlement",
        installationId: projection.installationId,
        origin: projection.origin,
        settlementId: projection.settlementId,
        projectionDigest: hash,
        reservationDigest: hash,
        prepareExecutionDigest: hash,
        prepareAdmissionDigest: hash,
        preparedReceiptDigest: hash,
        capacityReceiptDigest: hash,
        rootCertificateDigest: projection.rootCertificateDigest,
        controlEnvelope: wrap(envelope),
        commitmentDigest: hash,
        executionOrdinal: 127,
        intentOrdinal: 255,
        sqlSessionNonce: uuid,
        boundAt: at,
      }),
    ],
    [wrap(effect), wrap(contained)],
    [wrap(publishedTerminal)],
    [wrap(publishedTerminal)],
    [wrap(ack)],
  ];
  const result: Record<string, number> = {};
  for (const [index, descriptor] of all.entries()) {
    const maximum = Math.max(...variants[index]!.map(width));
    if (maximum > descriptor.cap)
      throw Error(
        `Prospective settlement packet exceeds ${descriptor.role}/${descriptor.scope}/${descriptor.name}`,
      );
    result[`${descriptor.role}/${descriptor.scope}/${descriptor.name}`] = maximum;
  }
  if (all.reduce((sum, descriptor) => sum + descriptor.cap, 0) > 65536)
    throw Error("Whole padded settlement packet exceeds 65536 bytes");
  return Object.freeze(result);
}
