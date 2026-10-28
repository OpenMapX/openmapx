/** Cross-role NoGuard source observations. These handles verify original
 * publications; they grant no forward operation or physical lease. */

import { configurationMaintenancePrepareSchema } from "../ops/configuration-maintenance";
import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import { lookupControlChildPhaseAttempt, lookupControlChildPhaseBinding } from "./child-phase";
import {
  configurationSettlementRecordDescriptors,
  readConfigurationSettlementCell,
} from "./configuration-fence-settlement-cells";
import {
  configurationDmCapacityCellSchema,
  configurationDmNoGuardRefusalSchema,
  configurationSettlementCapacitySchema,
  configurationSettlementControlCellSchema,
  configurationSettlementDomains,
  configurationSettlementReservationProjectionSchema,
  configurationUnusedCapacityConfirmationSchema,
  configurationUnusedCapacityIntentSchema,
  deriveConfigurationFenceSettlementId,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import { configurationMaintenanceOwnerRecordSchema } from "./configuration-maintenance-owner-records";
import {
  executionAuthorityState,
  readControlExecutionWitness,
  readPrivateRecord,
  type VerifiedExecutionAuthority,
} from "./control-authority";
import { controlDigest, verifyControl } from "./control-records";
import { AnchoredDirectory } from "./filesystem";
import { assertFixedConfigurationMaintenancePlan } from "./fixed-configuration-maintenance";
import {
  retainedConfigurationMaintenanceFamilyMember,
  verifyFamilyOwnedRecord,
  verifyPublishedUnusedDmConfigurationSettlementSlots,
} from "./retention-family";
import {
  closeArtifactTargetLeaseHandle,
  configurationMaintenanceTargetOwner,
  inspectArtifactTargetLeaseChildSettlement,
  restoreArtifactTargetLeaseForSettlement,
} from "./target-lease";

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function withObservedOwner<T>(
  authority: VerifiedExecutionAuthority,
  run: (source: {
    state: ReturnType<typeof executionAuthorityState>;
    owner: ReturnType<typeof configurationMaintenanceOwnerRecordSchema.parse>;
    ownerRecordDigest: string;
    projection: ReturnType<typeof configurationSettlementReservationProjectionSchema.parse>;
    projectionDigest: string;
    prepare: NonNullable<ReturnType<typeof lookupControlChildPhaseBinding>>;
    lease: ReturnType<typeof restoreArtifactTargetLeaseForSettlement>;
  }) => T,
): T {
  const state = executionAuthorityState(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    state.installation.installation.role !== "ops-agent" ||
    state.installation.fixedChildId ||
    !state.origin
  )
    throw Error("Original maintenance NoGuard observer required");
  const admitted = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: unknown; parent?: unknown } },
    operation = configurationMaintenancePrepareSchema.parse(admitted.payload?.operation),
    name = `${operation.maintenanceId}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name),
    owner = verifyControl(
      state.installation.installation.publicKey,
      "openmapx-configuration-maintenance-owner-v2",
      raw,
      configurationMaintenanceOwnerRecordSchema,
    );
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "configuration-maintenance", name, container: "" },
    canonicalJson(raw),
  );
  assertFixedConfigurationMaintenancePlan(
    owner.plan,
    state.installation.installation.installationId,
  );
  if (
    owner.admissionDigest !== state.receiptDigest ||
    canonicalJson(owner.origin) !== canonicalJson(state.origin) ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    canonicalJson(owner.plan.operation) !== canonicalJson(operation) ||
    canonicalJson(owner.plan.apiParent) !== canonicalJson(admitted.payload?.parent) ||
    canonicalJson(owner.plan.reservations) !== canonicalJson(state.reservations) ||
    opsOperationFingerprint(operation) !== state.execution.operationFingerprint ||
    owner.guardSource ||
    owner.receipt.dmFence ||
    owner.receipt.decision?.decision === "continue" ||
    owner.receipt.generation !== "not_started"
  )
    throw Error("Original never-prepared owner source required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  try {
    const root = configurationMaintenanceTargetOwner(lease);
    if (
      root.certificateDigest !== owner.rootCertificateDigest ||
      canonicalJson(root.serviceIds) !== canonicalJson(owner.plan.serviceIds)
    )
      throw Error("Original NoGuard physical root changed");
    const data = own(new AnchoredDirectory(state.installation.dataRoot)),
      control = own(data.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      role = own(executions.directory("ops-agent")),
      cell = verifyControl(
        state.installation.installation.publicKey,
        configurationSettlementDomains.control,
        JSON.parse(
          role
            .read(`${state.execution.operationKey}.configuration-settlement-control.json`, 8192)
            .toString("utf8"),
        ),
        configurationSettlementControlCellSchema.shape.payload,
      ),
      projection = verifyControl(
        state.installation.installation.publicKey,
        configurationSettlementDomains.signedProjection,
        cell.projection,
        configurationSettlementReservationProjectionSchema,
      ),
      dmPrepare = owner.plan.reservations.find((value) => value.phase === "configuration-fence"),
      settle = owner.plan.reservations.find(
        (value) => value.phase === "configuration-fence-settle",
      );
    if (
      !dmPrepare ||
      !settle ||
      cell.binding ||
      projection.rootAdmissionDigest !== state.receiptDigest ||
      projection.rootCertificateDigest !== root.certificateDigest ||
      canonicalJson(projection.origin) !== canonicalJson(state.origin) ||
      canonicalJson(projection.ownerPrepare) !== canonicalJson(state.execution) ||
      projection.maintenanceId !== operation.maintenanceId ||
      projection.candidateId !== operation.candidateId ||
      projection.planDigest !== owner.plan.planDigest ||
      canonicalJson(projection.reservation) !== canonicalJson(settle) ||
      canonicalJson(projection.operation) !==
        canonicalJson({ kind: "configuration-maintenance.settle", ...owner.plan.dmSettle }) ||
      projection.settlementId !==
        deriveConfigurationFenceSettlementId({
          installationId: owner.installationId,
          ownerPrepare: state.execution,
          maintenanceId: operation.maintenanceId,
          candidateId: operation.candidateId,
          planDigest: owner.plan.planDigest,
        }) ||
      canonicalJson(projection.issuerMembership) !==
        canonicalJson(
          retainedConfigurationMaintenanceFamilyMember(
            state.installation,
            state.origin,
            state.execution,
          ),
        )
    )
      throw Error("Original NoGuard reservation preimage changed");
    const descriptors = configurationSettlementRecordDescriptors(
      projection,
      dmPrepare.execution.operationKey,
    );
    readConfigurationSettlementCell(state.installation, projection, descriptors.sender[2]!);
    const prepare = lookupControlChildPhaseBinding(authority, dmPrepare),
      attempted = lookupControlChildPhaseAttempt(authority, dmPrepare);
    if (
      !prepare ||
      !attempted ||
      attempted.channel !== "delegation" ||
      canonicalJson(prepare.child.execution) !== canonicalJson(attempted.execution)
    )
      throw Error("Original issued normal DM PREPARE required");
    return run({
      state,
      owner,
      ownerRecordDigest: controlDigest(raw),
      projection,
      projectionDigest: settlementRecordDigest(
        configurationSettlementDomains.projection,
        projection,
      ),
      prepare,
      lease,
    });
  } finally {
    for (const directory of opened.reverse()) directory.close();
    closeArtifactTargetLeaseHandle(lease);
  }
}
function dmCell(source: Parameters<Parameters<typeof withObservedOwner>[1]>[0]) {
  const descriptors = configurationSettlementRecordDescriptors(
      source.projection,
      source.prepare.child.execution.operationKey,
    ).receiver,
    opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  try {
    const root = own(new AnchoredDirectory(source.state.installation.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      role = own(executions.directory("data-manager")),
      bytes = role.read(descriptors[0]!.name, 8192);
    if (bytes.length !== 8192) throw Error("Original DM compound NoGuard channel width changed");
    return {
      descriptors,
      cell: configurationDmCapacityCellSchema.parse(JSON.parse(bytes.toString("utf8"))),
    };
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
declare const refusalBrand: unique symbol;
export type VerifiedPublishedDmNoGuardRefusal = Readonly<{ [refusalBrand]: true }>;
const refusals = new WeakMap<
  VerifiedPublishedDmNoGuardRefusal,
  {
    authority: VerifiedExecutionAuthority;
    ownerRecordDigest: string;
    projectionDigest: string;
    projection: ReturnType<typeof configurationSettlementReservationProjectionSchema.parse>;
    signedRefusal: NonNullable<
      ReturnType<typeof configurationDmCapacityCellSchema.parse>["refusal"]
    >;
    signedCapacity: ReturnType<typeof configurationDmCapacityCellSchema.parse>["capacity"];
  }
>();
export function publishedDmNoGuardRefusalState(
  value: VerifiedPublishedDmNoGuardRefusal,
  authority: VerifiedExecutionAuthority,
) {
  const source = refusals.get(value);
  if (!source || source.authority !== authority)
    throw Error("Actual original DM refusal source required");
  executionAuthorityState(authority);
  return source;
}
export function verifyPublishedDataConfigurationFenceRefusal(
  authority: VerifiedExecutionAuthority,
): VerifiedPublishedDmNoGuardRefusal {
  return withObservedOwner(authority, (source) => {
    const { cell, descriptors } = dmCell(source),
      { projection, state } = source,
      execution = source.prepare.child.execution;
    if (!cell.refusal) throw Error("Original signed DM refusal publication required");
    const refusal = verifyControl(
        state.installation.publicKeys["data-manager"],
        configurationSettlementDomains.refusal,
        cell.refusal,
        configurationDmNoGuardRefusalSchema,
      ),
      witness = readControlExecutionWitness(
        state.installation,
        execution,
        state.installation.publicKeys["data-manager"],
      ),
      child = inspectArtifactTargetLeaseChildSettlement(source.lease, execution);
    if (
      refusal.installationId !== projection.installationId ||
      canonicalJson(refusal.origin) !== canonicalJson(projection.origin) ||
      canonicalJson(refusal.ownerPrepare) !== canonicalJson(projection.ownerPrepare) ||
      refusal.rootAdmissionDigest !== projection.rootAdmissionDigest ||
      refusal.rootCertificateDigest !== projection.rootCertificateDigest ||
      refusal.maintenanceId !== projection.maintenanceId ||
      refusal.candidateId !== projection.candidateId ||
      refusal.planDigest !== projection.planDigest ||
      refusal.settlementId !== projection.settlementId ||
      refusal.projectionDigest !== source.projectionDigest ||
      refusal.reservationDigest !== projection.reservationDigest ||
      canonicalJson(refusal.prepareExecution) !== canonicalJson(execution) ||
      witness.kind !== "configuration-maintenance.prepare" ||
      witness.authorityDigest !== refusal.prepareAdmissionDigest ||
      canonicalJson(witness.origin) !== canonicalJson(projection.origin) ||
      !child ||
      child.outcome !== "failed_without_effect" ||
      child.publication !== "not_started" ||
      child.terminalReceiptDigest !== refusal.effectReceiptDigest ||
      refusal.effectReceiptDigest !== controlDigest(refusal.refusalReceipt) ||
      refusal.effectSettlementDigest !==
        controlDigest({ ...child, receipt: refusal.refusalReceipt }) ||
      refusal.canonicalTerminalDigest !==
        controlDigest({ version: 1, refused: refusal.refusalReceipt })
    )
      throw Error("Original DM canonical refusal/child preimages changed");
    if (cell.capacity) {
      const capacity = verifyControl(
        state.installation.publicKeys["data-manager"],
        configurationSettlementDomains.capacity,
        cell.capacity,
        configurationSettlementCapacitySchema,
      );
      if (
        capacity.installationId !== projection.installationId ||
        canonicalJson(capacity.origin) !== canonicalJson(projection.origin) ||
        capacity.ownerPrepareDigest !== controlDigest(projection.ownerPrepare) ||
        capacity.settlementId !== projection.settlementId ||
        capacity.projectionDigest !== source.projectionDigest ||
        capacity.reservationDigest !== projection.reservationDigest ||
        canonicalJson(capacity.proposedExecutionAddress) !==
          canonicalJson(projection.reservation.execution) ||
        capacity.recordDescriptorsDigest !== controlDigest(descriptors) ||
        capacity.maxBytes !== descriptors.reduce((sum, descriptor) => sum + descriptor.cap, 0) ||
        refusal.capacityReceiptDigest !==
          settlementRecordDigest(configurationSettlementDomains.capacity, capacity)
      )
        throw Error("Original DM refusal capacity preimage changed");
    } else if (
      refusal.capacityReceiptDigest !== null ||
      refusal.refusalReceipt.reason !== "capacity"
    )
      throw Error("Original capacity-null refusal required");
    const value = Object.freeze({}) as VerifiedPublishedDmNoGuardRefusal;
    refusals.set(
      value,
      Object.freeze({
        authority,
        ownerRecordDigest: source.ownerRecordDigest,
        projectionDigest: source.projectionDigest,
        projection: freeze(projection),
        signedRefusal: freeze(cell.refusal),
        signedCapacity: cell.capacity && freeze(cell.capacity),
      }),
    );
    return value;
  });
}
declare const unusedBrand: unique symbol;
export type VerifiedDmUnusedCapacity = Readonly<{ [unusedBrand]: true }>;
const unusedProofs = new WeakMap<
  VerifiedDmUnusedCapacity,
  {
    authority: VerifiedExecutionAuthority;
    refusal: VerifiedPublishedDmNoGuardRefusal;
    signedUnused: NonNullable<ReturnType<typeof configurationDmCapacityCellSchema.parse>["unused"]>;
    intentDigest: string;
    confirmationDigest: string;
  }
>();
export function publishedDmUnusedCapacityState(
  value: VerifiedDmUnusedCapacity,
  authority: VerifiedExecutionAuthority,
) {
  const source = unusedProofs.get(value);
  if (!source || source.authority !== authority)
    throw Error("Actual original DM UNUSED source required");
  publishedDmNoGuardRefusalState(source.refusal, authority);
  return source;
}
export function verifyPublishedUnusedConfigurationCapacity(
  authority: VerifiedExecutionAuthority,
  verifiedRefusal: VerifiedPublishedDmNoGuardRefusal,
): VerifiedDmUnusedCapacity {
  const original = publishedDmNoGuardRefusalState(verifiedRefusal, authority);
  return withObservedOwner(authority, (source) => {
    const { cell, descriptors } = dmCell(source),
      projection = source.projection,
      key = source.state.installation.publicKeys["data-manager"];
    if (
      !cell.unused?.confirmation ||
      canonicalJson(cell.refusal) !== canonicalJson(original.signedRefusal) ||
      canonicalJson(cell.capacity) !== canonicalJson(original.signedCapacity)
    )
      throw Error("Original confirmed DM UNUSED packet required");
    const intent = verifyControl(
        key,
        configurationSettlementDomains.unusedIntent,
        cell.unused.intent,
        configurationUnusedCapacityIntentSchema,
      ),
      confirmation = verifyControl(
        key,
        configurationSettlementDomains.unusedConfirmation,
        cell.unused.confirmation,
        configurationUnusedCapacityConfirmationSchema,
      ),
      capacity = cell.capacity?.payload,
      expectedDescriptors = capacity ? descriptors : [descriptors[0]!],
      intentDigest = settlementRecordDigest(configurationSettlementDomains.unusedIntent, intent),
      expected = {
        executionOrdinal: capacity?.reservedExecutionOrdinal ?? null,
        intentOrdinal: capacity?.reservedIntentOrdinal ?? null,
        recordDescriptorsDigest: controlDigest(descriptors),
        allocatedDescriptorDigests: expectedDescriptors.map((value) => controlDigest(value)).sort(),
        state: "UNUSED",
        intentDigest,
      };
    if (
      intent.installationId !== projection.installationId ||
      canonicalJson(intent.origin) !== canonicalJson(projection.origin) ||
      intent.role !== "data-manager" ||
      intent.ownerPrepareDigest !== controlDigest(projection.ownerPrepare) ||
      intent.prepareExecutionDigest !== controlDigest(source.prepare.child.execution) ||
      intent.settlementId !== projection.settlementId ||
      intent.projectionDigest !== source.projectionDigest ||
      intent.capacityReceiptDigest !== original.signedRefusal.payload.capacityReceiptDigest ||
      intent.sourceProofDigest !==
        settlementRecordDigest(
          configurationSettlementDomains.refusal,
          original.signedRefusal.payload,
        ) ||
      intent.executionOrdinal !== expected.executionOrdinal ||
      intent.intentOrdinal !== expected.intentOrdinal ||
      intent.recordDescriptorsDigest !== expected.recordDescriptorsDigest ||
      canonicalJson(intent.allocatedDescriptorDigests) !==
        canonicalJson(expected.allocatedDescriptorDigests) ||
      confirmation.installationId !== projection.installationId ||
      canonicalJson(confirmation.origin) !== canonicalJson(projection.origin) ||
      confirmation.role !== "data-manager" ||
      confirmation.ownerPrepareDigest !== intent.ownerPrepareDigest ||
      confirmation.settlementId !== projection.settlementId ||
      confirmation.projectionDigest !== source.projectionDigest ||
      confirmation.intentDigest !== intentDigest ||
      confirmation.slotStateDigest !== controlDigest(expected) ||
      confirmation.confirmedAt < intent.createdAt
    )
      throw Error("Original DM UNUSED source preimages changed");
    verifyPublishedUnusedDmConfigurationSettlementSlots(source.state.installation, projection, {
      executionOrdinal: intent.executionOrdinal,
      intentOrdinal: intent.intentOrdinal,
      projectionDigest: intent.projectionDigest,
      intentDigest,
    });
    const value = Object.freeze({}) as VerifiedDmUnusedCapacity;
    unusedProofs.set(
      value,
      Object.freeze({
        authority,
        refusal: verifiedRefusal,
        signedUnused: freeze(cell.unused),
        intentDigest,
        confirmationDigest: settlementRecordDigest(
          configurationSettlementDomains.unusedConfirmation,
          confirmation,
        ),
      }),
    );
    return value;
  });
}
