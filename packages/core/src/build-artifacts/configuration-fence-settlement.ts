/** Closed source construction for fixed-reference settlement. This stage
 * reads the actual original owner/root/family; it neither publishes capacity
 * nor produces final/dispatch authority. */

import { canonicalJson, opsOperationFingerprint } from "../ops/fingerprint";
import {
  type DataConfigurationFencePrepare,
  dataConfigurationFencePrepareSchema,
} from "../services/data-manager/contracts/configuration-maintenance";
import { inspectControlChildPublication } from "./child-phase";
import { assertConfigurationSettlementPacketBudget } from "./configuration-fence-settlement-budget";
import {
  configurationSettlementRecordDescriptors,
  readConfigurationSettlementCell,
  writeConfigurationSettlementCell,
} from "./configuration-fence-settlement-cells";
import {
  configurationDmCapacityCellSchema,
  configurationSettlementCapacitySchema,
  configurationSettlementControlCellSchema,
  configurationSettlementDomains,
  configurationSettlementOwnerIdentitySchema,
  configurationSettlementReservationProjectionSchema,
  deriveConfigurationFenceSettlementId,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import { configurationMaintenanceOwnerRecordSchema } from "./configuration-maintenance-owner-records";
import {
  assertControlExecutionForward,
  type ControlInstallation,
  controlChildOperationKey,
  controlPeerState,
  executionAuthorityState,
  installationState,
  readControlExecutionWitness,
  readPrivateRecord,
  type VerifiedControlPeer,
  type VerifiedExecutionAuthority,
  withPrivateEffectWriter,
} from "./control-authority";
import { controlDigest, signControl, uuid, verifyControl } from "./control-records";
import { AnchoredDirectory } from "./filesystem";
import {
  assertFixedConfigurationMaintenancePlan,
  type FixedConfigurationMaintenancePlan,
} from "./fixed-configuration-maintenance";
import {
  completeConfigurationSettlementFamilyReservation,
  readConfigurationSettlementFamilySlot,
  reserveConfigurationSettlementFamilySlot,
  retainedConfigurationMaintenanceFamilyMember,
  verifyFamilyOwnedRecord,
  verifyPublishedConfigurationMaintenanceFamilyMember,
  verifyPublishedDmConfigurationSettlementSlots,
} from "./retention-family";
import {
  closeArtifactTargetLeaseHandle,
  configurationMaintenanceTargetOwner,
  inspectArtifactDelegation,
  restoreArtifactTargetLeaseForSettlement,
  withConfigurationMaintenanceReservationPublication,
} from "./target-lease";

declare const reservationBrand: unique symbol;
export type OwnedConfigurationSettlementReservation = Readonly<{ [reservationBrand]: true }>;
const reservations = new WeakMap<
  OwnedConfigurationSettlementReservation,
  {
    authority: VerifiedExecutionAuthority;
    projection: ReturnType<typeof configurationSettlementReservationProjectionSchema.parse>;
    signedProjection: ReturnType<
      typeof signControl<
        ReturnType<typeof configurationSettlementReservationProjectionSchema.parse>
      >
    >;
    identity: ReturnType<typeof configurationSettlementOwnerIdentitySchema.parse>;
    projectionDigest: string;
    ownerRecordDigest: string;
    plan: FixedConfigurationMaintenancePlan;
  }
>();
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export function ownedConfigurationSettlementReservationState(
  value: OwnedConfigurationSettlementReservation,
  authority: VerifiedExecutionAuthority,
) {
  const state = reservations.get(value);
  if (!state || state.authority !== authority)
    throw Error("Actual original settlement reservation required");
  executionAuthorityState(authority);
  return state;
}
export function prepareOwnedConfigurationSettlementReservation(
  authority: VerifiedExecutionAuthority,
  maintenanceId: string,
): OwnedConfigurationSettlementReservation {
  const state = executionAuthorityState(authority);
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    state.installation.fixedChildId ||
    state.installation.installation.role !== "ops-agent" ||
    !state.origin
  )
    throw Error("Original maintenance owner required");
  assertControlExecutionForward(authority);
  const name = `${uuid.parse(maintenanceId)}.json`;
  const raw = readPrivateRecord(state.installation, "configuration-maintenance", name);
  const owner = verifyControl(
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
    owner.plan.operation.maintenanceId !== maintenanceId ||
    owner.admissionDigest !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution) ||
    canonicalJson(owner.origin) !== canonicalJson(state.origin) ||
    canonicalJson(owner.plan.reservations) !== canonicalJson(state.reservations) ||
    owner.receipt.state !== "preparing" ||
    owner.guardSource ||
    opsOperationFingerprint(owner.plan.operation) !== state.execution.operationFingerprint
  )
    throw Error("Original pre-effect settlement reservation source required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    const root = configurationMaintenanceTargetOwner(lease),
      plan = owner.plan;
    if (
      owner.rootCertificateDigest !== root.certificateDigest ||
      canonicalJson(root.serviceIds) !== canonicalJson(plan.serviceIds)
    )
      throw Error("Original maintenance root certificate changed");
    const reservation = state.reservations.find(
      (value) => value.phase === "configuration-fence-settle",
    );
    const operation = { kind: "configuration-maintenance.settle" as const, ...plan.dmSettle };
    if (
      !reservation ||
      reservation.operationFingerprint !== controlDigest(operation) ||
      plan.dmSettle.settlementId !==
        deriveConfigurationFenceSettlementId({
          installationId: owner.installationId,
          ownerPrepare: state.execution,
          maintenanceId,
          candidateId: plan.operation.candidateId,
          planDigest: plan.planDigest,
        })
    )
      throw Error("Root-fixed settlement reference mismatch");
    const identity = configurationSettlementOwnerIdentitySchema.parse({
      installationId: owner.installationId,
      origin: state.origin,
      ownerPrepare: state.execution,
      admissionDigest: state.receiptDigest,
      rootCertificateDigest: root.certificateDigest,
      maintenanceId,
      candidateId: plan.operation.candidateId,
      planDigest: plan.planDigest,
      settlementId: plan.dmSettle.settlementId,
    });
    const issuerMembership = retainedConfigurationMaintenanceFamilyMember(
      state.installation,
      state.origin,
      state.execution,
    );
    if (issuerMembership.rootAdmissionDigest !== state.receiptDigest)
      throw Error("Original issuer admission changed");
    const projection = configurationSettlementReservationProjectionSchema.parse({
      version: 2,
      purpose: "configuration-fence-settlement-reservation",
      installationId: owner.installationId,
      origin: state.origin,
      ownerPrepare: state.execution,
      rootAdmissionDigest: state.receiptDigest,
      rootCertificateDigest: root.certificateDigest,
      maintenanceId,
      candidateId: plan.operation.candidateId,
      planDigest: plan.planDigest,
      settlementId: plan.dmSettle.settlementId,
      reservation,
      operation,
      reservationDigest: settlementRecordDigest(
        configurationSettlementDomains.reservationTuple,
        reservation,
      ),
      issuerMembership,
    });
    const signedProjection = signControl(
      state.installation.privateKey,
      configurationSettlementDomains.signedProjection,
      projection,
    );
    const value = Object.freeze({}) as OwnedConfigurationSettlementReservation;
    reservations.set(
      value,
      Object.freeze({
        authority,
        projection: freeze(projection),
        signedProjection: freeze(signedProjection),
        identity: freeze(identity),
        projectionDigest: settlementRecordDigest(
          configurationSettlementDomains.projection,
          projection,
        ),
        ownerRecordDigest: controlDigest(raw),
        plan: freeze(plan),
      }),
    );
    return value;
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** Source publisher has no caller address, path, digest or outcome arguments.
 * All fixed sender cells and its intent are retained before exposing the exact
 * pending projection. Partial reservation stays indexed and blocks retirement. */
export function publishConfigurationSettlementReservationProjection(
  authority: VerifiedExecutionAuthority,
  maintenanceId: string,
): void {
  const prepared = prepareOwnedConfigurationSettlementReservation(authority, maintenanceId),
    source = ownedConfigurationSettlementReservationState(prepared, authority),
    owner = executionAuthorityState(authority),
    projection = source.projection;
  const prepare = owner.reservations.find((value) => value.phase === "configuration-fence");
  if (!prepare || !owner.origin) throw Error("Original PREPARE reservation required");
  const descriptors = configurationSettlementRecordDescriptors(
    projection,
    prepare.execution.operationKey,
  ).sender;
  withConfigurationMaintenanceReservationPublication(authority, () => {
    const raw = readPrivateRecord(
      owner.installation,
      "configuration-maintenance",
      `${uuid.parse(maintenanceId)}.json`,
    );
    if (
      controlDigest(raw) !== source.ownerRecordDigest ||
      inspectControlChildPublication(authority, prepare).publication.state !== "unissued"
    )
      throw Error("Maintenance owner/issuance changed before settlement reservation");
    assertConfigurationSettlementPacketBudget(source.plan, projection, source.signedProjection);
    const slot = reserveConfigurationSettlementFamilySlot(
      owner.installation,
      projection,
      source.projectionDigest,
      undefined,
      descriptors,
    );
    for (const descriptor of descriptors) {
      const value = descriptor.name.endsWith(".configuration-settlement-control.json")
        ? signControl(owner.installation.privateKey, configurationSettlementDomains.control, {
            version: 2 as const,
            projection: source.signedProjection,
            binding: null,
          })
        : descriptor.name.endsWith(".configuration-settlement.json")
          ? signControl(owner.installation.privateKey, configurationSettlementDomains.reference, {
              version: 2 as const,
              phase: "uncommitted" as const,
              identity: source.identity,
              referenceOperationFingerprint: projection.reservation.operationFingerprint,
            })
          : null;
      try {
        const existing = readConfigurationSettlementCell(
          owner.installation,
          projection,
          descriptor,
        );
        if (canonicalJson(existing) !== canonicalJson(value))
          throw Error("Original pending settlement cell changed");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || slot.state !== "allocating")
          throw error;
        writeConfigurationSettlementCell(owner.installation, projection, descriptor, value, true);
      }
    }
    completeConfigurationSettlementFamilyReservation(owner.installation, projection);
  });
}
declare const publishedReservationBrand: unique symbol;
export type VerifiedPublishedConfigurationSettlementReservation = Readonly<{
  [publishedReservationBrand]: true;
}>;
const publishedReservations = new WeakMap<
  VerifiedPublishedConfigurationSettlementReservation,
  {
    installation: ControlInstallation;
    prepareExecution: ReturnType<typeof controlPeerState>["execution"];
    peer: VerifiedControlPeer;
    projection: ReturnType<typeof configurationSettlementReservationProjectionSchema.parse>;
    projectionDigest: string;
    publication: "pending" | "bound" | "unused";
  }
>();
export function publishedConfigurationSettlementReservationState(
  value: VerifiedPublishedConfigurationSettlementReservation,
  installation: ControlInstallation,
) {
  const state = publishedReservations.get(value);
  if (!state || state.installation !== installation)
    throw Error("Verified original published settlement reservation required");
  installationState(installation);
  return state;
}
/** Pinned original PREPARE peer, full body, original reservation preimage and
 * shared issuer membership must all agree BEFORE a receiver reserves slots. */
export function verifyPublishedConfigurationSettlementReservation(
  installation: ControlInstallation,
  peer: VerifiedControlPeer,
  value: DataConfigurationFencePrepare,
): VerifiedPublishedConfigurationSettlementReservation {
  const local = installationState(installation),
    incoming = controlPeerState(peer),
    input = dataConfigurationFencePrepareSchema.parse(value);
  if (
    installation.role !== "data-manager" ||
    local.fixedChildId ||
    incoming.installation !== local ||
    incoming.role !== "ops-agent" ||
    incoming.kind !== "configuration-maintenance.prepare" ||
    incoming.recipient !== "data-manager"
  )
    throw Error("Original DM preparation peer required");
  const grant = inspectArtifactDelegation({
    dataRoot: local.dataRoot,
    assertion: incoming.assertion,
    installation,
  });
  if (
    grant.kind !== incoming.kind ||
    grant.phase !== "configuration-fence" ||
    grant.recipient !== "data-manager" ||
    canonicalJson(grant.execution) !== canonicalJson(incoming.execution) ||
    canonicalJson(grant.parent) !== canonicalJson(input.ownerPrepare) ||
    grant.execution.operationFingerprint !==
      controlDigest({ kind: "configuration-maintenance.prepare", ...input }) ||
    !grant.origin
  )
    throw Error("Original fixed PREPARE reservation mismatch");
  const opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  try {
    const root = own(new AnchoredDirectory(local.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      role = own(executions.directory("ops-agent"));
    const cell = verifyControl(
      local.publicKeys["ops-agent"],
      configurationSettlementDomains.control,
      JSON.parse(
        role
          .read(`${grant.parent.operationKey}.configuration-settlement-control.json`, 8192)
          .toString("utf8"),
      ),
      configurationSettlementControlCellSchema.shape.payload,
    );
    const projection = verifyControl(
      local.publicKeys["ops-agent"],
      configurationSettlementDomains.signedProjection,
      cell.projection,
      configurationSettlementReservationProjectionSchema,
    );
    const witness = readControlExecutionWitness(local, grant.parent, local.publicKeys["ops-agent"]);
    const reservation = projection.reservation;
    if (
      projection.installationId !== installation.installationId ||
      canonicalJson(projection.origin) !== canonicalJson(grant.origin) ||
      canonicalJson(projection.ownerPrepare) !== canonicalJson(grant.parent) ||
      witness.kind !== "configurationMaintenance.prepare" ||
      canonicalJson(witness.origin) !== canonicalJson(grant.origin) ||
      projection.rootAdmissionDigest !== witness.authorityDigest ||
      projection.issuerMembership.rootAdmissionDigest !== witness.authorityDigest ||
      projection.rootCertificateDigest !== grant.ownerCertificateDigest ||
      projection.maintenanceId !== input.maintenanceId ||
      projection.candidateId !== input.candidateId ||
      projection.planDigest !== input.planDigest ||
      canonicalJson(reservation.serviceIds) !== canonicalJson(grant.serviceIds) ||
      reservation.execution.operationKey !==
        controlChildOperationKey(
          grant.parent.operationKey,
          "configuration-fence-settle",
          reservation.ordinal,
        ) ||
      reservation.operationFingerprint !== controlDigest(projection.operation) ||
      projection.reservationDigest !==
        settlementRecordDigest(configurationSettlementDomains.reservationTuple, reservation) ||
      projection.operation.maintenanceId !== input.maintenanceId ||
      projection.operation.candidateId !== input.candidateId ||
      projection.operation.planDigest !== input.planDigest ||
      projection.operation.settlementId !== projection.settlementId ||
      projection.settlementId !==
        deriveConfigurationFenceSettlementId({
          installationId: installation.installationId,
          ownerPrepare: grant.parent,
          maintenanceId: input.maintenanceId,
          candidateId: input.candidateId,
          planDigest: input.planDigest,
        })
    )
      throw Error("Published original settlement projection changed");
    verifyPublishedConfigurationMaintenanceFamilyMember(
      local,
      grant.origin,
      grant.parent,
      projection.issuerMembership,
    );
    const handle = Object.freeze({}) as VerifiedPublishedConfigurationSettlementReservation;
    publishedReservations.set(
      handle,
      Object.freeze({
        installation,
        prepareExecution: incoming.execution,
        peer,
        projection: freeze(projection),
        projectionDigest: settlementRecordDigest(
          configurationSettlementDomains.projection,
          projection,
        ),
        publication: cell.binding ? "bound" : "unused" in cell ? "unused" : "pending",
      }),
    );
    return handle;
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
declare const capacityRefusalBrand: unique symbol;
export type RefusedConfigurationSettlementCapacity = Readonly<{ [capacityRefusalBrand]: true }>;
const capacityRefusals = new WeakMap<
  RefusedConfigurationSettlementCapacity,
  {
    authority: VerifiedExecutionAuthority;
    source: ReturnType<typeof publishedConfigurationSettlementReservationState>;
  }
>();
export function refusedConfigurationSettlementCapacityState(
  value: RefusedConfigurationSettlementCapacity,
  authority: VerifiedExecutionAuthority,
) {
  const refused = capacityRefusals.get(value),
    owner = executionAuthorityState(authority);
  if (!refused || refused.authority !== authority)
    throw Error("Actual original allocator capacity refusal required");
  const slot = readConfigurationSettlementFamilySlot(owner.installation, refused.source.projection);
  if (
    slot.state !== "capacity_refused" ||
    slot.executionOrdinal !== null ||
    slot.intentOrdinal !== null ||
    slot.executionDigest !== null ||
    slot.controlBindingDigest !== null ||
    !slot.refusalConstraint ||
    slot.allocatedDescriptorDigests.length !== 1
  )
    throw Error("Conclusive original unallocated capacity refusal required");
  return Object.freeze({
    projection: refused.source.projection,
    projectionDigest: refused.source.projectionDigest,
    slot: freeze(slot),
  });
}
/** Actual receiver reservation. Only the original normal PREPARE adopter and
 * the fixed pinned published-source verifier can reach this constructor. It
 * allocates no physical borrower for the later logical control. */
export function reserveReceivedConfigurationSettlementCapacity(
  authority: VerifiedExecutionAuthority,
  verified: VerifiedPublishedConfigurationSettlementReservation,
) {
  const state = executionAuthorityState(authority),
    source = publishedConfigurationSettlementReservationState(
      verified,
      state.installation.installation,
    ),
    installation = state.installation.installation;
  if (
    installation.role !== "data-manager" ||
    state.installation.fixedChildId ||
    state.kind !== "configuration-maintenance.prepare" ||
    canonicalJson(state.execution) !== canonicalJson(source.prepareExecution) ||
    !state.origin ||
    canonicalJson(state.origin) !== canonicalJson(source.projection.origin) ||
    source.publication !== "pending"
  )
    throw Error("Actual original DM PREPARE adopter required for capacity");
  assertControlExecutionForward(authority);
  const raw = readPrivateRecord(
    state.installation,
    "executions",
    `${state.execution.operationKey}.json`,
    65536,
  ) as { payload?: { operation?: unknown } };
  if (!raw.payload?.operation) throw Error("Original DM PREPARE body required");
  const { kind, ...input } = raw.payload.operation as {
    kind?: unknown;
  } & DataConfigurationFencePrepare;
  if (kind !== "configuration-maintenance.prepare")
    throw Error("Original DM PREPARE body required");
  const current = publishedConfigurationSettlementReservationState(
    verifyPublishedConfigurationSettlementReservation(installation, source.peer, input),
    installation,
  );
  if (current.projectionDigest !== source.projectionDigest || current.publication !== "pending")
    throw Error("Original pending settlement source changed");
  const projection = source.projection,
    descriptors = configurationSettlementRecordDescriptors(
      projection,
      state.execution.operationKey,
    ).receiver;
  return withPrivateEffectWriter(state, () => {
    // The fixed compound refusal channel is indexed and fully charged FIRST.
    // Failure to obtain even this channel stays unknown, never a capacity proof.
    const base = reserveConfigurationSettlementFamilySlot(
        state.installation,
        projection,
        source.projectionDigest,
        state.execution,
        descriptors,
        "refusal-channel",
      ),
      channel = descriptors[0]!;
    try {
      const old = configurationDmCapacityCellSchema.parse(
        readConfigurationSettlementCell(state.installation, projection, channel),
      );
      if (old.refusal || old.unused) throw Error("Original DM settlement reservation closed");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || base.state !== "refusal_channel")
        throw error;
      writeConfigurationSettlementCell(
        state.installation,
        projection,
        channel,
        { version: 2, capacity: null, refusal: null, unused: null },
        true,
      );
    }
    const slot = reserveConfigurationSettlementFamilySlot(
      state.installation,
      projection,
      source.projectionDigest,
      state.execution,
      descriptors,
    );
    if (slot.state === "capacity_refused") {
      const refused = Object.freeze({}) as RefusedConfigurationSettlementCapacity;
      capacityRefusals.set(refused, { authority, source });
      refusedConfigurationSettlementCapacityState(refused, authority);
      return refused;
    }
    for (const descriptor of descriptors) {
      const value = descriptor.name.endsWith("-capacity.json")
        ? configurationDmCapacityCellSchema.parse({
            version: 2,
            capacity: null,
            refusal: null,
            unused: null,
          })
        : null;
      try {
        const existing = readConfigurationSettlementCell(
          state.installation,
          projection,
          descriptor,
        );
        if (descriptor.name.endsWith("-capacity.json")) {
          const old = configurationDmCapacityCellSchema.parse(existing);
          if (old.refusal || old.unused) throw Error("Original DM settlement reservation closed");
        } else if (existing !== null) throw Error("Original DM settlement control already bound");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || slot.state !== "allocating")
          throw error;
        writeConfigurationSettlementCell(state.installation, projection, descriptor, value, true);
      }
    }
    const reserved = completeConfigurationSettlementFamilyReservation(
        state.installation,
        projection,
      ),
      capacity = configurationSettlementCapacitySchema.parse({
        version: 2,
        installationId: installation.installationId,
        origin: projection.origin,
        ownerPrepareDigest: controlDigest(projection.ownerPrepare),
        settlementId: projection.settlementId,
        proposedExecutionAddress: projection.reservation.execution,
        reservedExecutionOrdinal: reserved.executionOrdinal,
        reservedIntentOrdinal: reserved.intentOrdinal,
        recordDescriptorsDigest: reserved.recordDescriptorsDigest,
        maxBytes: descriptors.reduce((sum, descriptor) => sum + descriptor.cap, 0),
        projectionDigest: source.projectionDigest,
        reservationDigest: projection.reservationDigest,
      }),
      signed = signControl(
        state.installation.privateKey,
        configurationSettlementDomains.capacity,
        capacity,
      ),
      descriptor = descriptors[0]!,
      old = configurationDmCapacityCellSchema.parse(
        readConfigurationSettlementCell(state.installation, projection, descriptor),
      );
    if (old.capacity && canonicalJson(old.capacity) !== canonicalJson(signed))
      throw Error("Original DM capacity certificate changed");
    writeConfigurationSettlementCell(state.installation, projection, descriptor, {
      ...old,
      capacity: signed,
    });
    return freeze({
      capacity,
      capacityDigest: settlementRecordDigest(configurationSettlementDomains.capacity, capacity),
    });
  });
}
declare const dmCapacityBrand: unique symbol;
export type VerifiedPublishedConfigurationSettlementCapacity = Readonly<{
  [dmCapacityBrand]: true;
}>;
const dmCapacities = new WeakMap<
  VerifiedPublishedConfigurationSettlementCapacity,
  {
    authority: VerifiedExecutionAuthority;
    projectionDigest: string;
    capacityDigest: string;
    signed: NonNullable<ReturnType<typeof configurationDmCapacityCellSchema.parse>["capacity"]>;
  }
>();
export function publishedConfigurationSettlementCapacityState(
  value: VerifiedPublishedConfigurationSettlementCapacity,
  authority: VerifiedExecutionAuthority,
) {
  const state = dmCapacities.get(value);
  if (!state || state.authority !== authority)
    throw Error("Actual original published DM capacity required");
  executionAuthorityState(authority);
  return state;
}
/** Only pinned DM source bytes plus the original shared slot preimages make a
 * preparation-capacity proof. Receipt JSON or a claimed ready flag cannot. */
export function verifyPublishedConfigurationSettlementCapacity(
  authority: VerifiedExecutionAuthority,
  maintenanceId: string,
): VerifiedPublishedConfigurationSettlementCapacity {
  const source = ownedConfigurationSettlementReservationState(
      prepareOwnedConfigurationSettlementReservation(authority, maintenanceId),
      authority,
    ),
    state = executionAuthorityState(authority),
    projection = source.projection,
    prepare = state.reservations.find((value) => value.phase === "configuration-fence");
  if (!prepare) throw Error("Original DM preparation reservation missing");
  const descriptors = configurationSettlementRecordDescriptors(
      projection,
      prepare.execution.operationKey,
    ).receiver,
    opened: AnchoredDirectory[] = [],
    own = (dir: AnchoredDirectory) => {
      opened.push(dir);
      return dir;
    };
  try {
    const root = own(new AnchoredDirectory(state.installation.dataRoot)),
      control = own(root.directory(".admin-target-control")),
      executions = own(control.directory("executions")),
      dm = own(executions.directory("data-manager")),
      bytes = dm.read(descriptors[0]!.name, descriptors[0]!.cap);
    if (bytes.length !== descriptors[0]!.cap)
      throw Error("Original DM compound capacity cell width changed");
    const cell = configurationDmCapacityCellSchema.parse(JSON.parse(bytes.toString("utf8")));
    if (!cell.capacity || cell.refusal || cell.unused)
      throw Error("Conclusive live DM capacity certificate required");
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
      capacity.maxBytes !== descriptors.reduce((sum, descriptor) => sum + descriptor.cap, 0)
    )
      throw Error("Original DM capacity binding changed");
    verifyPublishedDmConfigurationSettlementSlots(state.installation, projection, capacity);
    const proof = Object.freeze({}) as VerifiedPublishedConfigurationSettlementCapacity;
    dmCapacities.set(
      proof,
      Object.freeze({
        authority,
        projectionDigest: source.projectionDigest,
        capacityDigest: settlementRecordDigest(configurationSettlementDomains.capacity, capacity),
        signed: freeze(cell.capacity),
      }),
    );
    return proof;
  } finally {
    for (const dir of opened.reverse()) dir.close();
  }
}
