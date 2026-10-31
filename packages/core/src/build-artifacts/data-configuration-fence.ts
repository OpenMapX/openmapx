import { metadataSchema, mirrorSchema } from "./data-configuration-fence-records";

export { metadataSchema, mirrorSchema } from "./data-configuration-fence-records";

/** Fixed service-only configuration/feed guard; signatures are verified against
 * the anchored original agent grant, never against the shared bearer alone. */
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import {
  executionFingerprint,
  executionRefSchema,
  type VerifiedParentExecution,
} from "../ops/execution-identity";
import {
  type DataConfigurationFencePrepare,
  type DataConfigurationFenceReceipt,
  type DataConfigurationFenceSettle,
  dataConfigurationFencePrepareSchema,
  dataConfigurationFenceReceiptSchema,
  dataConfigurationFenceSettleSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { startGenerationHardlinksExecutionSchema } from "../services/data-manager/contracts/executions";
import {
  publishedConfigurationSettlementReservationState,
  type RefusedConfigurationSettlementCapacity,
  refusedConfigurationSettlementCapacityState,
  reserveReceivedConfigurationSettlementCapacity,
  verifyPublishedConfigurationSettlementReservation,
} from "./configuration-fence-settlement";
import {
  configurationSettlementRecordDescriptors,
  readConfigurationSettlementCell,
  writeConfigurationSettlementCell,
} from "./configuration-fence-settlement-cells";
import {
  configurationCommittedSettlementSchema,
  configurationDmCapacityCellSchema,
  configurationDmNoGuardRefusalSchema,
  configurationSettlementAckSchema,
  configurationSettlementAdmissionSchema,
  configurationSettlementAssertionSchema,
  configurationSettlementCapacitySchema,
  configurationSettlementContainedObservationSchema,
  configurationSettlementControlCellSchema,
  configurationSettlementControlEnvelopeSchema,
  configurationSettlementDomains,
  configurationSettlementEffectSchema,
  configurationSettlementPublishedTerminalSchema,
  configurationSettlementReservationProjectionSchema,
  configurationSettlementSqlControlSchema,
  configurationSettlementSqlSessionSchema,
  configurationSettlementTerminalTupleSchema,
  configurationUnusedCapacityConfirmationSchema,
  configurationUnusedCapacityIntentSchema,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import { readPreparedConfigurationSettlementRetirement } from "./configuration-fence-settlement-retention";
import {
  beginControlEffect,
  type ControlInstallation,
  controlDigest,
  controlHeaders,
  executionAuthorityState,
  installationState,
  readControlExecutionWitness,
  readPrivateRecord,
  requireControlJournalRetention,
  restoreAdmittedControlExecution,
  retainAdmittedControlExecution,
  retainedControlAdoptionAssertion,
  retainedControlParent,
  settleExecutionLifecycle,
  verifyConfigurationMaintenanceGenerationWitness,
  verifyControlEffectSettlement,
  verifyControlPeer,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
import { signControl, verifyControl } from "./control-records";
import {
  dataConfigurationFencePreparedWitnessDomain,
  dataConfigurationFencePreparedWitnessSchema,
} from "./data-configuration-fence-witness-records";
import { retainedDataDatabaseTimestamp } from "./data-database-time";
import { AnchoredDirectory, sameInode } from "./filesystem";
import { verifiedParentForArtifactDelegation } from "./peer-admission";
import {
  bindOwnedConfigurationSettlementFamilySlot,
  commitRefusedDataConfigurationSettlementSlotUnused,
  completeFamilyJournal,
  familyRecordWrite,
  markFamilyTerminal,
  publishFamilyCanonicalTerminal,
  readConfigurationSettlementFamilySlot,
  readRefusedConfigurationSettlementCapacitySnapshot,
  verifyFamilyOwnedRecord,
} from "./retention-family";
import {
  adoptArtifactTargetLease,
  assertArtifactTargetLeaseForward,
  bindBorrowedControlExecution,
  closeArtifactTargetLeaseHandle,
  inspectArtifactDelegation,
  retainedConfigurationFenceAdoption,
  settleArtifactTargetLeaseChild,
  verifyConfigurationFenceSettlementHeldOwner,
  verifyRetainedArtifactTargetSettlement,
} from "./target-lease";
export interface DataFenceSql {
  unsafe(
    query: string,
    parameters?: (string | number | null)[],
  ): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(run: (tx: Pick<DataFenceSql, "unsafe">) => Promise<T>): Promise<T>;
  reserveSettlementSession?(sessionNonce: string): Promise<DataFenceReservedSession>;
}
export interface DataFenceReservedSession {
  unsafe: DataFenceSql["unsafe"];
  identity: { pid: number; backendStart: string; sessionNonce: string };
  /** Called ONLY after actual COMMIT or explicit awaited ROLLBACK. An unknown
   * session stays reserved and cannot execute another logical transition. */
  releaseConclusive(): void;
}
const fenceTerminalSchema = z.strictObject({
  version: z.literal(1),
  phase: z.enum(["prepared", "canonical"]),
  execution: executionRefSchema,
  admissionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  terminalDigest: z.string().regex(/^[a-f0-9]{64}$/),
  terminalAt: z.number().int().positive().safe(),
});
const inspectWitnessSchema = z.strictObject({
  installationId: z.uuid(),
  maintenanceId: z.uuid(),
  candidateId: z.uuid(),
  ownerCertificateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int().nonnegative().safe(),
});
export class DataFenceBusy extends Error {
  readonly statusCode = 409;
  constructor() {
    super("configuration_maintenance_busy");
  }
}
class DataFenceCapacityRefused extends DataFenceBusy {
  constructor(readonly proof: RefusedConfigurationSettlementCapacity) {
    super();
  }
}
declare const preparedGenerationBrand: unique symbol;
export type VerifiedPreparedGenerationAdmission = Readonly<{ [preparedGenerationBrand]: true }>;
const preparedGenerations = new WeakMap<
  VerifiedPreparedGenerationAdmission,
  {
    installation: ControlInstallation;
    request: ReturnType<typeof startGenerationHardlinksExecutionSchema.parse>;
    headers: readonly string[];
    parent: VerifiedParentExecution;
    guardDigest: string;
    execution: ReturnType<typeof inspectArtifactDelegation>["execution"];
  }
>();
declare const settlementPeerBrand: unique symbol;
export type VerifiedFenceSettlementPeer = Readonly<{ [settlementPeerBrand]: true }>;
export function createDataConfigurationFenceStore(
  installation: ControlInstallation,
  sql: DataFenceSql,
) {
  const local = installationState(installation);
  if (installation.role !== "data-manager" || local.fixedChildId)
    throw Error("Fixed DM fence receiver required");
  let startup = "closed" as "closed" | "open" | "fenced";
  const mirrors = new Map<string, z.infer<typeof mirrorSchema>>();
  type SettlementSource = {
    input: DataConfigurationFenceSettle;
    saved: z.infer<typeof metadataSchema>;
    owned: z.infer<typeof mirrorSchema>;
    projection: z.infer<typeof configurationSettlementReservationProjectionSchema>;
    envelope: z.infer<typeof configurationSettlementControlEnvelopeSchema>;
    signedEnvelope: ReturnType<
      typeof signControl<z.infer<typeof configurationSettlementControlEnvelopeSchema>>
    >;
    commitment: z.infer<typeof configurationCommittedSettlementSchema>;
    commitmentDigest: string;
    capacityDigest: string;
    prepareExecution: z.infer<typeof executionRefSchema>;
    prepareAdmissionDigest: string;
    preparedReceiptDigest: string;
  };
  const settlementPeers = new WeakMap<VerifiedFenceSettlementPeer, SettlementSource>();
  const receiverEffectTickets = new WeakMap<object, DataFenceReservedSession>();
  function shared(role: "ops-agent" | "data-manager", name: string, max: number): unknown {
    const opened: AnchoredDirectory[] = [],
      own = (directory: AnchoredDirectory) => {
        opened.push(directory);
        return directory;
      };
    try {
      const root = own(new AnchoredDirectory(local.dataRoot)),
        control = own(root.directory(".admin-target-control")),
        executions = own(control.directory("executions")),
        directory = own(executions.directory(role));
      const bytes = directory.read(name, max);
      if (bytes.length !== max) throw new DataFenceBusy();
      return JSON.parse(bytes.toString("utf8"));
    } finally {
      for (const directory of opened.reverse()) directory.close();
    }
  }
  async function verifyConfigurationFenceSettlementControl(
    input: DataConfigurationFenceSettle,
    rawHeaders: readonly string[],
  ): Promise<VerifiedFenceSettlementPeer> {
    const headers = controlHeaders(rawHeaders);
    if (!headers.delegation || headers.parent)
      throw Object.assign(Error("Fixed settlement assertion required"), { statusCode: 403 });
    const assertion = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.assertion,
        JSON.parse(Buffer.from(headers.delegation, "base64url").toString("utf8")),
        configurationSettlementAssertionSchema,
      ),
      source = await loadConfigurationFenceSettlementSource(input);
    if (
      assertion.settlementId !== input.settlementId ||
      assertion.controlEnvelopeDigest !==
        settlementRecordDigest(configurationSettlementDomains.binding, source.envelope)
    )
      throw Object.assign(Error("Fixed settlement assertion binding conflict"), {
        statusCode: 403,
      });
    const peer = Object.freeze({}) as VerifiedFenceSettlementPeer;
    settlementPeers.set(peer, source);
    return peer;
  }
  /** Common exact source loader. It reads original guard SQL/mirror/private
   * preparation plus shared role-signed projection/final/binding; no sibling
   * private directory, public status or caller outcome supplies authority. */
  async function loadConfigurationFenceSettlementSource(
    input: DataConfigurationFenceSettle,
    readSql: Pick<DataFenceSql, "unsafe"> = sql,
  ): Promise<SettlementSource> {
    const saved = await row(readSql, input.maintenanceId);
    if (!saved || !saved.settlementReservation) throw new DataFenceBusy();
    const mirrorSource = signedMirrorData(input.maintenanceId),
      owned = mirrorSource.parsed,
      owner = saved.receipt.ownerPrepare,
      preparedGrant = inspectArtifactDelegation({
        installation,
        dataRoot: local.dataRoot,
        assertion: owned.prepareAssertion,
      }),
      prepareAuthority = restoreAdmittedControlExecution(installation, preparedGrant.execution),
      prepare = executionAuthorityState(prepareAuthority),
      canonicalRaw = readPrivateRecord(
        local,
        "observations",
        `terminal-${preparedGrant.execution.operationKey}.json`,
        8192,
      ),
      effectRaw = readPrivateRecord(
        local,
        "effects",
        `${preparedGrant.execution.operationKey}.json`,
        65536,
      ),
      canonical = verifyControl(
        installation.publicKey,
        "openmapx-data-fence-terminal-v1",
        canonicalRaw,
        fenceTerminalSchema,
      ),
      effect = verifyControl(
        installation.publicKey,
        "openmapx-control-settlement-v1",
        effectRaw,
        z
          .object({
            identity: executionRefSchema,
            outcome: z.literal("committed"),
            publication: z.literal("committed"),
            terminalReceiptDigest: z.string(),
            receipt: z.strictObject({
              kind: z.literal("data-configuration-fence"),
              receipt: dataConfigurationFenceReceiptSchema,
              guardDigest: z.string(),
            }),
          })
          .passthrough(),
      ),
      originalMetadata = metadataSchema.parse({
        version: 1,
        guardState: "prepared",
        receipt: effect.receipt.receipt,
        input: saved.input,
        settlementReservation: saved.settlementReservation,
      }),
      originalMirror = { ...owned, metadata: originalMetadata };
    if (!prepare.origin) throw new DataFenceBusy();
    verifyFamilyOwnedRecord(
      local,
      prepare.origin,
      {
        scope: "private",
        namespace: "observations",
        container: "",
        name: `terminal-${preparedGrant.execution.operationKey}.json`,
      },
      canonicalJson(canonicalRaw),
    );
    verifyFamilyOwnedRecord(
      local,
      prepare.origin,
      {
        scope: "private",
        namespace: "effects",
        container: "",
        name: `${preparedGrant.execution.operationKey}.json`,
      },
      canonicalJson(effectRaw),
    );
    if (
      prepare.kind !== "configuration-maintenance.prepare" ||
      preparedGrant.kind !== "configuration-maintenance.prepare" ||
      preparedGrant.phase !== "configuration-fence" ||
      preparedGrant.recipient !== "data-manager" ||
      preparedGrant.ownerCertificateDigest !== owned.ownerCertificateDigest ||
      canonicalJson(preparedGrant.owner) !== canonicalJson(owner) ||
      canonicalJson(preparedGrant.parent) !== canonicalJson(owner) ||
      canonicalJson(preparedGrant.execution) !== canonicalJson(effect.identity) ||
      preparedGrant.execution.executionId !== saved.receipt.fenceId ||
      canonical.phase !== "canonical" ||
      canonicalJson(canonical.execution) !== canonicalJson(preparedGrant.execution) ||
      canonical.admissionDigest !== prepare.receiptDigest ||
      canonical.terminalDigest !== dataFenceTerminalDigest(effect.receipt.receipt) ||
      canonical.terminalAt !== owned.preparedAt ||
      effect.terminalReceiptDigest !== controlDigest(effect.receipt) ||
      effect.receipt.guardDigest !== controlDigest(originalMirror) ||
      effect.receipt.receipt.state !== "prepared" ||
      effect.receipt.receipt.sequence !== 0 ||
      canonicalJson(saved.receipt) !== canonicalJson(effect.receipt.receipt) ||
      input.candidateId !== saved.input.candidateId ||
      input.planDigest !== saved.input.planDigest ||
      input.settlementId !== saved.settlementReservation.settlementId
    )
      throw new DataFenceBusy();
    const rootWitness = readControlExecutionWitness(local, owner, local.publicKeys["ops-agent"]),
      control = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.control,
        shared("ops-agent", `${owner.operationKey}.configuration-settlement-control.json`, 8192),
        configurationSettlementControlCellSchema.shape.payload,
      );
    if ("unused" in control || !control.binding) throw new DataFenceBusy();
    const projection = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.signedProjection,
        control.projection,
        configurationSettlementReservationProjectionSchema,
      ),
      envelope = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.control,
        control.binding,
        configurationSettlementControlEnvelopeSchema,
      ),
      commitment = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.reference,
        shared("ops-agent", `${owner.operationKey}.configuration-settlement.json`, 16384),
        configurationCommittedSettlementSchema,
      ),
      commitmentDigest = settlementRecordDigest(
        configurationSettlementDomains.commitment,
        commitment,
      ),
      identity = commitment.identity,
      preparedReceiptDigest = settlementRecordDigest(
        configurationSettlementDomains.preparedReceipt,
        effect.receipt.receipt,
      ),
      envelopeDigest = settlementRecordDigest(configurationSettlementDomains.binding, envelope),
      {
        operationFingerprint: _operationFingerprint,
        fingerprint: _fingerprint,
        deadlineAt: _deadlineAt,
        ...address
      } = envelope.execution,
      descriptors = configurationSettlementRecordDescriptors(
        projection,
        preparedGrant.execution.operationKey,
      ).receiver,
      capacityCell = configurationDmCapacityCellSchema.parse(
        readConfigurationSettlementCell(local, projection, descriptors[0]!),
      );
    if (!capacityCell.capacity || capacityCell.refusal || capacityCell.unused)
      throw new DataFenceBusy();
    const capacity = verifyControl(
        installation.publicKey,
        configurationSettlementDomains.capacity,
        capacityCell.capacity,
        configurationSettlementCapacitySchema,
      ),
      capacityDigest = settlementRecordDigest(configurationSettlementDomains.capacity, capacity);
    if (
      projection.installationId !== installation.installationId ||
      canonicalJson(projection.origin) !== canonicalJson(owned.origin) ||
      canonicalJson(rootWitness.origin) !== canonicalJson(owned.origin) ||
      rootWitness.authorityDigest !== projection.rootAdmissionDigest ||
      canonicalJson(rootWitness.serviceIds) !== canonicalJson(saved.input.serviceIds) ||
      canonicalJson(projection.ownerPrepare) !== canonicalJson(owner) ||
      projection.rootCertificateDigest !== owned.ownerCertificateDigest ||
      projection.maintenanceId !== input.maintenanceId ||
      projection.candidateId !== input.candidateId ||
      projection.planDigest !== input.planDigest ||
      projection.settlementId !== input.settlementId ||
      canonicalJson(projection.operation) !==
        canonicalJson({ kind: "configuration-maintenance.settle", ...input }) ||
      projection.reservation.operationFingerprint !== controlDigest(projection.operation) ||
      settlementRecordDigest(configurationSettlementDomains.projection, projection) !==
        saved.settlementReservation.projectionDigest ||
      projection.reservationDigest !== saved.settlementReservation.reservationDigest ||
      capacityDigest !== saved.settlementReservation.capacityReceiptDigest ||
      capacity.projectionDigest !== saved.settlementReservation.projectionDigest ||
      capacity.reservationDigest !== projection.reservationDigest ||
      capacity.settlementId !== input.settlementId ||
      canonicalJson(capacity.proposedExecutionAddress) !== canonicalJson(address) ||
      canonicalJson(projection.reservation.execution) !== canonicalJson(address) ||
      envelope.projectionDigest !== capacity.projectionDigest ||
      envelope.reservationDigest !== projection.reservationDigest ||
      envelope.installationId !== installation.installationId ||
      canonicalJson(envelope.origin) !== canonicalJson(owned.origin) ||
      canonicalJson(envelope.ownerPrepare) !== canonicalJson(owner) ||
      envelope.admissionDigest !== rootWitness.authorityDigest ||
      envelope.rootCertificateDigest !== owned.ownerCertificateDigest ||
      envelope.settlementId !== input.settlementId ||
      envelope.commitmentDigest !== commitmentDigest ||
      canonicalJson(envelope.operation) !== canonicalJson(projection.operation) ||
      canonicalJson(envelope.serviceIds) !== canonicalJson(saved.input.serviceIds) ||
      envelope.execution.operationFingerprint !== projection.reservation.operationFingerprint ||
      envelope.execution.fingerprint !==
        executionFingerprint({
          kind: "configuration-maintenance.settle",
          operationFingerprint: envelope.execution.operationFingerprint,
          deadlineAt: envelope.controlDeadlineAt,
          parent: retainedControlParent(owner),
        }) ||
      identity.installationId !== installation.installationId ||
      canonicalJson(identity.origin) !== canonicalJson(owned.origin) ||
      canonicalJson(identity.ownerPrepare) !== canonicalJson(owner) ||
      identity.admissionDigest !== projection.rootAdmissionDigest ||
      identity.rootCertificateDigest !== owned.ownerCertificateDigest ||
      identity.maintenanceId !== input.maintenanceId ||
      identity.candidateId !== input.candidateId ||
      identity.planDigest !== input.planDigest ||
      identity.settlementId !== input.settlementId ||
      canonicalJson(commitment.final.identity) !== canonicalJson(identity) ||
      canonicalJson(commitment.evidence.identity) !== canonicalJson(identity) ||
      commitment.referenceOperationFingerprint !== projection.reservation.operationFingerprint ||
      commitment.ownerReceiptDigest !==
        settlementRecordDigest(configurationSettlementDomains.ownerFinal, commitment.final) ||
      commitment.evidenceDigest !==
        settlementRecordDigest(configurationSettlementDomains.finalEvidence, commitment.evidence) ||
      commitment.final.evidenceDigest !== commitment.evidenceDigest ||
      commitment.final.outcome !== commitment.evidence.outcome ||
      commitment.final.expectedDmSequence !== saved.receipt.sequence ||
      commitment.committedAt !== commitment.final.settlingAt ||
      canonicalJson(commitment.evidence.guard.preparedReceipt) !==
        canonicalJson(effect.receipt.receipt) ||
      commitment.evidence.guard.fenceId !== saved.receipt.fenceId ||
      commitment.evidence.guard.preparedReceiptDigest !== preparedReceiptDigest ||
      commitment.evidence.guard.preparedCanonicalDigest !== canonical.terminalDigest ||
      commitment.evidence.guard.preparedTerminalAt !== canonical.terminalAt ||
      envelopeDigest.length !== 64
    )
      throw new DataFenceBusy();
    const source = {
      input,
      saved,
      owned,
      projection,
      envelope,
      signedEnvelope: control.binding,
      commitment,
      commitmentDigest,
      capacityDigest,
      prepareExecution: preparedGrant.execution,
      prepareAdmissionDigest: prepare.receiptDigest,
      preparedReceiptDigest,
    };
    if (saved.guardState === "settled" && saved.settlementControl) {
      const originalAdmission = retainedSettlementAdmission(source);
      if (!originalAdmission) throw new DataFenceBusy();
      assertSettlementSqlTuple(source, saved, originalAdmission);
    } else
      verifyFamilyOwnedRecord(
        local,
        owned.origin,
        {
          scope: "private",
          namespace: "configuration-maintenance",
          container: "",
          name: `${input.maintenanceId}.json`,
        },
        canonicalJson(mirrorSource.raw),
      );
    return source;
  }
  function retainedSettlementAdmission(source: SettlementSource) {
    const descriptors = configurationSettlementRecordDescriptors(
        source.projection,
        source.prepareExecution.operationKey,
      ).receiver,
      raw = readConfigurationSettlementCell(local, source.projection, descriptors[1]!);
    if (raw === null) return null;
    const value = verifyControl(
        installation.publicKey,
        configurationSettlementDomains.admission,
        raw,
        configurationSettlementAdmissionSchema,
      ),
      slot = bindOwnedConfigurationSettlementFamilySlot(local, source.projection);
    if (
      value.installationId !== installation.installationId ||
      canonicalJson(value.origin) !== canonicalJson(source.owned.origin) ||
      value.settlementId !== source.input.settlementId ||
      value.projectionDigest !== source.envelope.projectionDigest ||
      value.reservationDigest !== source.envelope.reservationDigest ||
      value.prepareExecutionDigest !== controlDigest(source.prepareExecution) ||
      value.prepareAdmissionDigest !== source.prepareAdmissionDigest ||
      value.preparedReceiptDigest !== source.preparedReceiptDigest ||
      value.capacityReceiptDigest !== source.capacityDigest ||
      value.rootCertificateDigest !== source.owned.ownerCertificateDigest ||
      canonicalJson(value.controlEnvelope) !== canonicalJson(source.signedEnvelope) ||
      value.commitmentDigest !== source.commitmentDigest ||
      value.executionOrdinal !== slot.executionOrdinal ||
      value.intentOrdinal !== slot.intentOrdinal ||
      value.sqlSessionNonce !== source.projection.reservation.execution.executionId ||
      value.boundAt < source.envelope.controlStartedAt ||
      value.boundAt >= source.envelope.controlDeadlineAt
    )
      throw new DataFenceBusy();
    return {
      value,
      signature: (raw as { signature: string }).signature,
      digest: settlementRecordDigest(configurationSettlementDomains.admission, value),
      descriptors,
    };
  }
  function assertSettlementSqlTuple(
    source: SettlementSource,
    saved: z.infer<typeof metadataSchema>,
    admission: NonNullable<ReturnType<typeof retainedSettlementAdmission>>,
  ) {
    const control = saved.settlementControl;
    if (
      !control ||
      saved.guardState !== "settled" ||
      canonicalJson(saved.settlement) !== canonicalJson(source.input)
    )
      throw new DataFenceBusy();
    const tuple = control.tuple,
      { terminalDigest, ...preimage } = tuple;
    if (
      control.settlementId !== source.input.settlementId ||
      control.controlEnvelopeDigest !==
        settlementRecordDigest(configurationSettlementDomains.binding, source.envelope) ||
      control.commitmentDigest !== source.commitmentDigest ||
      control.admissionDigest !== admission.digest ||
      control.outcome !== source.commitment.final.outcome ||
      control.expectedDmSequence !== source.saved.receipt.sequence ||
      control.preparedReceiptDigest !== source.preparedReceiptDigest ||
      control.sqlSession.sessionNonce !== admission.value.sqlSessionNonce ||
      canonicalJson(tuple.execution) !== canonicalJson(source.envelope.execution) ||
      tuple.settlementId !== source.input.settlementId ||
      tuple.commitmentDigest !== source.commitmentDigest ||
      tuple.fenceId !== source.saved.receipt.fenceId ||
      tuple.terminalAt < source.envelope.controlStartedAt ||
      tuple.terminalAt >= source.envelope.controlDeadlineAt ||
      terminalDigest !==
        settlementRecordDigest(configurationSettlementDomains.terminal, preimage) ||
      canonicalJson(tuple.result) !==
        canonicalJson({
          ...source.saved.receipt,
          state: "settled",
          sequence: source.saved.receipt.sequence + 1,
        })
    )
      throw new DataFenceBusy();
    return control;
  }
  /** Publication only, from the exact atomic SQL tuple and verified original
   * admission. No logical UPDATE, effect start, new time or generic adoption. */
  function publishCommittedSettlement(
    source: SettlementSource,
    saved: z.infer<typeof metadataSchema>,
    admission: NonNullable<ReturnType<typeof retainedSettlementAdmission>>,
  ) {
    const control = assertSettlementSqlTuple(source, saved, admission),
      tuple = control.tuple,
      descriptors = admission.descriptors,
      priorMirror = signedMirrorData(source.input.maintenanceId).parsed;
    if (
      priorMirror.metadata.settlementControl &&
      canonicalJson(priorMirror.metadata.settlementControl) !== canonicalJson(control)
    )
      throw new DataFenceBusy();
    write({ ...priorMirror, metadata: saved });
    const committed = configurationSettlementEffectSchema.parse({
        version: 2,
        origin: source.owned.origin,
        settlementId: source.input.settlementId,
        controlExecutionDigest: controlDigest(source.envelope.execution),
        controlEnvelopeDigest: control.controlEnvelopeDigest,
        admissionDigest: admission.digest,
        commitmentDigest: source.commitmentDigest,
        preparedReceiptDigest: source.preparedReceiptDigest,
        expectedDmSequence: source.saved.receipt.sequence,
        attemptedAt: control.attemptedAt,
        sqlSession: control.sqlSession,
        phase: "committed",
        terminal: tuple,
        observation: null,
      }),
      oldEffect = readConfigurationSettlementCell(local, source.projection, descriptors[2]!);
    if (oldEffect !== null) {
      const old = verifyControl(
          installation.publicKey,
          configurationSettlementDomains.effect,
          oldEffect,
          configurationSettlementEffectSchema,
        ),
        {
          phase: _oldPhase,
          terminal: _oldTerminal,
          observation: _oldObservation,
          ...oldIdentity
        } = old,
        { phase: _phase, terminal: _terminal, observation: _observation, ...identity } = committed;
      if (
        canonicalJson(oldIdentity) !== canonicalJson(identity) ||
        old.phase === "contained_not_settled" ||
        (old.phase === "committed" && canonicalJson(old) !== canonicalJson(committed))
      )
        throw new DataFenceBusy();
    }
    const signedEffect = signControl(
      local.privateKey,
      configurationSettlementDomains.effect,
      committed,
    );
    writeConfigurationSettlementCell(local, source.projection, descriptors[2]!, signedEffect);
    const { terminal: _effectTerminal, ...effectFields } = committed;
    const terminal = signControl(
      local.privateKey,
      configurationSettlementDomains.terminal,
      configurationSettlementPublishedTerminalSchema.parse({
        version: 2,
        origin: source.owned.origin,
        admissionDigest: admission.digest,
        tuple,
        effectSettlementDigest: settlementRecordDigest(
          configurationSettlementDomains.effect,
          committed,
        ),
        effectSource: { fields: effectFields, signature: signedEffect.signature },
        admissionSource: { boundAt: admission.value.boundAt, signature: admission.signature },
      }),
    );
    for (const descriptor of [descriptors[3]!, descriptors[4]!]) {
      const old = readConfigurationSettlementCell(local, source.projection, descriptor);
      if (old === null)
        writeConfigurationSettlementCell(local, source.projection, descriptor, terminal);
      else if (canonicalJson(old) !== canonicalJson(terminal)) throw new DataFenceBusy();
    }
    const rawAck = shared(
      "ops-agent",
      `${source.saved.receipt.ownerPrepare.operationKey}.configuration-settlement-ack.json`,
      1024,
    );
    if (rawAck !== null) {
      const ack = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.ack,
        rawAck,
        configurationSettlementAckSchema,
      );
      if (
        ack.installationId !== installation.installationId ||
        canonicalJson(ack.origin) !== canonicalJson(source.owned.origin) ||
        ack.settlementId !== source.input.settlementId ||
        ack.controlExecutionDigest !== controlDigest(source.envelope.execution) ||
        ack.terminalDigest !== tuple.terminalDigest ||
        ack.terminalAt !== tuple.terminalAt ||
        ack.commitmentDigest !== source.commitmentDigest
      )
        throw new DataFenceBusy();
      const copied = readConfigurationSettlementCell(local, source.projection, descriptors[5]!);
      if (copied === null)
        writeConfigurationSettlementCell(local, source.projection, descriptors[5]!, rawAck);
      else if (canonicalJson(copied) !== canonicalJson(rawAck)) throw new DataFenceBusy();
    }
    startup = "open";
    return tuple.result;
  }
  async function recoverCommittedConfigurationFenceSettlement(input: DataConfigurationFenceSettle) {
    return sql.transaction(async (tx) => {
      await lock(tx);
      const source = await loadConfigurationFenceSettlementSource(input, tx),
        admission = retainedSettlementAdmission(source),
        saved = await row(tx, input.maintenanceId, true);
      if (!admission || !saved?.settlementControl || saved.guardState !== "settled")
        throw new DataFenceBusy();
      return publishCommittedSettlement(source, saved, admission);
    });
  }
  /** Observation-only recovery of the ONE exhausted control. A prepared SQL
   * row is insufficient: the original admission/effect, same nonblocking SQL
   * guard/row lock and exact original session identity must agree. This never
   * constructs an effect ticket, terminal tuple, ACK or guard UPDATE. */
  async function observeUnsettledConfigurationFenceSettlement(
    maintenanceId: string,
  ): Promise<DataConfigurationFenceReceipt | null> {
    return sql.transaction(async (tx) => {
      await lock(tx);
      const saved = await row(tx, maintenanceId, true);
      if (
        !saved ||
        saved.guardState !== "prepared" ||
        !saved.settlementReservation ||
        saved.settlement ||
        saved.settlementControl
      )
        return null;
      const control = verifyControl(
        local.publicKeys["ops-agent"],
        configurationSettlementDomains.control,
        shared(
          "ops-agent",
          `${saved.receipt.ownerPrepare.operationKey}.configuration-settlement-control.json`,
          8192,
        ),
        configurationSettlementControlCellSchema.shape.payload,
      );
      if ("unused" in control || !control.binding) return null;
      const input = dataConfigurationFenceSettleSchema.parse({
          version: 2,
          maintenanceId,
          candidateId: saved.receipt.candidateId,
          planDigest: saved.receipt.planDigest,
          settlementId: saved.settlementReservation.settlementId,
        }),
        source = await loadConfigurationFenceSettlementSource(input, tx),
        admission = retainedSettlementAdmission(source);
      if (!admission) return null;
      const projection = { ...saved.receipt, state: "recovery_required" as const },
        raw = readConfigurationSettlementCell(local, source.projection, admission.descriptors[2]!);
      // Bound but unattempted adoption cannot regain the lost process ticket.
      if (raw === null) return projection;
      const effect = verifyControl(
        installation.publicKey,
        configurationSettlementDomains.effect,
        raw,
        configurationSettlementEffectSchema,
      );
      if (
        canonicalJson(effect.origin) !== canonicalJson(source.owned.origin) ||
        effect.settlementId !== input.settlementId ||
        effect.controlExecutionDigest !== controlDigest(source.envelope.execution) ||
        effect.controlEnvelopeDigest !==
          settlementRecordDigest(configurationSettlementDomains.binding, source.envelope) ||
        effect.admissionDigest !== admission.digest ||
        effect.commitmentDigest !== source.commitmentDigest ||
        effect.preparedReceiptDigest !== source.preparedReceiptDigest ||
        effect.expectedDmSequence !== saved.receipt.sequence ||
        effect.sqlSession.sessionNonce !== admission.value.sqlSessionNonce ||
        effect.attemptedAt < admission.value.boundAt ||
        effect.attemptedAt >= source.envelope.controlDeadlineAt ||
        effect.terminal ||
        effect.phase === "committed"
      )
        throw new DataFenceBusy();
      const observationFields = {
        version: 2 as const,
        state: "contained_not_settled" as const,
        settlementId: effect.settlementId,
        controlExecutionDigest: effect.controlExecutionDigest,
        controlEnvelopeDigest: effect.controlEnvelopeDigest,
        commitmentDigest: effect.commitmentDigest,
        preparedReceiptDigest: effect.preparedReceiptDigest,
        expectedDmSequence: effect.expectedDmSequence,
        attemptedAt: effect.attemptedAt,
        sqlSession: effect.sqlSession,
      };
      if (effect.phase === "contained_not_settled") {
        const observed = configurationSettlementContainedObservationSchema.parse(
            effect.observation,
          ),
          { observationAt, containment: _containment, ...fields } = observed;
        if (
          canonicalJson(fields) !== canonicalJson(observationFields) ||
          observationAt < effect.attemptedAt
        )
          throw new DataFenceBusy();
        if (canonicalJson(source.owned.metadata) !== canonicalJson(saved))
          throw new DataFenceBusy();
        return projection;
      }
      const sessions = await tx.unsafe(
        "SELECT pid,backend_start::text AS backend_start,application_name FROM pg_stat_activity WHERE pid=$1::int",
        [effect.sqlSession.pid],
      );
      if (sessions.length > 1) throw new DataFenceBusy();
      const original = sessions[0];
      if (original) {
        if (
          typeof original.backend_start !== "string" ||
          typeof original.application_name !== "string"
        )
          throw new DataFenceBusy();
        // A renamed application_name cannot prove a live backend absent. Only
        // no PID or a conclusively different backend_start excludes the exact
        // original session; a changed/unverifiable nonce stays fenced too.
        if (original.backend_start === effect.sqlSession.backendStart) throw new DataFenceBusy();
      }
      // The row lock waited out the old transaction; that exact backend/nonce
      // cannot later commit. Restore only the unchanged original prepared row.
      const observation = configurationSettlementContainedObservationSchema.parse({
        ...observationFields,
        observationAt: Date.now(),
        containment: "original_session_absent",
      });
      if (observation.observationAt < effect.attemptedAt) throw new DataFenceBusy();
      verifyConfigurationFenceSettlementHeldOwner(installation, source.owned.prepareAssertion, {
        ownerPrepare: saved.receipt.ownerPrepare,
        ownerCertificateDigest: source.owned.ownerCertificateDigest,
        serviceIds: saved.input.serviceIds,
      });
      write({ ...source.owned, metadata: saved });
      writeConfigurationSettlementCell(
        local,
        source.projection,
        admission.descriptors[2]!,
        signControl(
          local.privateKey,
          configurationSettlementDomains.effect,
          configurationSettlementEffectSchema.parse({
            ...effect,
            phase: "contained_not_settled",
            observation,
          }),
        ),
      );
      return projection;
    });
  }
  /** SQL's original reserved session holds the non-stealable role writer via
   * the EXISTING admission advisory key. Before BEGIN it owns the session lock;
   * after BEGIN it transfers to the SAME connection's transaction lock. Thus a
   * crash releases kernel/DB ownership without stealing a filesystem marker,
   * and an uncertain COMMIT cannot strand an extra session lock. */
  async function adoptConfigurationFenceSettlementControl(peer: VerifiedFenceSettlementPeer) {
    const source = settlementPeers.get(peer);
    if (!source) throw new DataFenceBusy();
    if (retainedSettlementAdmission(source))
      return {
        inspect: () => recoverCommittedConfigurationFenceSettlement(source.input),
        repairCommittedPublication: () =>
          recoverCommittedConfigurationFenceSettlement(source.input),
        close: async () => {},
      };
    if (!sql.reserveSettlementSession) throw new DataFenceBusy();
    const session = await sql.reserveSettlementSession(
      source.projection.reservation.execution.executionId,
    );
    let sessionHeld = false,
      commitAttempted = false,
      handedOff = false;
    const release = async () => {
      if (sessionHeld) {
        await session.unsafe("SELECT pg_advisory_unlock($1::int,$2::int)", [0x4f4d58, 2]);
        sessionHeld = false;
      }
      session.releaseConclusive();
    };
    try {
      const held = await session.unsafe(
        "SELECT pg_try_advisory_lock($1::int,$2::int) AS held",
        [0x4f4d58, 2],
      );
      if (held[0]?.held !== true) {
        session.releaseConclusive();
        throw new DataFenceBusy();
      }
      sessionHeld = true;
      const current = await loadConfigurationFenceSettlementSource(source.input, session);
      if (retainedSettlementAdmission(current)) {
        await release();
        return {
          inspect: () => recoverCommittedConfigurationFenceSettlement(source.input),
          repairCommittedPublication: () =>
            recoverCommittedConfigurationFenceSettlement(source.input),
          close: async () => {},
        };
      }
      verifyConfigurationFenceSettlementHeldOwner(installation, current.owned.prepareAssertion, {
        ownerPrepare: current.saved.receipt.ownerPrepare,
        ownerCertificateDigest: current.owned.ownerCertificateDigest,
        serviceIds: current.saved.input.serviceIds,
      });
      const slot = readConfigurationSettlementFamilySlot(local, current.projection),
        boundAt = Date.now(),
        descriptors = configurationSettlementRecordDescriptors(
          current.projection,
          current.prepareExecution.operationKey,
        ).receiver;
      if (
        slot.state !== "reserved" ||
        slot.executionOrdinal === null ||
        slot.intentOrdinal === null ||
        current.saved.guardState !== "prepared" ||
        current.saved.settlementControl ||
        current.commitmentDigest !== source.commitmentDigest ||
        canonicalJson(current.envelope) !== canonicalJson(source.envelope) ||
        boundAt >= current.envelope.controlDeadlineAt
      )
        throw new DataFenceBusy();
      const identity = configurationSettlementSqlSessionSchema.parse(session.identity);
      if (identity.sessionNonce !== current.projection.reservation.execution.executionId)
        throw new DataFenceBusy();
      const admission = configurationSettlementAdmissionSchema.parse({
        version: 2,
        purpose: "configuration-fence-settlement",
        installationId: installation.installationId,
        origin: current.owned.origin,
        settlementId: current.input.settlementId,
        projectionDigest: current.envelope.projectionDigest,
        reservationDigest: current.envelope.reservationDigest,
        prepareExecutionDigest: controlDigest(current.prepareExecution),
        prepareAdmissionDigest: current.prepareAdmissionDigest,
        preparedReceiptDigest: current.preparedReceiptDigest,
        capacityReceiptDigest: current.capacityDigest,
        rootCertificateDigest: current.owned.ownerCertificateDigest,
        controlEnvelope: current.signedEnvelope,
        commitmentDigest: current.commitmentDigest,
        executionOrdinal: slot.executionOrdinal,
        intentOrdinal: slot.intentOrdinal,
        sqlSessionNonce: identity.sessionNonce,
        boundAt,
      });
      writeConfigurationSettlementCell(
        local,
        current.projection,
        descriptors[1]!,
        signControl(local.privateKey, configurationSettlementDomains.admission, admission),
      );
      bindOwnedConfigurationSettlementFamilySlot(local, current.projection);
      const retained = retainedSettlementAdmission(current);
      if (!retained) throw new DataFenceBusy();
      const effectTicket = Object.freeze({});
      receiverEffectTickets.set(effectTicket, session);
      handedOff = true;
      return {
        inspect: () => recoverCommittedConfigurationFenceSettlement(current.input),
        repairCommittedPublication: () =>
          recoverCommittedConfigurationFenceSettlement(current.input),
        async close() {
          if (receiverEffectTickets.has(effectTicket)) {
            receiverEffectTickets.delete(effectTicket);
            await release();
          }
        },
        async runOriginalGuardTransition() {
          if (receiverEffectTickets.get(effectTicket) !== session) throw new DataFenceBusy();
          receiverEffectTickets.delete(effectTicket);
          const attemptedAt = Date.now(),
            attempted = configurationSettlementEffectSchema.parse({
              version: 2,
              origin: current.owned.origin,
              settlementId: current.input.settlementId,
              controlExecutionDigest: controlDigest(current.envelope.execution),
              controlEnvelopeDigest: settlementRecordDigest(
                configurationSettlementDomains.binding,
                current.envelope,
              ),
              admissionDigest: retained.digest,
              commitmentDigest: current.commitmentDigest,
              preparedReceiptDigest: current.preparedReceiptDigest,
              expectedDmSequence: current.saved.receipt.sequence,
              attemptedAt,
              sqlSession: identity,
              phase: "attempted",
              terminal: null,
              observation: null,
            });
          if (attemptedAt >= current.envelope.controlDeadlineAt) {
            await release();
            throw new DataFenceBusy();
          }
          if (
            readConfigurationSettlementCell(local, current.projection, descriptors[2]!) !== null
          ) {
            await release();
            throw new DataFenceBusy();
          }
          writeConfigurationSettlementCell(
            local,
            current.projection,
            descriptors[2]!,
            signControl(local.privateKey, configurationSettlementDomains.effect, attempted),
          );
          try {
            await session.unsafe("BEGIN");
            await lock(session);
            await session.unsafe("SELECT pg_advisory_unlock($1::int,$2::int)", [0x4f4d58, 2]);
            sessionHeld = false;
            const saved = await row(session, current.input.maintenanceId, true);
            if (canonicalJson(saved) !== canonicalJson(current.saved)) throw new DataFenceBusy();
            const active = await session.unsafe(
              "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (finished_at IS NULL OR execution_state->>'publication'='unknown') LIMIT 1",
            );
            if (active.length) throw new DataFenceBusy();
            verifyConfigurationFenceSettlementHeldOwner(
              installation,
              current.owned.prepareAssertion,
              {
                ownerPrepare: current.saved.receipt.ownerPrepare,
                ownerCertificateDigest: current.owned.ownerCertificateDigest,
                serviceIds: current.saved.input.serviceIds,
              },
            );
            const [clock] = await session.unsafe(
                "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS terminal_at",
              ),
              terminalAt = clock?.terminal_at;
            if (
              typeof terminalAt !== "number" ||
              !Number.isSafeInteger(terminalAt) ||
              terminalAt < current.envelope.controlStartedAt ||
              terminalAt >= current.envelope.controlDeadlineAt ||
              Date.now() >= current.envelope.controlDeadlineAt
            )
              throw new DataFenceBusy();
            const result = dataConfigurationFenceReceiptSchema.parse({
                ...current.saved.receipt,
                state: "settled",
                sequence: current.saved.receipt.sequence + 1,
              }),
              preimage = {
                execution: current.envelope.execution,
                settlementId: current.input.settlementId,
                commitmentDigest: current.commitmentDigest,
                fenceId: current.saved.receipt.fenceId,
                result,
                publication: "committed" as const,
                terminalAt,
              },
              tuple = configurationSettlementTerminalTupleSchema.parse({
                ...preimage,
                terminalDigest: settlementRecordDigest(
                  configurationSettlementDomains.terminal,
                  preimage,
                ),
              }),
              settlementControl = configurationSettlementSqlControlSchema.parse({
                version: 2,
                settlementId: current.input.settlementId,
                controlEnvelopeDigest: attempted.controlEnvelopeDigest,
                commitmentDigest: current.commitmentDigest,
                admissionDigest: retained.digest,
                outcome: current.commitment.final.outcome,
                expectedDmSequence: current.saved.receipt.sequence,
                preparedReceiptDigest: current.preparedReceiptDigest,
                attemptedAt,
                sqlSession: identity,
                tuple,
              }),
              metadata = metadataSchema.parse({
                ...current.saved,
                guardState: "settled",
                settlement: current.input,
                settlementControl,
              });
            write({ ...current.owned, metadata: { ...metadata, guardState: "settling" } });
            if (Date.now() >= current.envelope.controlDeadlineAt) throw new DataFenceBusy();
            const updated = await session.unsafe(
              "UPDATE data_manager.jobs SET metadata=jsonb_set(coalesce(metadata,'{}'::jsonb),'{configurationMaintenance}',$2::text::jsonb),ownership_version=ownership_version+1 WHERE id=$1::uuid AND metadata->'configurationMaintenance'=$3::text::jsonb RETURNING id",
              [result.fenceId, canonicalJson(metadata), canonicalJson(current.saved)],
            );
            if (updated.length !== 1) throw new DataFenceBusy();
            commitAttempted = true;
            await session.unsafe("COMMIT");
            session.releaseConclusive();
            return publishCommittedSettlement(current, metadata, retained);
          } catch (error) {
            if (!commitAttempted) {
              try {
                await session.unsafe("ROLLBACK");
                await release();
                const observationAt = Date.now(),
                  observation = {
                    version: 2 as const,
                    state: "contained_not_settled" as const,
                    settlementId: current.input.settlementId,
                    controlExecutionDigest: attempted.controlExecutionDigest,
                    controlEnvelopeDigest: attempted.controlEnvelopeDigest,
                    commitmentDigest: current.commitmentDigest,
                    preparedReceiptDigest: current.preparedReceiptDigest,
                    expectedDmSequence: current.saved.receipt.sequence,
                    attemptedAt,
                    observationAt,
                    sqlSession: identity,
                    containment: "explicit_rollback" as const,
                  };
                write({ ...current.owned, metadata: current.saved });
                writeConfigurationSettlementCell(
                  local,
                  current.projection,
                  descriptors[2]!,
                  signControl(
                    local.privateKey,
                    configurationSettlementDomains.effect,
                    configurationSettlementEffectSchema.parse({
                      ...attempted,
                      phase: "contained_not_settled",
                      observation,
                    }),
                  ),
                );
              } catch {
                /* No conclusive rollback publication; original session stays unknown/fenced. */
              }
            }
            // Never return/reuse a connection following an uncertain COMMIT.
            throw error;
          }
        },
      };
    } catch (error) {
      if (!handedOff && sessionHeld) {
        try {
          await release();
        } catch {
          /* Held unknown session remains private. */
        }
      }
      throw error;
    }
  }
  /** Signature-checked data only. It is NOT indexed owner authority. Fixed
   * committed-SQL repair authenticates its original fields against actual
   * preparation/effect/admission/tuple sources before replacing a torn index. */
  function signedMirrorData(id: string) {
    const raw = readPrivateRecord(
        local,
        "configuration-maintenance",
        `${z.uuid().parse(id)}.json`,
        65536,
      ),
      parsed = verifyControl(
        installation.publicKey,
        "openmapx-data-configuration-fence-v1",
        raw,
        mirrorSchema,
      );
    if (
      parsed.installationId !== installation.installationId ||
      parsed.metadata.receipt.maintenanceId !== id
    )
      throw Error("Configuration guard mirror identity changed");
    return { raw, parsed };
  }
  function mirror(id: string) {
    const { raw, parsed } = signedMirrorData(id);
    verifyFamilyOwnedRecord(
      local,
      parsed.origin,
      {
        scope: "private",
        namespace: "configuration-maintenance",
        name: `${id}.json`,
        container: "",
      },
      canonicalJson(raw),
    );
    return parsed;
  }
  function write(value: z.infer<typeof mirrorSchema>) {
    const parsed = mirrorSchema.parse(value);
    const signed = signControl(local.privateKey, "openmapx-data-configuration-fence-v1", parsed);
    if (
      Buffer.byteLength(canonicalJson(signed)) > 65536 ||
      Buffer.byteLength(canonicalJson(parsed.metadata)) > 65536
    )
      throw Error("Configuration guard mirror/metadata capacity exceeded");
    writePrivateRecord(
      local,
      "configuration-maintenance",
      `${parsed.metadata.receipt.maintenanceId}.json`,
      signed,
      false,
      parsed.origin,
    );
    mirrors.set(parsed.metadata.receipt.maintenanceId, parsed);
  }
  async function lock(tx: Pick<DataFenceSql, "unsafe">) {
    const rows = await tx.unsafe(
      "SELECT pg_try_advisory_xact_lock($1::int,$2::int) AS held",
      [0x4f4d58, 2],
    );
    if (rows[0]?.held !== true) throw new DataFenceBusy();
  }
  /** Fixed local projection source. Its only argument is the ORIGINAL admitted
   * PREPARE authority; outcome/reason/digest/time all come from actual retained
   * canonical/effect/adoption/allocator and guarded SQL/mirror observations. */
  function refusedSource(authority: import("./control-authority").VerifiedExecutionAuthority) {
    const state = executionAuthorityState(authority);
    if (
      state.kind !== "configuration-maintenance.prepare" ||
      state.installation !== local ||
      !state.origin
    )
      throw Error("Original local DM refusal producer required");
    const original = verifyRetainedDataFenceRefusal(installation, state.execution),
      adoption = retainedConfigurationFenceAdoption(authority),
      assertion = retainedControlAdoptionAssertion(
        installation,
        { ...adoption, phase: "ready" },
        state.execution,
      ),
      raw = readPrivateRecord(
        local,
        "executions",
        `${state.execution.operationKey}.json`,
        65536,
      ) as { payload?: { operation?: unknown } },
      { kind, ...fields } = z
        .object({ kind: z.literal("configuration-maintenance.prepare") })
        .passthrough()
        .parse(raw.payload?.operation),
      input = dataConfigurationFencePrepareSchema.parse(fields),
      verified = inspectGrant(input, ["x-openmapx-control-delegation", assertion], kind),
      reservation = publishedConfigurationSettlementReservationState(
        verifyPublishedConfigurationSettlementReservation(installation, verified.peer, input),
        installation,
      ),
      projection = reservation.projection,
      descriptors = configurationSettlementRecordDescriptors(
        projection,
        state.execution.operationKey,
      ).receiver;
    if (
      reservation.publication === "bound" ||
      adoption.certificateDigest !== projection.rootCertificateDigest ||
      original.receipt.maintenanceId !== input.maintenanceId
    )
      throw Error("Original unused DM refusal binding required");
    verifyRetainedArtifactTargetSettlement(
      installation,
      { ...adoption, phase: "ready" },
      state.execution,
    );
    return { state, original, input, reservation, projection, descriptors };
  }
  async function publishDataConfigurationFenceRefusalProjection(
    authority: import("./control-authority").VerifiedExecutionAuthority,
  ): Promise<void> {
    const { state, original, input, reservation, projection, descriptors } =
      refusedSource(authority);
    await sql.transaction(async (tx) => {
      await lock(tx);
      if (await row(tx, input.maintenanceId))
        throw Error("A guard row cannot produce NoGuard refusal");
      try {
        readPrivateRecord(local, "configuration-maintenance", `${input.maintenanceId}.json`, 65536);
        throw Error("A guard mirror cannot produce NoGuard refusal");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      withPrivateEffectWriter(state, () => {
        const slot = readConfigurationSettlementFamilySlot(local, projection),
          cell = configurationDmCapacityCellSchema.parse(
            readConfigurationSettlementCell(local, projection, descriptors[0]!),
          );
        if (
          slot.executionDigest !== null ||
          slot.controlBindingDigest !== null ||
          ["bound", "allocating", "refusal_channel"].includes(slot.state) ||
          (original.receipt.reason === "capacity" &&
            (!slot.refusalConstraint ||
              slot.executionOrdinal !== null ||
              slot.intentOrdinal !== null ||
              !["capacity_refused", "UNUSED"].includes(slot.state)))
        )
          throw Error("Conclusive original unused allocator state required");
        let capacityReceiptDigest: string | null = null;
        if (cell.capacity) {
          const capacity = verifyControl(
            installation.publicKey,
            configurationSettlementDomains.capacity,
            cell.capacity,
            configurationSettlementCapacitySchema,
          );
          if (
            capacity.settlementId !== projection.settlementId ||
            capacity.projectionDigest !== reservation.projectionDigest ||
            capacity.reservationDigest !== projection.reservationDigest ||
            capacity.recordDescriptorsDigest !== slot.recordDescriptorsDigest ||
            capacity.reservedExecutionOrdinal !== slot.executionOrdinal ||
            capacity.reservedIntentOrdinal !== slot.intentOrdinal
          )
            throw Error("Original DM capacity refusal preimage changed");
          capacityReceiptDigest = settlementRecordDigest(
            configurationSettlementDomains.capacity,
            capacity,
          );
        } else if (
          original.receipt.reason !== "capacity" ||
          (slot.state !== "capacity_refused" && slot.state !== "UNUSED")
        )
          throw Error("Original full busy capacity certificate required");
        const payload = configurationDmNoGuardRefusalSchema.parse({
            version: 2,
            installationId: installation.installationId,
            origin: state.origin,
            ownerPrepare: input.ownerPrepare,
            rootAdmissionDigest: projection.rootAdmissionDigest,
            rootCertificateDigest: projection.rootCertificateDigest,
            maintenanceId: input.maintenanceId,
            candidateId: input.candidateId,
            planDigest: input.planDigest,
            settlementId: projection.settlementId,
            projectionDigest: reservation.projectionDigest,
            reservationDigest: projection.reservationDigest,
            prepareExecution: state.execution,
            prepareAdmissionDigest: state.receiptDigest,
            refusalReceipt: original.receipt,
            effectReceiptDigest: original.effectReceiptDigest,
            effectSettlementDigest: original.effectSettlementDigest,
            canonicalTerminalDigest: original.digest,
            canonicalTerminalAt: original.terminalAt,
            capacityReceiptDigest,
          }),
          signed = signControl(local.privateKey, configurationSettlementDomains.refusal, payload);
        if (cell.refusal) {
          if (canonicalJson(cell.refusal) !== canonicalJson(signed))
            throw Error("Original DM refusal projection conflict");
        } else {
          if (cell.unused || reservation.publication !== "pending")
            throw Error("Original DM refusal projection missing after closure");
          writeConfigurationSettlementCell(local, projection, descriptors[0]!, {
            ...cell,
            refusal: signed,
          });
        }
      });
    });
  }
  /** No caller proof fields: original refusal -> retained intent -> exact
   * local metadata/ticket CAS -> reread -> pinned-role confirmation. */
  async function markRefusedConfigurationSettlementCapacityUnused(
    authority: import("./control-authority").VerifiedExecutionAuthority,
  ): Promise<void> {
    const source = refusedSource(authority),
      { state, original, input, reservation, projection, descriptors } = source;
    const before = configurationDmCapacityCellSchema.parse(
      readConfigurationSettlementCell(local, projection, descriptors[0]!),
    );
    if (!before.refusal) await publishDataConfigurationFenceRefusalProjection(authority);
    await sql.transaction(async (tx) => {
      await lock(tx);
      if (await row(tx, input.maintenanceId))
        throw Error("A guard row cannot mark settlement capacity UNUSED");
      try {
        readPrivateRecord(local, "configuration-maintenance", `${input.maintenanceId}.json`, 65536);
        throw Error("A guard mirror cannot mark settlement capacity UNUSED");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      withPrivateEffectWriter(state, () => {
        let cell = configurationDmCapacityCellSchema.parse(
          readConfigurationSettlementCell(local, projection, descriptors[0]!),
        );
        if (!cell.refusal) throw Error("Original signed DM refusal required before UNUSED");
        const refusal = verifyControl(
            installation.publicKey,
            configurationSettlementDomains.refusal,
            cell.refusal,
            configurationDmNoGuardRefusalSchema,
          ),
          slot = readRefusedConfigurationSettlementCapacitySnapshot(local, projection);
        if (
          refusal.settlementId !== projection.settlementId ||
          refusal.projectionDigest !== reservation.projectionDigest ||
          refusal.prepareAdmissionDigest !== state.receiptDigest ||
          canonicalJson(refusal.prepareExecution) !== canonicalJson(state.execution) ||
          refusal.canonicalTerminalDigest !== original.digest ||
          refusal.canonicalTerminalAt !== original.terminalAt ||
          refusal.effectReceiptDigest !== original.effectReceiptDigest ||
          refusal.effectSettlementDigest !== original.effectSettlementDigest ||
          canonicalJson(refusal.refusalReceipt) !== canonicalJson(original.receipt)
        )
          throw Error("Original DM refusal source changed before UNUSED");
        const capacityDigest = cell.capacity
          ? settlementRecordDigest(
              configurationSettlementDomains.capacity,
              verifyControl(
                installation.publicKey,
                configurationSettlementDomains.capacity,
                cell.capacity,
                configurationSettlementCapacitySchema,
              ),
            )
          : null;
        if (capacityDigest !== refusal.capacityReceiptDigest)
          throw Error("Original DM capacity certificate changed before UNUSED");
        const oldIntent = cell.unused
            ? verifyControl(
                installation.publicKey,
                configurationSettlementDomains.unusedIntent,
                cell.unused.intent,
                configurationUnusedCapacityIntentSchema,
              )
            : null,
          intent = configurationUnusedCapacityIntentSchema.parse({
            version: 2,
            installationId: installation.installationId,
            origin: state.origin,
            role: "data-manager",
            ownerPrepareDigest: controlDigest(projection.ownerPrepare),
            prepareExecutionDigest: controlDigest(state.execution),
            settlementId: projection.settlementId,
            projectionDigest: reservation.projectionDigest,
            capacityReceiptDigest: capacityDigest,
            sourceProofDigest: settlementRecordDigest(
              configurationSettlementDomains.refusal,
              refusal,
            ),
            executionOrdinal: slot.executionOrdinal,
            intentOrdinal: slot.intentOrdinal,
            recordDescriptorsDigest: slot.recordDescriptorsDigest,
            allocatedDescriptorDigests: slot.allocatedDescriptorDigests,
            createdAt: oldIntent?.createdAt ?? Date.now(),
          }),
          signedIntent = signControl(
            local.privateKey,
            configurationSettlementDomains.unusedIntent,
            intent,
          );
        if (Buffer.byteLength(canonicalJson(signedIntent)) > 2048)
          throw Error("Original DM UNUSED intent exceeds reserved bound");
        if (oldIntent && canonicalJson(oldIntent) !== canonicalJson(intent))
          throw Error("Original DM UNUSED intent changed");
        if (!cell.unused) {
          if (slot.state === "UNUSED") throw Error("Original DM UNUSED intent missing after CAS");
          cell = { ...cell, unused: { intent: signedIntent, confirmation: null } };
          writeConfigurationSettlementCell(local, projection, descriptors[0]!, cell);
        }
        const committed = commitRefusedDataConfigurationSettlementSlotUnused(local, projection),
          intentDigest = settlementRecordDigest(
            configurationSettlementDomains.unusedIntent,
            intent,
          ),
          confirmation = configurationUnusedCapacityConfirmationSchema.parse({
            version: 2,
            installationId: installation.installationId,
            origin: state.origin,
            role: "data-manager",
            ownerPrepareDigest: controlDigest(projection.ownerPrepare),
            settlementId: projection.settlementId,
            projectionDigest: reservation.projectionDigest,
            intentDigest,
            slotStateDigest: controlDigest({
              executionOrdinal: committed.executionOrdinal,
              intentOrdinal: committed.intentOrdinal,
              recordDescriptorsDigest: committed.recordDescriptorsDigest,
              allocatedDescriptorDigests: committed.allocatedDescriptorDigests,
              state: "UNUSED",
              intentDigest,
            }),
            confirmedAt: committed.unusedConfirmedAt,
          }),
          signedConfirmation = signControl(
            local.privateKey,
            configurationSettlementDomains.unusedConfirmation,
            confirmation,
          );
        if (Buffer.byteLength(canonicalJson(signedConfirmation)) > 1024)
          throw Error("Original DM UNUSED confirmation exceeds reserved bound");
        cell = configurationDmCapacityCellSchema.parse(
          readConfigurationSettlementCell(local, projection, descriptors[0]!),
        );
        if (cell.unused?.confirmation) {
          if (canonicalJson(cell.unused.confirmation) !== canonicalJson(signedConfirmation))
            throw Error("Original DM UNUSED confirmation changed");
        } else
          writeConfigurationSettlementCell(local, projection, descriptors[0]!, {
            ...cell,
            unused: { intent: signedIntent, confirmation: signedConfirmation },
          });
      });
    });
  }
  async function row(tx: Pick<DataFenceSql, "unsafe">, id: string, forUpdate = false) {
    const rows = await tx.unsafe(
      "SELECT id,metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND metadata->'configurationMaintenance'->'receipt'->>'maintenanceId'=$1" +
        (forUpdate ? " FOR UPDATE" : ""),
      [id],
    );
    if (rows.length > 1) throw Error("Duplicate configuration fence");
    if (!rows[0]) return null;
    return metadataSchema.parse(
      z.object({ configurationMaintenance: metadataSchema }).parse(rows[0].metadata)
        .configurationMaintenance,
    );
  }
  function withPreparedWitnessDirectory<T>(run: (directory: AnchoredDirectory) => T): T {
    const opened: AnchoredDirectory[] = [],
      own = (directory: AnchoredDirectory) => {
        opened.push(directory);
        return directory;
      };
    try {
      const root = own(new AnchoredDirectory(local.dataRoot)),
        control = own(root.directory(".admin-target-control")),
        executions = own(control.directory("executions")),
        role = own(executions.directory("data-manager"));
      return run(role);
    } finally {
      for (const directory of opened.reverse()) directory.close();
    }
  }
  function reservePreparedWitness(
    authority: import("./control-authority").VerifiedExecutionAuthority,
  ): void {
    const state = executionAuthorityState(authority);
    if (state.kind !== "configuration-maintenance.prepare" || !state.origin)
      throw Error("Original DM preparation required");
    withPreparedWitnessDirectory((directory) => {
      const name = `${state.execution.operationKey}.data-terminal.json`;
      try {
        const prior = directory.read(name, 8192).toString("utf8");
        verifyFamilyOwnedRecord(
          local,
          state.origin!,
          { scope: "shared", namespace: "execution", container: "data-manager", name },
          prior,
        );
        if (prior !== "null") {
          const published = verifyControl(
            local.installation.publicKey,
            dataConfigurationFencePreparedWitnessDomain,
            JSON.parse(prior),
            dataConfigurationFencePreparedWitnessSchema,
          );
          if (
            canonicalJson(published.prepareExecution) !== canonicalJson(state.execution) ||
            published.prepareAdmissionDigest !== state.receiptDigest
          )
            throw Error("Prepared source reservation conflict");
        }
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      familyRecordWrite(
        local,
        state.origin!,
        { scope: "shared", namespace: "execution", container: "data-manager", name },
        "null",
        (track) => directory.write(name, "null", true, track),
        true,
      );
    });
  }
  /** The fixed local producer reads its own original SQL/mirror/canonical/effect
   * sources. No caller receipt, digest, time or success flag is accepted. */
  async function publishPreparedWitness(
    authority: import("./control-authority").VerifiedExecutionAuthority,
  ): Promise<void> {
    const state = executionAuthorityState(authority);
    if (state.kind !== "configuration-maintenance.prepare" || !state.origin)
      throw Error("Original DM preparation required");
    const admitted = z
      .object({
        payload: z.object({
          operation: z
            .object({ kind: z.literal("configuration-maintenance.prepare") })
            .passthrough(),
        }),
      })
      .parse(readPrivateRecord(local, "executions", `${state.execution.operationKey}.json`, 65536));
    const { kind: _kind, ...body } = admitted.payload.operation;
    const input = dataConfigurationFencePrepareSchema.parse(body);
    await sql.transaction(async (tx) => {
      await lock(tx);
      const saved = await row(tx, input.maintenanceId),
        owned = mirror(input.maintenanceId);
      if (
        !saved ||
        !["prepared", "settled"].includes(saved.guardState) ||
        canonicalJson(saved) !== canonicalJson(owned.metadata) ||
        canonicalJson(saved.input) !== canonicalJson(input)
      )
        throw Error("Original prepared guard source unavailable");
      const effect = verifyControl(
        local.installation.publicKey,
        "openmapx-control-settlement-v1",
        readPrivateRecord(local, "effects", `${state.execution.operationKey}.json`, 65536),
        z.strictObject({
          identity: executionRefSchema,
          outcome: z.literal("committed"),
          publication: z.literal("committed"),
          terminalReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
          receipt: z.strictObject({
            kind: z.literal("data-configuration-fence"),
            receipt: dataConfigurationFenceReceiptSchema,
            guardDigest: z.string().regex(/^[a-f0-9]{64}$/),
          }),
        }),
      );
      const receipt = effect.receipt.receipt;
      const original = {
        ...owned,
        metadata: {
          version: 1 as const,
          guardState: "prepared" as const,
          receipt,
          input,
          ...(saved.settlementReservation
            ? { settlementReservation: saved.settlementReservation }
            : {}),
        },
      };
      const terminal = verifyControl(
        local.installation.publicKey,
        "openmapx-data-fence-terminal-v1",
        readPrivateRecord(
          local,
          "observations",
          `terminal-${state.execution.operationKey}.json`,
          8192,
        ),
        fenceTerminalSchema,
      );
      const times = await tx.unsafe(
        "SELECT finished_at FROM data_manager.jobs WHERE id=$1::uuid FOR UPDATE",
        [receipt.fenceId],
      );
      if (
        receipt.state !== "prepared" ||
        receipt.sequence !== 0 ||
        receipt.fenceId !== state.execution.executionId ||
        canonicalJson(effect.identity) !== canonicalJson(state.execution) ||
        canonicalJson({ ...saved.receipt, state: "prepared", sequence: 0 }) !==
          canonicalJson(receipt) ||
        effect.terminalReceiptDigest !== controlDigest(effect.receipt) ||
        effect.receipt.guardDigest !== controlDigest(original) ||
        terminal.phase !== "canonical" ||
        terminal.admissionDigest !== state.receiptDigest ||
        canonicalJson(terminal.execution) !== canonicalJson(state.execution) ||
        terminal.terminalDigest !== dataFenceTerminalDigest(receipt) ||
        terminal.terminalAt !== owned.preparedAt ||
        !times[0] ||
        retainedDataDatabaseTimestamp(times[0].finished_at).getTime() !== terminal.terminalAt
      )
        throw Error("Original prepared canonical evidence changed");
      verifyControlEffectSettlement(installation, state.execution);
      const value = dataConfigurationFencePreparedWitnessSchema.parse({
        version: 2,
        installationId: installation.installationId,
        origin: state.origin,
        ownerPrepare: input.ownerPrepare,
        prepareExecution: state.execution,
        prepareAdmissionDigest: state.receiptDigest,
        rootCertificateDigest: owned.ownerCertificateDigest,
        preparedReceipt: receipt,
        preparedReceiptDigest: settlementRecordDigest(
          configurationSettlementDomains.preparedReceipt,
          receipt,
        ),
        preparedCanonicalDigest: terminal.terminalDigest,
        preparedTerminalAt: terminal.terminalAt,
        guardDigest: effect.receipt.guardDigest,
        effectReceiptDigest: effect.terminalReceiptDigest,
        effectSettlementDigest: controlDigest(effect),
      });
      const bytes = canonicalJson(
        signControl(local.privateKey, dataConfigurationFencePreparedWitnessDomain, value),
      );
      if (Buffer.byteLength(bytes) > 8192) throw Error("Prepared witness capacity exceeded");
      withPreparedWitnessDirectory((directory) => {
        const name = `${state.execution.operationKey}.data-terminal.json`,
          prior = directory.read(name, 8192).toString("utf8"),
          before = directory.fileIdentity(name);
        verifyFamilyOwnedRecord(
          local,
          state.origin!,
          { scope: "shared", namespace: "execution", container: "data-manager", name },
          prior,
        );
        if (prior === bytes) return;
        if (prior !== "null") throw Error("Prepared canonical witness conflict");
        familyRecordWrite(
          local,
          state.origin!,
          { scope: "shared", namespace: "execution", container: "data-manager", name },
          bytes,
          (track) =>
            directory.write(name, bytes, false, (inode) => {
              if (
                !sameInode(before, directory.fileIdentity(name)) ||
                directory.read(name, 8192).toString("utf8") !== prior
              )
                throw Error("Prepared witness changed during publication");
              track(inode);
            }),
        );
      });
    });
  }
  function inspectGrant(
    body: DataConfigurationFencePrepare | DataConfigurationFenceSettle,
    rawHeaders: readonly string[],
    kind: "configuration-maintenance.prepare" | "configuration-maintenance.settle",
    owner?: DataConfigurationFencePrepare,
  ) {
    try {
      const headers = controlHeaders(rawHeaders);
      if (!headers.delegation || headers.parent) throw Error("Pinned agent fence grant required");
      const grant = inspectArtifactDelegation({
        dataRoot: local.dataRoot,
        assertion: headers.delegation,
        installation,
      });
      const operation = { kind, ...body },
        parent = "ownerPrepare" in body ? body.ownerPrepare : owner?.ownerPrepare;
      if (
        grant.recipient !== "data-manager" ||
        grant.parent.executor !== "ops-agent" ||
        grant.kind !== kind ||
        grant.phase !==
          (kind.endsWith(".prepare") ? "configuration-fence" : "configuration-fence-settle") ||
        !parent ||
        controlDigest(grant.parent) !== controlDigest(parent) ||
        grant.execution.operationFingerprint !== controlDigest(operation) ||
        grant.execution.executor !== "data-manager" ||
        grant.execution.fingerprint !==
          executionFingerprint({
            kind,
            operationFingerprint: controlDigest(operation),
            deadlineAt: grant.execution.deadlineAt,
            parent: retainedControlParent(grant.parent),
          })
      )
        throw Error("Configuration fence grant identity conflict");
      if (
        "serviceIds" in body &&
        canonicalJson(grant.serviceIds) !== canonicalJson(body.serviceIds)
      )
        throw Error("Configuration fence target subset conflict");
      const peer = verifyControlPeer(installation, {
        rawHeaders,
        transportPrincipal: "shared-data-manager-bearer",
        execution: grant.execution,
        kind,
      });
      return {
        grant,
        peer,
        operation,
        parent: verifiedParentForArtifactDelegation(
          installation,
          headers.delegation,
          grant.execution,
        ),
        assertion: headers.delegation,
      };
    } catch {
      // Classify verification failures before any guard SQL, mirror or adoption.
      throw Object.assign(Error("Pinned agent configuration fence grant rejected"), {
        statusCode: 403,
      });
    }
  }
  async function withLeaf(
    verified: ReturnType<typeof inspectGrant>,
    run: (
      authority: import("./control-authority").VerifiedExecutionAuthority,
    ) => Promise<DataConfigurationFenceReceipt>,
  ) {
    const { grant, peer } = verified;
    const lease = await adoptArtifactTargetLease({
      dataRoot: local.dataRoot,
      assertion: verified.assertion,
      peer,
      execution: grant.execution,
      serviceIds: grant.serviceIds,
    });
    try {
      const admittedAt = Date.now();
      let authority: ReturnType<typeof restoreAdmittedControlExecution> | undefined;
      try {
        authority = restoreAdmittedControlExecution(installation, grant.execution);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      authority ??= retainAdmittedControlExecution(installation, {
        execution: grant.execution,
        kind: grant.kind,
        operation: verified.operation,
        admittedAt,
        requestedDeadlineAt: grant.execution.deadlineAt,
        parent: verified.parent,
        serviceIds: grant.serviceIds,
      });
      bindBorrowedControlExecution(lease, authority);
      let priorEffect: unknown;
      try {
        priorEffect = readPrivateRecord(
          local,
          "effects",
          `${grant.execution.operationKey}.json`,
          65536,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (priorEffect !== undefined && priorEffect !== null) {
        verifyRetainedArtifactTargetSettlement(
          installation,
          { leaseId: grant.leaseId, delegationId: grant.delegationId, phase: "ready" },
          grant.execution,
        );
        const kind = z
          .object({ payload: z.object({ receipt: z.object({ kind: z.string() }) }) })
          .parse(priorEffect).payload.receipt.kind;
        if (kind === "data-configuration-fence-refused") {
          verifyControlEffectSettlement(installation, grant.execution);
          await markRefusedConfigurationSettlementCapacityUnused(authority);
          throw new DataFenceBusy();
        }
        const original = verifyControl(
          installation.publicKey,
          "openmapx-control-settlement-v1",
          priorEffect,
          z
            .object({
              receipt: z
                .object({
                  kind: z.literal("data-configuration-fence"),
                  receipt: dataConfigurationFenceReceiptSchema,
                })
                .passthrough(),
            })
            .passthrough(),
        );
        const saved = await row(sql, original.receipt.receipt.maintenanceId);
        if (!saved) throw new DataFenceBusy();
        if (grant.kind === "configuration-maintenance.prepare")
          await publishPreparedWitness(authority);
        return saved.receipt;
      }
      if (grant.kind === "configuration-maintenance.prepare")
        requireControlJournalRetention(authority);
      if (grant.kind === "configuration-maintenance.prepare")
        assertArtifactTargetLeaseForward(lease);
      if (grant.kind === "configuration-maintenance.prepare") reservePreparedWitness(authority);
      beginControlEffect(authority);
      let receipt: DataConfigurationFenceReceipt;
      try {
        receipt = await run(authority);
      } catch (error) {
        // Before any preparing mirror exists the fixed guard path has made
        // no logical write. A busy result can settle this exact unused leaf.
        if (error instanceof DataFenceBusy) {
          if (error instanceof DataFenceCapacityRefused)
            refusedConfigurationSettlementCapacityState(error.proof, authority);
          let absent = false;
          try {
            readPrivateRecord(
              local,
              "configuration-maintenance",
              `${z.object({ maintenanceId: z.uuid() }).parse(verified.operation).maintenanceId}.json`,
              65536,
            );
          } catch (missing) {
            absent = (missing as NodeJS.ErrnoException).code === "ENOENT";
          }
          if (
            absent &&
            !(await row(
              sql,
              z.object({ maintenanceId: z.uuid() }).parse(verified.operation).maintenanceId,
            ))
          ) {
            const state = executionAuthorityState(authority),
              observation = {
                kind: "data-configuration-fence-refused" as const,
                maintenanceId: z.object({ maintenanceId: z.uuid() }).parse(verified.operation)
                  .maintenanceId,
                reason:
                  error instanceof DataFenceCapacityRefused
                    ? ("capacity" as const)
                    : ("busy" as const),
              },
              effect = {
                identity: grant.execution,
                outcome: "failed_without_effect" as const,
                publication: "not_started" as const,
                terminalReceiptDigest: controlDigest(observation),
                receipt: observation,
              };
            const terminalAt = Date.now(),
              terminalDigest = controlDigest({ version: 1, refused: observation });
            withPrivateEffectWriter(state, () => {
              writePrivateRecord(
                local,
                "observations",
                `terminal-${grant.execution.operationKey}.json`,
                signControl(
                  local.privateKey,
                  "openmapx-data-fence-terminal-v1",
                  fenceTerminalSchema.parse({
                    version: 1,
                    phase: "canonical",
                    execution: grant.execution,
                    admissionDigest: state.receiptDigest,
                    terminalDigest,
                    terminalAt,
                  }),
                ),
                false,
                state.origin,
              );
              settleExecutionLifecycle(state);
              writePrivateRecord(
                local,
                "effects",
                `${grant.execution.operationKey}.json`,
                signControl(local.privateKey, "openmapx-control-settlement-v1", effect),
                false,
                state.origin,
              );
              if (state.origin)
                markFamilyTerminal(
                  local,
                  state.origin,
                  grant.execution,
                  true,
                  controlDigest(effect),
                );
            });
            await settleArtifactTargetLeaseChild(
              lease,
              verifyControlEffectSettlement(installation, grant.execution),
            );
            if (state.origin) {
              publishFamilyCanonicalTerminal(
                local,
                state.origin,
                grant.execution,
                true,
                terminalDigest,
                terminalAt,
              );
              completeFamilyJournal(local, state.origin, grant.execution, terminalAt);
            }
            await publishDataConfigurationFenceRefusalProjection(authority);
            await markRefusedConfigurationSettlementCapacityUnused(authority);
          }
        }
        throw error;
      }
      const state = executionAuthorityState(authority),
        stored = mirror(receipt.maintenanceId);
      if (controlDigest(stored.metadata.receipt) !== controlDigest(receipt))
        throw Error("Durable fence receipt changed before settlement");
      withPrivateEffectWriter(state, () => {
        const proof = {
            kind: "data-configuration-fence" as const,
            receipt,
            guardDigest: controlDigest(stored),
          },
          effect = {
            identity: grant.execution,
            outcome: "committed" as const,
            publication: "committed" as const,
            terminalReceiptDigest: controlDigest(proof),
            receipt: proof,
          };
        settleExecutionLifecycle(state);
        writePrivateRecord(
          local,
          "effects",
          `${grant.execution.operationKey}.json`,
          signControl(local.privateKey, "openmapx-control-settlement-v1", effect),
          false,
          state.origin,
        );
        if (state.origin)
          markFamilyTerminal(local, state.origin, grant.execution, true, controlDigest(effect));
      });
      await settleArtifactTargetLeaseChild(
        lease,
        verifyControlEffectSettlement(installation, grant.execution),
      );
      if (grant.kind === "configuration-maintenance.prepare" && state.origin) {
        const digest = dataFenceTerminalDigest(receipt),
          original = verifyControl(
            installation.publicKey,
            "openmapx-data-fence-terminal-v1",
            readPrivateRecord(
              local,
              "observations",
              `terminal-${grant.execution.operationKey}.json`,
              8192,
            ),
            fenceTerminalSchema,
          );
        if (
          original.terminalDigest !== digest ||
          original.terminalAt !== stored.preparedAt ||
          original.admissionDigest !== state.receiptDigest
        )
          throw Error("Original logical guard terminal commitment changed");
        writePrivateRecord(
          local,
          "observations",
          `terminal-${grant.execution.operationKey}.json`,
          signControl(local.privateKey, "openmapx-data-fence-terminal-v1", {
            ...original,
            phase: "canonical",
          }),
          false,
          state.origin,
        );
        publishFamilyCanonicalTerminal(
          local,
          state.origin,
          grant.execution,
          true,
          digest,
          stored.preparedAt,
        );
        completeFamilyJournal(local, state.origin, grant.execution, stored.preparedAt);
        await publishPreparedWitness(authority);
      }
      return receipt;
    } finally {
      closeArtifactTargetLeaseHandle(lease);
    }
  }
  async function assertAdmission(tx: Pick<DataFenceSql, "unsafe">) {
    if (
      startup === "closed" ||
      [...mirrors.values()].some((value) => value.metadata.guardState !== "settled")
    )
      throw new DataFenceBusy();
    const rows = await tx.unsafe(
      "SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 1",
    );
    if (rows.length) throw new DataFenceBusy();
    const unknown = await tx.unsafe(
      "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (execution_state->>'publication'='unknown' OR (execution_version IS NULL AND finished_at IS NULL AND status='interrupted')) LIMIT 1",
    );
    if (unknown.length) throw new DataFenceBusy();
  }
  async function inspectGenerationAdmission(
    value: unknown,
    rawHeaders: readonly string[],
    parent: VerifiedParentExecution | undefined,
    tx: Pick<DataFenceSql, "unsafe">,
  ) {
    const request = startGenerationHardlinksExecutionSchema.parse(value),
      headers = controlHeaders(rawHeaders);
    if (!headers.delegation || headers.parent)
      throw Object.assign(Error("Signed generation grant required"), { statusCode: 403 });
    const grant = inspectArtifactDelegation({
      dataRoot: local.dataRoot,
      assertion: headers.delegation,
      installation,
    });
    if (
      grant.recipient !== "data-manager" ||
      grant.kind !== "generation-hardlinks" ||
      grant.phase !== "hardlinks" ||
      grant.execution.operationKey !== request.operationKey ||
      grant.execution.operationFingerprint !== controlDigest(request.input) ||
      request.input.planDigest !== controlDigest(request.plan) ||
      request.plan.plan.some((entry) => !grant.serviceIds.includes(entry.consumerService))
    )
      throw Object.assign(Error("Generation plan/grant binding conflict"), { statusCode: 403 });
    if (startup === "closed") throw new DataFenceBusy();
    const rows = await tx.unsafe(
      "SELECT metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 2",
    );
    if (rows.length > 1) throw new DataFenceBusy();
    const saved = rows[0]
      ? z.object({ configurationMaintenance: metadataSchema }).parse(rows[0].metadata)
          .configurationMaintenance
      : undefined;
    if (!saved) {
      if ([...mirrors.values()].some((mirror) => mirror.metadata.guardState !== "settled"))
        throw new DataFenceBusy();
      return;
    }
    const owned = mirror(saved.receipt.maintenanceId);
    if (canonicalJson(owned.metadata) !== canonicalJson(saved)) throw new DataFenceBusy();
    if (
      grant.ownerCertificateDigest !== owned.ownerCertificateDigest ||
      canonicalJson(grant.owner) !== canonicalJson(saved.receipt.ownerPrepare) ||
      grant.owner.executor !== "ops-agent" ||
      request.input.revisionId !== saved.receipt.revisionId ||
      request.input.planDigest !== saved.receipt.hardlinkPlanDigest ||
      request.input.coordinatorMode !== saved.input.coordinatorMode ||
      grant.serviceIds.some((id) => !saved.input.serviceIds.includes(id))
    )
      throw Object.assign(Error("Generation maintenance owner/revision/hash conflict"), {
        statusCode: 403,
      });
    if (
      saved.guardState !== "prepared" ||
      saved.receipt.state !== "prepared" ||
      saved.receipt.sequence !== 0 ||
      !parent
    )
      throw new DataFenceBusy();
    try {
      verifyConfigurationMaintenanceGenerationWitness(installation, request, parent, grant, {
        maintenanceId: saved.receipt.maintenanceId,
        candidateId: saved.receipt.candidateId,
        ownerPrepare: saved.receipt.ownerPrepare,
        revisionId: saved.receipt.revisionId,
        hardlinkPlanDigest: saved.receipt.hardlinkPlanDigest!,
        coordinatorMode: saved.input.coordinatorMode,
        serviceIds: saved.input.serviceIds,
        rootCertificateDigest: owned.ownerCertificateDigest,
      });
    } catch {
      throw new DataFenceBusy();
    }
    const unknown = await tx.unsafe(
      "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (execution_state->>'publication'='unknown' OR (execution_version IS NULL AND finished_at IS NULL AND status='interrupted')) LIMIT 1",
    );
    if (unknown.length) throw new DataFenceBusy();
    return { request, grant, guardDigest: controlDigest(saved) };
  }
  return {
    async startup() {
      startup = "closed";
      mirrors.clear();
      let directory: ReturnType<typeof local.privateRoot.directory> | undefined;
      try {
        directory = local.privateRoot.directory("configuration-maintenance");
        for (const file of directory.listBounded(4097)) {
          if ([".retention-count", ".retention-highwater", ".retention-transaction"].includes(file))
            continue;
          if (!/^[a-f0-9-]{36}\.json$/.test(file))
            throw Error("Unexpected configuration fence file");
          const value = signedMirrorData(file.slice(0, -5)).parsed;
          mirrors.set(value.metadata.receipt.maintenanceId, value);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        directory?.close();
      }
      const committed = await sql.unsafe(
        "SELECT metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND metadata->'configurationMaintenance'->'settlementControl' IS NOT NULL LIMIT 4097",
      );
      if (committed.length > 4096) throw Error("Configuration settlement recovery capacity");
      for (const raw of committed) {
        const value = z
          .object({ configurationMaintenance: metadataSchema })
          .parse(raw.metadata).configurationMaintenance;
        if (value.guardState === "settled" && value.settlementControl && value.settlement) {
          await recoverCommittedConfigurationFenceSettlement(
            dataConfigurationFenceSettleSchema.parse(value.settlement),
          );
        }
      }
      for (const id of mirrors.keys()) mirrors.set(id, mirror(id));
      const rows = await sql.unsafe(
        "SELECT metadata FROM data_manager.jobs WHERE kind='configuration-maintenance' AND coalesce(metadata->'configurationMaintenance'->>'guardState','recovery_required') <> 'settled' LIMIT 2",
      );
      if (rows.length > 1) throw Error("Conflicting configuration guards");
      for (const raw of rows) {
        const value = z
            .object({ configurationMaintenance: metadataSchema })
            .parse(raw.metadata).configurationMaintenance,
          originalId = value.receipt.maintenanceId;
        await observeUnsettledConfigurationFenceSettlement(originalId);
        const saved = mirrors.get(originalId);
        if (!saved || canonicalJson(saved.metadata) !== canonicalJson(value))
          throw Error("Configuration guard mirror/database recovery required");
      }
      for (const value of mirrors.values())
        if (value.metadata.guardState !== "settled") {
          const saved = await row(sql, value.metadata.receipt.maintenanceId);
          if (!saved || canonicalJson(saved) !== canonicalJson(value.metadata))
            throw Error("Half-written configuration guard retains admission fence");
        }
      startup = rows.length ? "fenced" : "open";
    },
    assertAdmission,
    async assertGenerationAdmission(
      value: unknown,
      rawHeaders: readonly string[],
      parent?: VerifiedParentExecution,
    ): Promise<VerifiedPreparedGenerationAdmission | undefined> {
      const checked = await inspectGenerationAdmission(value, rawHeaders, parent, sql);
      if (!checked) return undefined;
      const proof = Object.freeze({}) as VerifiedPreparedGenerationAdmission;
      preparedGenerations.set(proof, {
        installation,
        request: checked.request,
        headers: Object.freeze([...rawHeaders]),
        parent: parent!,
        guardDigest: checked.guardDigest,
        execution: checked.grant.execution,
      });
      return proof;
    },
    async assertPreparedGenerationAdmission(
      tx: Pick<DataFenceSql, "unsafe">,
      proof: VerifiedPreparedGenerationAdmission,
      input: unknown,
      admission: {
        operationKey: string;
        requestedDeadlineAt?: number;
        parent?: VerifiedParentExecution;
        id?: string;
        principal?: string;
      },
    ): Promise<void> {
      const source = preparedGenerations.get(proof);
      if (
        !source ||
        source.installation !== installation ||
        source.parent !== admission.parent ||
        canonicalJson(input) !== canonicalJson(source.request.input) ||
        admission.operationKey !== source.request.operationKey ||
        admission.requestedDeadlineAt !== source.request.requestedDeadlineAt ||
        admission.id !== source.execution.executionId ||
        admission.principal !== source.execution.principal
      )
        throw new DataFenceBusy();
      const checked = await inspectGenerationAdmission(
        source.request,
        source.headers,
        source.parent,
        tx,
      );
      if (
        !checked ||
        checked.guardDigest !== source.guardDigest ||
        canonicalJson(checked.grant.execution) !== canonicalJson(source.execution)
      )
        throw new DataFenceBusy();
    },
    async withAdmission<T>(run: (tx: Pick<DataFenceSql, "unsafe">) => Promise<T>): Promise<T> {
      return sql.transaction(async (tx) => {
        await lock(tx);
        await assertAdmission(tx);
        return run(tx);
      });
    },
    async prepare(value: DataConfigurationFencePrepare, rawHeaders: readonly string[]) {
      const input = dataConfigurationFencePrepareSchema.parse(value),
        verified = inspectGrant(input, rawHeaders, "configuration-maintenance.prepare");
      const existing = await row(sql, input.maintenanceId);
      if (existing) {
        if (
          canonicalJson(existing.input) !== canonicalJson(input) ||
          existing.receipt.fenceId !== verified.grant.execution.executionId
        )
          throw Object.assign(Error("Configuration fence conflict"), { statusCode: 409 });
        return withLeaf(verified, async () => existing.receipt);
      }
      if (startup === "closed") throw new DataFenceBusy();
      const reservation = verifyPublishedConfigurationSettlementReservation(
        installation,
        verified.peer,
        input,
      );
      const receipt = dataConfigurationFenceReceiptSchema.parse({
        fenceId: verified.grant.execution.executionId,
        maintenanceId: input.maintenanceId,
        candidateId: input.candidateId,
        ownerPrepare: input.ownerPrepare,
        planDigest: input.planDigest,
        revisionId: input.revisionId,
        hardlinkPlanDigest: input.hardlinkPlanDigest,
        sequence: 0,
        state: "prepared",
      });
      const metadata = metadataSchema.parse({
        version: 1,
        guardState: "preparing",
        receipt,
        input,
      });
      if (!verified.grant.origin) throw Error("Dated configuration guard required");
      const owned = {
        preparedAt: Date.now(),
        version: 1 as const,
        installationId: installation.installationId,
        origin: verified.grant.origin,
        ownerCertificateDigest: verified.grant.ownerCertificateDigest,
        prepareAssertion: verified.assertion,
        metadata,
      };
      return withLeaf(verified, async (authority) => {
        const capacity = reserveReceivedConfigurationSettlementCapacity(authority, reservation);
        if (!("capacity" in capacity)) throw new DataFenceCapacityRefused(capacity);
        metadata.settlementReservation = {
          version: 2,
          settlementId: capacity.capacity.settlementId,
          projectionDigest: capacity.capacity.projectionDigest,
          reservationDigest: capacity.capacity.reservationDigest,
          capacityReceiptDigest: capacity.capacityDigest,
        };
        await sql.transaction(async (tx) => {
          await lock(tx);
          await assertAdmission(tx);
          const active = await tx.unsafe(
            "SELECT id FROM data_manager.jobs WHERE kind <> 'configuration-maintenance' AND (finished_at IS NULL OR execution_state->>'publication'='unknown') LIMIT 1",
          );
          const transfers = await tx.unsafe(
            "SELECT id FROM data_manager.offline_package_jobs WHERE status='preparing' LIMIT 1",
          );
          if (active.length || transfers.length) throw new DataFenceBusy();
          write(owned);
          const state = executionAuthorityState(authority),
            terminal = fenceTerminalSchema.parse({
              version: 1,
              phase: "prepared",
              execution: verified.grant.execution,
              admissionDigest: state.receiptDigest,
              terminalDigest: dataFenceTerminalDigest(receipt),
              terminalAt: owned.preparedAt,
            });
          writePrivateRecord(
            local,
            "observations",
            `terminal-${verified.grant.execution.operationKey}.json`,
            signControl(local.privateKey, "openmapx-data-fence-terminal-v1", terminal),
            false,
            state.origin,
          );
          await tx.unsafe(
            "INSERT INTO data_manager.jobs(id,kind,status,started_at,finished_at,operation_key,metadata) VALUES($1::uuid,'configuration-maintenance','ok',$4::text::timestamptz,$4::text::timestamptz,$2,$3::text::jsonb)",
            [
              receipt.fenceId,
              verified.grant.execution.operationKey,
              canonicalJson({ configurationMaintenance: metadata }),
              new Date(owned.preparedAt).toISOString(),
            ],
          );
        });
        metadata.guardState = "prepared";
        write(owned);
        await sql.transaction(async (tx) => {
          await lock(tx);
          const current = await row(tx, input.maintenanceId);
          if (!current || canonicalJson(current.receipt) !== canonicalJson(receipt))
            throw Error("Configuration fence preparation CAS conflict");
          await tx.unsafe(
            "UPDATE data_manager.jobs SET metadata=$2::text::jsonb,ownership_version=ownership_version+1 WHERE id=$1::uuid",
            [receipt.fenceId, canonicalJson({ configurationMaintenance: metadata })],
          );
        });
        startup = "fenced";
        return receipt;
      });
    },
    async inspect(maintenanceId: string, rawHeaders: readonly string[]) {
      const header = rawHeaders.filter(
        (_, index) =>
          index % 2 === 0 &&
          rawHeaders[index]?.toLowerCase() === "x-openmapx-configuration-fence-witness",
      );
      if (header.length !== 1) throw Error("Purpose-bound agent fence witness required");
      const index = rawHeaders.findIndex(
          (name, i) =>
            i % 2 === 0 && name.toLowerCase() === "x-openmapx-configuration-fence-witness",
        ),
        encoded = rawHeaders[index + 1];
      if (!encoded || encoded.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(encoded))
        throw Error("Invalid fence witness");
      const witness = verifyControl(
          local.publicKeys["ops-agent"],
          "openmapx-configuration-fence-inspect-v1",
          JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
          inspectWitnessSchema,
        ),
        now = Date.now();
      if (
        witness.installationId !== installation.installationId ||
        witness.maintenanceId !== maintenanceId ||
        witness.issuedAt > now ||
        witness.expiresAt <= now ||
        witness.expiresAt - witness.issuedAt > 15000
      )
        throw Error("Expired or foreign fence witness");
      let saved = await row(sql, maintenanceId);
      if (!saved) return null;
      let proof =
        saved.guardState === "settled" && saved.settlementControl
          ? signedMirrorData(maintenanceId).parsed
          : mirror(maintenanceId);
      if (
        saved.receipt.candidateId !== witness.candidateId ||
        proof.ownerCertificateDigest !== witness.ownerCertificateDigest
      )
        throw Error("Configuration guard recovery required");
      if (saved.guardState === "settled" && saved.settlementControl && saved.settlement) {
        await recoverCommittedConfigurationFenceSettlement(
          dataConfigurationFenceSettleSchema.parse(saved.settlement),
        );
        saved = await row(sql, maintenanceId);
        if (!saved) throw Error("Original settled SQL source missing");
        proof = mirror(maintenanceId);
      }
      const recovery =
        saved.guardState === "prepared"
          ? await observeUnsettledConfigurationFenceSettlement(maintenanceId)
          : null;
      if (recovery) proof = mirror(maintenanceId);
      if (canonicalJson(proof.metadata) !== canonicalJson(saved))
        throw Error("Configuration guard recovery required");
      const anchored = inspectArtifactDelegation({
        dataRoot: local.dataRoot,
        assertion: proof.prepareAssertion,
        installation,
      });
      if (
        anchored.ownerCertificateDigest !== witness.ownerCertificateDigest ||
        controlDigest(anchored.parent) !== controlDigest(saved.receipt.ownerPrepare)
      )
        throw Error("Original owner certificate changed");
      // Verify its still-anchored original owner certificate without granting a mutation.
      const owned = mirrors.get(maintenanceId);
      if (
        !owned ||
        controlDigest(owned.metadata.receipt.ownerPrepare) !==
          controlDigest(saved.receipt.ownerPrepare)
      )
        throw Error("Original fence owner required");
      return recovery ?? saved.settlementControl?.tuple.result ?? saved.receipt;
    },
    async settle(value: DataConfigurationFenceSettle, rawHeaders: readonly string[]) {
      const input = dataConfigurationFenceSettleSchema.parse(value),
        peer = await verifyConfigurationFenceSettlementControl(input, rawHeaders),
        adoption = await adoptConfigurationFenceSettlementControl(peer);
      try {
        return adoption.runOriginalGuardTransition
          ? await adoption.runOriginalGuardTransition()
          : await adoption.inspect();
      } finally {
        await adoption.close();
      }
    },
  };
}

export function dataFenceTerminalDigest(receipt: DataConfigurationFenceReceipt) {
  return controlDigest({ version: 1, receipt: dataConfigurationFenceReceiptSchema.parse(receipt) });
}
/** Fixed SQL-journal retention adapter. Only a fully settled logical guard may
 * retire its original prepared canonical receipt and original terminal time. */
export function verifyRetainedDataFenceTerminal(
  installation: ControlInstallation,
  execution: import("../ops/execution-ref").ExecutionRef,
  raw: Record<string, unknown>,
) {
  const local = installationState(installation),
    metadata = z
      .object({ configurationMaintenance: metadataSchema })
      .parse(raw.metadata).configurationMaintenance;
  const proof = verifyControl(
    installation.publicKey,
    "openmapx-data-configuration-fence-v1",
    readPrivateRecord(
      local,
      "configuration-maintenance",
      `${metadata.receipt.maintenanceId}.json`,
      65536,
    ),
    mirrorSchema,
  );
  if (
    metadata.guardState !== "settled" ||
    canonicalJson(metadata) !== canonicalJson(proof.metadata) ||
    raw.id !== execution.executionId ||
    raw.operation_key !== execution.operationKey ||
    retainedDataDatabaseTimestamp(raw.finished_at).getTime() !== proof.preparedAt
  )
    throw Error("Settled original logical guard required");
  const effect = verifyControl(
    installation.publicKey,
    "openmapx-control-settlement-v1",
    readPrivateRecord(local, "effects", `${execution.operationKey}.json`, 65536),
    z
      .object({
        identity: executionRefSchema,
        receipt: z.object({
          kind: z.literal("data-configuration-fence"),
          receipt: dataConfigurationFenceReceiptSchema,
          guardDigest: z.string(),
        }),
      })
      .passthrough(),
  );
  const original = {
    ...proof,
    metadata: {
      version: 1 as const,
      guardState: "prepared" as const,
      receipt: effect.receipt.receipt,
      input: metadata.input,
      ...(metadata.settlementReservation
        ? { settlementReservation: metadata.settlementReservation }
        : {}),
    },
  };
  if (
    canonicalJson(effect.identity) !== canonicalJson(execution) ||
    controlDigest(original) !== effect.receipt.guardDigest ||
    effect.receipt.receipt.state !== "prepared" ||
    effect.receipt.receipt.sequence !== 0 ||
    canonicalJson({ ...metadata.receipt, state: "prepared", sequence: 0 }) !==
      canonicalJson(effect.receipt.receipt)
  )
    throw Error("Original logical guard commitment changed");
  const commitment = verifyControl(
      installation.publicKey,
      "openmapx-data-fence-terminal-v1",
      readPrivateRecord(local, "observations", `terminal-${execution.operationKey}.json`, 8192),
      fenceTerminalSchema,
    ),
    authority = executionAuthorityState(restoreAdmittedControlExecution(installation, execution));
  if (
    commitment.phase !== "canonical" ||
    commitment.admissionDigest !== authority.receiptDigest ||
    canonicalJson(commitment.execution) !== canonicalJson(execution) ||
    commitment.terminalDigest !== dataFenceTerminalDigest(effect.receipt.receipt) ||
    commitment.terminalAt !== proof.preparedAt
  )
    throw Error("Original logical guard terminal commitment required");
  verifyControlEffectSettlement(installation, execution);
  const control = metadata.settlementControl
    ? readPreparedConfigurationSettlementRetirement(installation, proof.origin)
    : null;
  return {
    digest: commitment.terminalDigest,
    terminalAt: commitment.terminalAt,
    retentionAt: Math.max(commitment.terminalAt, control?.terminalAt ?? 0),
  };
}

export function dataFenceRetirementTuple(raw: Record<string, unknown>) {
  const metadata = z
    .object({ configurationMaintenance: metadataSchema })
    .parse(raw.metadata).configurationMaintenance;
  if (metadata.guardState !== "settled") throw Error("Unsettled guard cannot retire");
  if (
    metadata.settlementControl &&
    Date.now() - metadata.settlementControl.tuple.terminalAt < 72 * 3600000
  )
    throw Error("Original logical control retention floor not reached");
  return {
    digest: dataFenceTerminalDigest({ ...metadata.receipt, state: "prepared", sequence: 0 }),
    terminalAt: retainedDataDatabaseTimestamp(raw.finished_at).getTime(),
  };
}

export function verifyRetainedDataFenceRefusal(
  installation: ControlInstallation,
  execution: import("../ops/execution-ref").ExecutionRef,
) {
  const local = installationState(installation),
    effect = verifyControl(
      installation.publicKey,
      "openmapx-control-settlement-v1",
      readPrivateRecord(local, "effects", `${execution.operationKey}.json`, 65536),
      z
        .object({
          identity: executionRefSchema,
          outcome: z.literal("failed_without_effect"),
          publication: z.literal("not_started"),
          receipt: z.strictObject({
            kind: z.literal("data-configuration-fence-refused"),
            maintenanceId: z.uuid(),
            reason: z.enum(["busy", "capacity"]),
          }),
        })
        .passthrough(),
    ),
    commitment = verifyControl(
      installation.publicKey,
      "openmapx-data-fence-terminal-v1",
      readPrivateRecord(local, "observations", `terminal-${execution.operationKey}.json`, 8192),
      fenceTerminalSchema,
    ),
    authority = executionAuthorityState(restoreAdmittedControlExecution(installation, execution));
  if (
    canonicalJson(effect.identity) !== canonicalJson(execution) ||
    canonicalJson(commitment.execution) !== canonicalJson(execution) ||
    commitment.phase !== "canonical" ||
    commitment.admissionDigest !== authority.receiptDigest ||
    commitment.terminalDigest !== controlDigest({ version: 1, refused: effect.receipt })
  )
    throw Error("Original configuration refusal commitment required");
  verifyControlEffectSettlement(installation, execution);
  return {
    digest: commitment.terminalDigest,
    terminalAt: commitment.terminalAt,
    receipt: effect.receipt,
    effectReceiptDigest: controlDigest(effect.receipt),
    effectSettlementDigest: controlDigest(effect),
  };
}
