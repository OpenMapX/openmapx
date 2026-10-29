import { createPrivateKey, type KeyObject, randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { configurationApplyResultSchema, opsOperationSchema } from "../ops/contract";
import {
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
} from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  inspectControlChildPublication,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  prepareControlChildPublication,
  resolveControlChildPlan,
} from "./child-phase";
// biome-ignore-end lint/suspicious/noImportCycles: Same exact deferred guard import.
import { configurationSettlementRecordDescriptors } from "./configuration-fence-settlement-descriptors";
import {
  configurationChildEvidenceSchema,
  configurationCommittedSettlementSchema,
  configurationDmCapacityCellSchema,
  configurationDmNoGuardRefusalSchema,
  configurationIssuedPrepareRefusedProofSchema,
  configurationIssuerUnusedSourceDigest,
  configurationNeverIssuedProofSchema,
  configurationNoGuardBundleSchema,
  configurationNoGuardClosureSchema,
  configurationNoGuardIntentSchema,
  configurationOwnerFinalSchema,
  configurationSettlementAckSchema,
  configurationSettlementAdmissionSchema,
  configurationSettlementCapacitySchema,
  configurationSettlementCommitmentCellSchema,
  configurationSettlementControlCellSchema,
  configurationSettlementControlEnvelopeSchema,
  configurationSettlementEffectSchema,
  configurationSettlementPublishedTerminalSchema,
  configurationSettlementReservationProjectionSchema,
  configurationSettlementSenderAckCellSchema,
  configurationUnusedCapacityConfirmationSchema,
  configurationUnusedCapacityIntentSchema,
  deriveConfigurationFenceSettlementId,
  configurationSettlementDomains as domains,
  settlementRecordDigest,
} from "./configuration-fence-settlement-records";
import {
  assertAppliedConfigurationMaintenanceFinalState,
  assertContainedConfigurationMaintenanceFinalState,
  assertUnusedConfigurationMaintenanceFinalState,
  configurationMaintenanceRuntimeInspectionSchema,
} from "./configuration-maintenance-final-records";
import {
  assertConfigurationMaintenanceDecisionSource,
  configurationMaintenanceDecisionCommitmentDomain,
  configurationMaintenanceDecisionCommitmentPayloadSchema,
  configurationMaintenanceOwnerRecordSchema,
} from "./configuration-maintenance-owner-records";
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  type ArtifactDelegationAssertion,
  type AuthorityState,
  assertControlExecutionForward,
  assertionSchema,
  type ChildSettlement,
  type ControlChildPhase,
  type ControlPlannedChild,
  type ControlRecipient,
  childPhaseKinds,
  childSettlementState,
  configurationMaintenanceChildState,
  controlChildOperationKey,
  controlPeerState,
  encodePrivate,
  executionAuthorityState,
  fixedControlChildId,
  type InstallationState,
  inspectConfigurationPreEffectRefusal,
  installationState,
  newControlKey,
  parseControlAssertion,
  readControlExecutionWitness,
  readPrivateRecord,
  recordLeaseControlAttempt,
  recoveryAuthorityState,
  restoreAdmittedControlExecution,
  retainedControlParent,
  type VerifiedChildSettlement,
  type VerifiedControlPeer,
  type VerifiedExecutionAuthority,
  type VerifiedRecoveryAuthority,
  verifyConfigurationMaintenanceChildTerminal,
  verifyControlEffectSettlement,
  verifyControlPreparedTerminal,
  verifyControlRecoveryAuthority,
  verifyDataControlTerminalWitness,
  verifyDataUpdatePrerequisites,
  withControlDelegationPublication,
  withControlMaintenanceDecisionPublication,
  withControlMaintenanceInitialization,
  withControlMaintenanceNoGuardPublication,
  withControlMaintenanceSettlementPublication,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
// biome-ignore-end lint/suspicious/noImportCycles: Live protocol dependency described above.
import {
  controlDigest,
  controlOriginSchema,
  digest,
  originRecordDomain,
  sameControlOrigin,
  signControl,
  targetSchema,
  uuid,
  validateOriginRecord,
  verifyControl,
} from "./control-records";
import { CONTROL_RETENTION_LIMITS, reserveAuthoritySlot } from "./control-retention";
import {
  dataConfigurationFencePreparedWitnessDomain,
  dataConfigurationFencePreparedWitnessSchema,
} from "./data-configuration-fence-witness-records";
import { AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";
import { assertFixedConfigurationMaintenancePlan } from "./fixed-configuration-maintenance";
import { assertOriginClockForward } from "./retention-clock";
// biome-ignore-start lint/suspicious/noImportCycles: Physical closure, fixed cells and the read-only normal-pull admission observer verify the sole original family index; retirement verifies this same physical owner. These fixed joins run only after initialization.
import {
  assertNoUnissuedConfigurationReceiverPublication,
  enlistFamilyIntent,
  familyRecordWrite,
  hasLocalRetentionFamily,
  markFamilyLeaseReleased,
  readConfigurationSettlementCell,
  readConfigurationSettlementFamilySlot,
  registerFamilyLease,
  reserveControlFamily,
  trackFamilyDirectory,
  verifyCoordinatorPullAdmissionReadOnly,
  verifyFamilyOwnedRecord,
  verifyPublishedBoundDmConfigurationSettlementSlots,
  verifyPublishedUnusedDmConfigurationSettlementSlots,
} from "./retention-family";

// biome-ignore-end lint/suspicious/noImportCycles: Exact deferred original-owner/index guard join.

// biome-ignore lint/suspicious/noImportCycles: Type re-export for the existing shared settlement protocol.
export type { ChildSettlement } from "./control-authority";
export type ArtifactTargetLease = {
  readonly leaseId: string;
  readonly owner: ExecutionRef;
  readonly serviceIds: readonly string[];
  readonly mode: "owner";
};
export type BorrowedArtifactTargetLease = {
  readonly leaseId: string;
  readonly owner: ExecutionRef;
  readonly execution: ExecutionRef;
  readonly serviceIds: readonly string[];
  readonly mode: "borrowed";
};
export type TargetLeaseAuthority = ArtifactTargetLease | BorrowedArtifactTargetLease;
const inode = z.strictObject({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) });
const certificateSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  origin: controlOriginSchema.optional(),
  installationId: uuid,
  leaseId: uuid,
  dataRootIdentity: inode,
  lockIdentities: z.record(z.string(), inode),
  owner: executionRefSchema,
  ownerPublicKey: z.string().max(256),
  serviceIds: targetSchema,
  createdAt: z.number().int().nonnegative().safe(),
});
type Certificate = z.infer<typeof certificateSchema>;
const slotSchema = z.strictObject({
  name: z.string().regex(/^slot-\d{1,4}$/),
  identity: inode,
  generation: uuid.optional(),
});
const releaseProgressSchema = z.strictObject({
  version: z.literal(2),
  phase: z.enum(["planned", "released"]),
  completedTargets: z.number().int().min(0).max(256),
  pending: z.number().int().min(0).max(255).optional(),
  active: z.boolean(),
  activePlanned: z.boolean().optional(),
});
// Previously signed name-list progress remains readable within the same byte bound.
const legacyReleaseProgressSchema = z.strictObject({
  phase: z.enum(["planned", "released"]),
  locks: z.array(z.string()).max(256),
  active: z.boolean(),
  pending: z.string().optional(),
  activePlanned: z.boolean().optional(),
});
const admissionSlotSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  leaseId: uuid,
  certificateDigest: digest,
  active: slotSchema,
  history: slotSchema,
  release: z.union([releaseProgressSchema, legacyReleaseProgressSchema]).optional(),
  releasedAt: z.number().int().positive().safe().optional(),
});
type AdmissionSlots = z.infer<typeof admissionSlotSchema>;

const signedCertificateSchema = z.strictObject({
  payload: certificateSchema,
  signature: z.string(),
});
const outcomeSchema = z.strictObject({
  identity: executionRefSchema,
  outcome: z.enum(["contained", "committed", "failed_without_effect", "unknown"]),
  publication: z.enum(["not_started", "committed", "unknown"]),
  terminalReceiptDigest: digest,
});
const phaseSchema = z.enum(["held", "cancel_pending", "recovery_required", "settled"]);
const rootSchema = z.strictObject({
  version: z.literal(2).optional(),
  origin: controlOriginSchema.optional(),
  certificate: signedCertificateSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: phaseSchema,
  grantDigests: z.record(uuid, digest),
  settlement: outcomeSchema.nullable(),
});
type RootRecord = z.infer<typeof rootSchema>;
const grantSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  origin: controlOriginSchema.optional(),
  installationId: uuid,
  leaseId: uuid,
  ownerCertificateDigest: digest,
  delegationId: uuid,
  parentNode: uuid.nullable(),
  parent: executionRefSchema,
  child: executionRefSchema,
  childKind: z.string().max(128),
  phase: z.string().max(64),
  ordinal: z.number().int().nonnegative().max(63),
  serviceIds: targetSchema,
  recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
  childPublicKey: z.string().max(256),
  permittedFurtherEdges: z.array(z.string()).max(1),
  depth: z.number().int().min(1).max(2),
});
type Grant = z.infer<typeof grantSchema>;
const childSchema = z.strictObject({
  version: z.literal(2).optional(),
  origin: controlOriginSchema.optional(),
  delegationId: uuid,
  grantDigest: digest,
  execution: executionRefSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: phaseSchema,
  grantDigests: z.record(uuid, digest),
  settlement: outcomeSchema.nullable(),
});
type ChildRecord = z.infer<typeof childSchema>;
const transitionSchema = z.strictObject({
  delegationId: uuid,
  grantDigest: digest,
  sequence: z.literal(1),
  state: z.literal("attempted"),
});
interface State {
  data: AnchoredDirectory;
  control: AnchoredDirectory;
  locks: AnchoredDirectory;
  leases: AnchoredDirectory;
  ledger: AnchoredDirectory;
  installation: InstallationState;
  certificate: Certificate;
  certificateEnvelope: ReturnType<typeof signControl<Certificate>>;
  key: KeyObject;
  node: string | null;
  execution: ExecutionRef;
  authority?: AuthorityState;
  verifiedAuthority?: VerifiedExecutionAuthority;
  closed: boolean;
  journalGuardHeld?: boolean;
  settlementOnly?: boolean;
  slots?: AdmissionSlots;
}
const handles = new WeakMap<object, State>();
declare const maintenanceClosureBrand: unique symbol;
export type ConfigurationMaintenanceClosureObservation = Readonly<{
  [maintenanceClosureBrand]: true;
}>;
const maintenanceClosureObservations = new WeakMap<
  ConfigurationMaintenanceClosureObservation,
  {
    authority: VerifiedExecutionAuthority;
    certificateDigest: string;
    children: Array<{ execution: ExecutionRef; settlement: ChildSettlement; grantDigest: string }>;
  }
>();
export function configurationMaintenanceClosureObservationState(
  value: ConfigurationMaintenanceClosureObservation,
  authority: VerifiedExecutionAuthority,
) {
  const source = maintenanceClosureObservations.get(value);
  if (!source || source.authority !== authority)
    throw Error("Actual original target-tree closure observation required");
  return source;
}
function maintenanceObservationFromTree(
  s: State,
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceClosureObservation {
  const current = tree(s),
    children: Array<{ execution: ExecutionRef; settlement: ChildSettlement; grantDigest: string }> =
      [];
  for (const [id, grant] of current.grants) {
    const child = current.children.get(id);
    if (!child || child.phase !== "settled" || !child.settlement || !knownOutcome(child.settlement))
      throw Error("Every original maintenance descendant must be contained");
    children.push({
      execution: grant.child,
      settlement: child.settlement,
      grantDigest: child.grantDigest,
    });
  }
  const observation = Object.freeze({}) as ConfigurationMaintenanceClosureObservation;
  maintenanceClosureObservations.set(observation, {
    authority,
    certificateDigest: controlDigest(s.certificateEnvelope),
    children,
  });
  return observation;
}
function assertMaintenanceClosureFromTree(s: State, authority: VerifiedExecutionAuthority): void {
  const observation = maintenanceObservationFromTree(s, authority);
  try {
    assertConfigurationMaintenanceRootClosure(authority, observation);
  } finally {
    maintenanceClosureObservations.delete(observation);
  }
}
/** Fixed read-only inspector source, using the same authenticated complete tree
 * as release. It creates no lease, issuer, forward capability or final proof. */
export function observeConfigurationMaintenanceRuntimeTree(
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceClosureObservation {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configurationMaintenance.prepare" ||
    owner.installation.installation.role !== "ops-agent" ||
    owner.installation.fixedChildId
  )
    throw Error("Original maintenance runtime tree required");
  const reference = z
      .strictObject({ leaseId: uuid, certificateDigest: digest })
      .parse(
        readPrivateRecord(
          owner.installation,
          "execution-leases",
          `${owner.execution.operationKey}.json`,
        ),
      ),
    s = openState(owner.installation.dataRoot, reference.leaseId, owner.installation, true);
  try {
    if (
      controlDigest(s.execution) !== controlDigest(owner.execution) ||
      controlDigest(s.certificateEnvelope) !== reference.certificateDigest
    )
      throw Error("Original maintenance runtime certificate changed");
    return guarded(s, () => maintenanceObservationFromTree(s, authority), !s.slots?.release);
  } finally {
    closeState(s);
  }
}
/** Public observation uses the same authenticated tree as the actual release
 * paths. No caller source array/boolean can satisfy the internal predicate. */
export function verifyConfigurationMaintenanceRootClosure(
  authority: VerifiedExecutionAuthority,
): void {
  const owner = executionAuthorityState(authority),
    reference = z
      .strictObject({ leaseId: uuid, certificateDigest: digest })
      .parse(
        readPrivateRecord(
          owner.installation,
          "execution-leases",
          `${owner.execution.operationKey}.json`,
        ),
      ),
    s = openState(owner.installation.dataRoot, reference.leaseId, owner.installation, true);
  try {
    if (
      controlDigest(s.execution) !== controlDigest(owner.execution) ||
      controlDigest(s.certificateEnvelope) !== reference.certificateDigest
    )
      throw Error("Original maintenance observation certificate changed");
    guarded(s, () => assertMaintenanceClosureFromTree(s, authority), !s.slots?.release);
  } finally {
    closeState(s);
  }
}
function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw Error(message);
  return value;
}
function stateOf(lease: TargetLeaseAuthority): State {
  const state = handles.get(lease);
  if (!state || state.closed || (lease.mode === "owner") !== (state.node === null))
    throw Error("Unverified or mixed target lease authority");
  verifyAnchors(state);
  return state;
}
function verifyAnchors(s: State) {
  s.data.check();
  s.ledger.check();
  if (!sameInode(identity(s.data.stat), s.certificate.dataRootIdentity))
    throw Error("Data root physical identity changed");
  for (const id of s.certificate.serviceIds) {
    const lock = s.locks.directory(id);
    try {
      if (
        !sameInode(
          identity(lock.stat),
          required(s.certificate.lockIdentities[id], "Missing certified target inode"),
        )
      )
        throw Error("Target lock inode identity changed");
      if (lock.listBounded(1).length) throw Error("Unexplained nonempty target lock");
    } finally {
      lock.close();
    }
  }
}
function json(dir: AnchoredDirectory, name: string, max = 131072): unknown {
  return JSON.parse(dir.read(name, max).toString("utf8"));
}
function readRoot(s: State): RootRecord {
  return verifyControl(
    s.certificate.ownerPublicKey,
    originRecordDomain("openmapx-lease-owner", json(s.ledger, "owner.json")),
    json(s.ledger, "owner.json"),
    rootSchema,
  );
}
function childDirectory(s: State, kind: "grants" | "children") {
  return s.ledger.directory(kind);
}
function readGrant(s: State, id: string, parentKey: string): Grant {
  const dir = childDirectory(s, "grants");
  try {
    const envelope = z
      .strictObject({ grant: z.unknown(), transition: z.unknown() })
      .parse(json(dir, `${uuid.parse(id)}.json`));
    const grant = verifyControl(
      parentKey,
      originRecordDomain("openmapx-lease-grant", envelope.grant),
      envelope.grant,
      grantSchema,
    );
    const transition = verifyControl(
      parentKey,
      "openmapx-lease-intent-v1",
      envelope.transition,
      transitionSchema,
    );
    if (
      !validateOriginRecord(grant) ||
      !sameControlOrigin(grant.origin, s.certificate.origin) ||
      grant.delegationId !== id ||
      transition.delegationId !== id ||
      transition.grantDigest !== controlDigest(envelope.grant) ||
      grant.ownerCertificateDigest !== controlDigest(s.certificateEnvelope) ||
      grant.installationId !== s.installation.installation.installationId ||
      grant.leaseId !== s.certificate.leaseId
    )
      throw Error("Anchored grant identity mismatch");
    return grant;
  } finally {
    dir.close();
  }
}
function readChild(s: State, grant: Grant): ChildRecord | undefined {
  const dir = childDirectory(s, "children");
  try {
    let raw: unknown;
    try {
      raw = json(dir, `${grant.delegationId}.json`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    const child = verifyControl(
      grant.childPublicKey,
      originRecordDomain("openmapx-lease-child", raw),
      raw,
      childSchema,
    );
    if (
      !validateOriginRecord(child) ||
      !sameControlOrigin(child.origin, grant.origin) ||
      child.delegationId !== grant.delegationId ||
      controlDigest(child.execution) !== controlDigest(grant.child)
    )
      throw Error("Child durable identity mismatch");
    return child;
  } finally {
    dir.close();
  }
}
function highWater(s: State, nodes: Record<string, { sequence: number; digest: string }>) {
  const name = `${s.certificate.leaseId}.json`;
  let prior: Record<string, { sequence: number; digest: string }> = {};
  try {
    prior = z
      .record(
        z.string(),
        z.strictObject({ sequence: z.number().int().nonnegative().safe(), digest }),
      )
      .parse(readPrivateRecord(s.installation, "observations", name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const [key, old] of Object.entries(prior)) {
    const current = nodes[key];
    if (
      !current ||
      current.sequence < old.sequence ||
      (current.sequence === old.sequence && current.digest !== old.digest)
    )
      throw Error("Shared ledger rollback or replacement");
  }
  if (!s.certificate.origin || hasLocalRetentionFamily(s.installation, s.certificate.origin))
    writePrivateRecord(s.installation, "observations", name, nodes, false, s.certificate.origin);
}
type LeaseTree = {
  root: RootRecord;
  grants: Map<string, Grant>;
  children: Map<string, ChildRecord>;
};
function tree(s: State): LeaseTree {
  if (!s.journalGuardHeld) return guarded(s, () => tree(s), false);
  const root = readRoot(s);
  if (
    !validateOriginRecord(root) ||
    !sameControlOrigin(root.origin, s.certificate.origin) ||
    controlDigest(root.certificate) !== controlDigest(s.certificateEnvelope)
  )
    throw Error("Owner certificate replacement");
  const nodes: Record<string, { sequence: number; digest: string }> = {
    owner: { sequence: root.sequence, digest: controlDigest(root) },
  };
  const grants = new Map<string, Grant>();
  const children = new Map<string, ChildRecord>();
  let count = 0;
  function walk(
    parent: ExecutionRef,
    node: string | null,
    subset: readonly string[],
    publicKey: string,
    digests: Record<string, string>,
    depth: number,
    edges?: readonly string[],
  ) {
    for (const [id, expected] of Object.entries(digests)) {
      if (++count > 64) throw Error("Child intent capacity exceeded");
      const grant = readGrant(s, id, publicKey);
      const dir = childDirectory(s, "grants");
      try {
        const raw = json(dir, `${id}.json`) as { grant: unknown };
        if (controlDigest(raw.grant) !== expected) throw Error("Grant digest changed");
      } finally {
        dir.close();
      }
      if (
        grant.child.fingerprint !==
          executionFingerprint({
            kind: grant.childKind,
            operationFingerprint: grant.child.operationFingerprint,
            deadlineAt: grant.child.deadlineAt,
            parent: retainedControlParent(grant.parent),
          }) ||
        grant.parentNode !== node ||
        controlDigest(grant.parent) !== controlDigest(parent) ||
        grant.depth !== depth ||
        grant.child.deadlineAt > parent.deadlineAt ||
        grant.serviceIds.some((id) => !subset.includes(id)) ||
        (edges && !edges.includes(grant.phase))
      )
        throw Error("Grant ancestry/deadline/subset mismatch");
      const witness = readControlExecutionWitness(
        s.installation,
        parent,
        node === null ? s.installation.publicKeys[parent.executor] : publicKey,
      );
      const allowedKinds = childPhaseKinds[grant.phase as ControlChildPhase];
      if (
        !sameControlOrigin(witness.origin, grant.origin) ||
        !allowedKinds?.includes(grant.childKind) ||
        grant.child.operationKey !==
          controlChildOperationKey(
            parent.operationKey,
            grant.phase as ControlChildPhase,
            grant.ordinal,
          )
      )
        throw Error("Grant kind or stable phase key mismatch");
      const parentRecipient =
        node === null ? s.certificate.owner.executor : grants.get(node)?.recipient;
      if (!parentRecipient) throw Error("Missing parent recipient");
      const expectedEdges = verifyFiniteControlEdge(
        parentRecipient,
        witness.kind,
        grant.phase as ControlChildPhase,
        grant.recipient,
      );
      if (
        canonicalJson(expectedEdges) !== canonicalJson(grant.permittedFurtherEdges) ||
        grant.serviceIds.some((id) => !witness.serviceIds.includes(id))
      )
        throw Error("Grant widens certified parent policy");
      grants.set(id, grant);
      const child = readChild(s, grant);
      if (child) {
        if (child.grantDigest !== expected) throw Error("Adoption grant digest mismatch");
        children.set(id, child);
        nodes[id] = { sequence: child.sequence, digest: controlDigest(child) };
        walk(
          grant.child,
          id,
          grant.serviceIds,
          grant.childPublicKey,
          child.grantDigests,
          depth + 1,
          grant.permittedFurtherEdges,
        );
      }
    }
  }
  walk(
    s.certificate.owner,
    null,
    s.certificate.serviceIds,
    s.certificate.ownerPublicKey,
    root.grantDigests,
    1,
  );
  const grantDir = childDirectory(s, "grants"),
    childDir = childDirectory(s, "children");
  try {
    if (
      grantDir.listBounded(64).some((n) => !grants.has(n.replace(/\.json$/, ""))) ||
      childDir.listBounded(64).some((n) => !children.has(n.replace(/\.json$/, "")))
    )
      throw Error("Unexplained protocol record; recovery required");
  } finally {
    grantDir.close();
    childDir.close();
  }
  highWater(s, nodes);
  return { root, grants, children };
}
function ledgerBytes(s: State) {
  let bytes =
    s.ledger.read("owner.json", 131072).length + s.ledger.read("admission.json", 4096).length;
  for (const kind of ["grants", "children"] as const) {
    const dir = childDirectory(s, kind);
    try {
      if (dir.listBounded(64).length > 64) throw Error("Protocol record capacity");
      for (const name of dir.listBounded(64)) bytes += dir.read(name, 131072).length;
    } finally {
      dir.close();
    }
  }
  return bytes;
}
function writeBounded(
  s: State,
  kind: "owner" | "grants" | "children",
  name: string,
  value: unknown,
  exclusive = false,
) {
  const dir = kind === "owner" ? s.ledger : childDirectory(s, kind);
  try {
    const bytes = canonicalJson(value);
    if (name === "admission.json" && Buffer.byteLength(bytes) > 4096)
      throw Error("Admission release journal exceeds byte capacity");
    let old = 0;
    try {
      old = dir.read(name, 131072).length;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (ledgerBytes(s) - old + Buffer.byteLength(bytes) > 131072)
      throw Error("Lease ledger capacity exceeded");
    if (s.certificate.origin)
      familyRecordWrite(
        s.installation,
        s.certificate.origin,
        {
          scope: "shared",
          namespace: kind === "owner" ? "lease-owner" : `lease-${kind}`,
          container: s.certificate.leaseId,
          name,
        },
        bytes,
        (before) => dir.write(name, bytes, exclusive, before),
        exclusive,
      );
    else dir.write(name, bytes, exclusive);
  } finally {
    if (dir !== s.ledger) dir.close();
  }
}
function guarded<T>(s: State, run: () => T, checkTargets = true): T {
  if (s.journalGuardHeld) throw Error("Nested lease journal writer");
  if (checkTargets) verifyAnchors(s);
  else {
    s.data.check();
    s.ledger.check();
  }
  const path = s.ledger.name(".journal-writer");
  try {
    mkdirSync(path, { mode: 0o700 });
    fsyncSync(s.ledger.fd);
  } catch {
    throw Error("Lease journal writer is busy or requires supervised recovery");
  }
  const guard = s.ledger.directory(".journal-writer");
  const expected = identity(guard.stat);
  try {
    s.journalGuardHeld = true;
    return run();
  } finally {
    s.journalGuardHeld = false;
    guard.close();
    s.ledger.removeDirectory(".journal-writer", expected);
  }
}
function writeNode(s: State, node: RootRecord | ChildRecord) {
  const domain = `${s.node === null ? "openmapx-lease-owner" : "openmapx-lease-child"}-v${node.version === 2 ? 2 : 1}`;
  writeBounded(
    s,
    s.node === null ? "owner" : "children",
    s.node === null ? "owner.json" : `${s.node}.json`,
    signControl(s.key, domain, node),
  );
}
function closeState(s: State) {
  if (s.closed) return;
  s.closed = true;
  s.ledger.close();
  s.leases.close();
  s.locks.close();
  s.control.close();
  s.data.close();
}
function knownOutcome(e: ChildSettlement | null | undefined) {
  return (
    !!e &&
    e.outcome !== "unknown" &&
    e.publication !== "unknown" &&
    !(e.outcome === "failed_without_effect" && e.publication !== "not_started")
  );
}
function admissionIndex(
  control: AnchoredDirectory,
  leases: AnchoredDirectory,
  installation: InstallationState,
) {
  let created = false;
  try {
    mkdirSync(control.name("admission-index-v1"), { mode: 0o700 });
    fsyncSync(control.fd);
    created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const index = control.directory("admission-index-v1");
  try {
    if (created) {
      // Existing installations require supervised indexing; never silently omit an old fence.
      if (leases.listBounded(1).length)
        throw Error("Existing leases require supervised admission-index recovery");
      index.directory("active", true).close();
      index.directory("history", true).close();
      index.write(
        "ready.json",
        canonicalJson({ installationId: installation.installation.installationId }),
        true,
      );
    }
    const ready = z.strictObject({ installationId: uuid }).parse(json(index, "ready.json", 1024));
    if (ready.installationId !== installation.installation.installationId)
      throw Error("Foreign admission index");
    return index;
  } catch (e) {
    index.close();
    throw e;
  }
}
function removeSlot(dir: AnchoredDirectory, slot: z.infer<typeof slotSchema>) {
  const child = dir.directory(slot.name);
  try {
    if (!sameInode(identity(child.stat), slot.identity))
      throw Error("Replaced admission slot inode");
    if (slot.generation) {
      const value = z
        .strictObject({ generation: uuid })
        .parse(json(child, "generation.json", 1024));
      if (value.generation !== slot.generation) throw Error("Reused admission slot generation");
      child.removeFile("generation.json");
    }
  } finally {
    child.close();
  }
  dir.removeDirectory(slot.name, slot.identity);
}
/** Normal coordinator staging owns no target lease. Observe the bounded shared
 * index without a writer, allocation, high-water write or sibling private read.
 * Partial admission/release and concurrent replacement are fail-busy. */
export function assertCoordinatorPullLeaseCompatibility(
  authority: VerifiedExecutionAuthority,
): void {
  const state = executionAuthorityState(authority),
    raw = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ),
    admitted = verifyControl(
      state.installation.installation.publicKey,
      originRecordDomain("openmapx-control-execution", raw),
      raw,
      z
        .object({
          kind: z.literal("service.pull"),
          execution: executionRefSchema,
          operation: opsOperationSchema,
        })
        .passthrough(),
    );
  if (
    !state.origin ||
    state.installation.fixedChildId ||
    state.kind !== "service.pull" ||
    controlDigest(raw) !== state.receiptDigest ||
    controlDigest(admitted.execution) !== controlDigest(state.execution) ||
    admitted.operation.kind !== "service.pull" ||
    admitted.operation.serviceId !== "data-manager" ||
    !admitted.operation.candidateId ||
    opsOperationFingerprint(admitted.operation) !== state.execution.operationFingerprint
  )
    throw Error("Actual normal coordinator pull required");
  verifyCoordinatorPullAdmissionReadOnly(authority);
  const opened: AnchoredDirectory[] = [],
    open = (parent: AnchoredDirectory, name: string) => {
      const dir = parent.directory(name);
      opened.push(dir);
      return dir;
    },
    data = new AnchoredDirectory(state.installation.dataRoot);
  try {
    let control: AnchoredDirectory;
    try {
      control = open(data, ".admin-target-control");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        data.check();
        return;
      }
      throw error;
    }
    // Before the first root, execution witnesses may exist without a target
    // index. Only actual absence of both lock and retained-owner entries is safe.
    if (!control.listBounded(16).includes("admission-index-v1")) {
      for (const name of ["locks", "leases"]) {
        let dir: AnchoredDirectory;
        try {
          dir = open(control, name);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (dir.hasEntries()) throw Error("Unindexed physical target ownership");
      }
      control.check();
      return;
    }
    const index = open(control, "admission-index-v1"),
      active = open(index, "active"),
      locks = open(control, "locks"),
      leases = open(control, "leases"),
      ready = z.strictObject({ installationId: uuid }).parse(json(index, "ready.json", 1024));
    if (ready.installationId !== state.installation.installation.installationId)
      throw Error("Foreign target index");
    const snapshot = () =>
        Object.fromEntries(
          active
            .listBounded(CONTROL_RETENTION_LIMITS.activeLeases)
            .sort()
            .map((name) => {
              if (
                !/^slot-\d{1,4}$/.test(name) ||
                Number(name.slice(5)) >= CONTROL_RETENTION_LIMITS.activeLeases
              )
                throw Error("Unknown active target slot");
              const dir = active.directory(name);
              try {
                return [
                  name,
                  {
                    identity: identity(dir.stat),
                    generation: z
                      .strictObject({ generation: uuid })
                      .parse(json(dir, "generation.json", 1024)).generation,
                  },
                ];
              } finally {
                dir.close();
              }
            }),
        ),
      before = snapshot(),
      matched = new Set<string>();
    if (locks.listBounded(256).includes("data-manager")) throw Error("Coordinator target is held");
    const names = leases.listBounded(CONTROL_RETENTION_LIMITS.leases + 3).sort();
    for (const name of names) {
      if ([".retention-count", ".retention-highwater", ".retention-transaction"].includes(name))
        continue;
      uuid.parse(name);
      const owner = openState(state.installation.dataRoot, name, state.installation, true);
      try {
        const root = readRoot(owner),
          slots = owner.slots;
        if (
          !slots ||
          !validateOriginRecord(root) ||
          !sameControlOrigin(root.origin, owner.certificate.origin) ||
          controlDigest(root.certificate) !== controlDigest(owner.certificateEnvelope)
        )
          throw Error("Changed physical owner");
        if (slots.release?.phase === "released" && slots.releasedAt) {
          if (root.phase !== "settled" || !knownOutcome(root.settlement))
            throw Error("Unproved physical release");
          continue;
        }
        if (owner.certificate.serviceIds.includes("data-manager"))
          throw Error("Coordinator target is unreleased");
        const slot = before[slots.active.name];
        if (
          !slot ||
          matched.has(slots.active.name) ||
          !sameInode(slot.identity, slots.active.identity) ||
          slot.generation !== slots.active.generation
        )
          throw Error("Unindexed active physical owner");
        matched.add(slots.active.name);
      } finally {
        closeState(owner);
      }
    }
    if (
      matched.size !== Object.keys(before).length ||
      canonicalJson(snapshot()) !== canonicalJson(before) ||
      canonicalJson(leases.listBounded(CONTROL_RETENTION_LIMITS.leases + 3).sort()) !==
        canonicalJson(names) ||
      locks.listBounded(256).includes("data-manager")
    )
      throw Error("Physical target index is changing");
    for (const dir of opened) dir.check();
  } finally {
    for (const dir of opened.reverse()) dir.close();
    data.close();
  }
}
function _releaseActiveSlot(s: State) {
  if (!s.slots) throw Error("Missing retained admission slots");
  const index = s.control.directory("admission-index-v1"),
    active = index.directory("active");
  try {
    removeSlot(active, s.slots.active);
  } finally {
    active.close();
    index.close();
  }
}
export async function acquireArtifactTargetLease(options: {
  dataRoot: string;
  serviceIds: readonly string[];
  owner: VerifiedExecutionAuthority;
  signal?: AbortSignal;
}): Promise<ArtifactTargetLease> {
  const beganAt = Date.now();
  const authority = executionAuthorityState(options.owner);
  if (authority.installation.fixedChildId)
    throw Error("Fixed children must borrow and cannot acquire a root");
  const serviceIds = targetSchema.parse(options.serviceIds);
  if (
    serviceIds.some((id) => !authority.serviceIds.includes(id)) ||
    Date.now() >= authority.execution.deadlineAt
  )
    throw Error("Target closure or execution deadline mismatch");
  if (authority.kind === "data.update") await verifyDataUpdatePrerequisites(options.owner);
  assertControlExecutionForward(options.owner);
  options.signal?.throwIfAborted();
  try {
    readPrivateRecord(
      authority.installation,
      "execution-leases",
      `${authority.execution.operationKey}.json`,
    );
    throw Error("Execution already acquired a root lease; reconcile its original identity");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const data = new AnchoredDirectory(options.dataRoot);
  const trusted = new AnchoredDirectory(authority.installation.dataRoot);
  try {
    if (!sameInode(identity(data.stat), identity(trusted.stat)))
      throw Error("Foreign physical data root");
  } finally {
    trusted.close();
  }
  const control = data.directory(".admin-target-control", true, true),
    locks = control.directory("locks", true, true),
    leases = control.directory("leases", true, true);
  const acquired: Record<string, FileIdentity> = {};
  let published = false;
  let ledger: AnchoredDirectory | undefined;
  let activeSlot: z.infer<typeof slotSchema> | undefined,
    historySlot: z.infer<typeof slotSchema> | undefined;
  let index: AnchoredDirectory | undefined;
  try {
    const until = Math.min(beganAt + 5000, authority.execution.deadlineAt);
    index = admissionIndex(control, leases, authority.installation);
    const history = index.directory("history"),
      active = index.directory("active");
    try {
      historySlot = reserveAuthoritySlot(history, CONTROL_RETENTION_LIMITS.leases, until);
      activeSlot = reserveAuthoritySlot(active, CONTROL_RETENTION_LIMITS.activeLeases, until);
    } finally {
      active.close();
      history.close();
    }
    for (const id of serviceIds) {
      for (;;) {
        options.signal?.throwIfAborted();
        if (Date.now() >= until) throw Error("Target lease acquisition deadline elapsed");
        try {
          mkdirSync(locks.name(id), { mode: 0o700 });
          fsyncSync(locks.fd);
          const lock = locks.directory(id);
          acquired[id] = identity(lock.stat);
          lock.close();
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          if (Date.now() >= until)
            throw Error("Target lease busy; existing ownership cannot be stolen");
          await delay(Math.min(50, until - Date.now()), undefined, { signal: options.signal });
        }
      }
    }
    const leaseId = randomUUID();
    ledger = leases.directory(leaseId, true, true);
    ledger.directory("grants", true).close();
    ledger.directory("children", true).close();
    const key = newControlKey();
    const certificate: Certificate = {
      version: 2,
      origin: authority.origin,
      installationId: authority.installation.installation.installationId,
      leaseId,
      dataRootIdentity: identity(data.stat),
      lockIdentities: acquired,
      owner: authority.execution,
      ownerPublicKey: key.publicKey,
      serviceIds,
      createdAt: Date.now(),
    };
    const certificateEnvelope = signControl(
      authority.installation.privateKey,
      "openmapx-lease-certificate-v2",
      certificate,
    );
    const slots: AdmissionSlots = {
      version: 1,
      installationId: certificate.installationId,
      leaseId,
      certificateDigest: controlDigest(certificateEnvelope),
      active: activeSlot,
      history: historySlot,
    };
    if (!authority.origin) throw Error("Legacy root cannot acquire a fresh lease");
    registerFamilyLease(
      authority.installation,
      authority.origin,
      leaseId,
      controlDigest(certificateEnvelope),
      authority.execution.executor,
    );
    trackFamilyDirectory(
      authority.installation,
      authority.origin,
      { namespace: "lease-directory", container: leaseId, name: leaseId },
      identity(ledger.stat),
    );
    for (const name of ["grants", "children"]) {
      const dir = ledger.directory(name);
      try {
        trackFamilyDirectory(
          authority.installation,
          authority.origin,
          { namespace: "lease-directory", container: leaseId, name },
          identity(dir.stat),
        );
      } finally {
        dir.close();
      }
    }
    trackFamilyDirectory(
      authority.installation,
      authority.origin,
      { namespace: "history-slot", container: leaseId, name: historySlot.name },
      historySlot.identity,
      historySlot.generation,
    );
    const admissionBytes = canonicalJson(
      signControl(
        authority.installation.privateKey,
        "openmapx-admission-slots-v1",
        admissionSlotSchema.parse(slots),
      ),
    );
    if (Buffer.byteLength(admissionBytes) > 4096)
      throw Error("Admission journal exceeds byte capacity");
    familyRecordWrite(
      authority.installation,
      authority.origin,
      { scope: "shared", namespace: "lease-owner", container: leaseId, name: "admission.json" },
      admissionBytes,
      (before) => ledger?.write("admission.json", admissionBytes, true, before),
      true,
    );
    writePrivateRecord(
      authority.installation,
      "leases",
      `${leaseId}.json`,
      {
        certificate: certificateEnvelope,
        privateKey: encodePrivate(key.privateKey),
        executionReceiptDigest: authority.receiptDigest,
      },
      true,
      authority.origin,
    );
    const record: RootRecord = {
      version: 2,
      origin: authority.origin,
      certificate: certificateEnvelope,
      sequence: 0,
      phase: "held",
      grantDigests: {},
      settlement: null,
    };
    writePrivateRecord(
      authority.installation,
      "execution-leases",
      `${authority.execution.operationKey}.json`,
      { leaseId, certificateDigest: controlDigest(certificateEnvelope) },
      true,
      authority.origin,
    );
    published = true;
    const ownerBytes = canonicalJson(
      signControl(key.privateKey, "openmapx-lease-owner-v2", record),
    );
    familyRecordWrite(
      authority.installation,
      authority.origin,
      { scope: "shared", namespace: "lease-owner", container: leaseId, name: "owner.json" },
      ownerBytes,
      (before) => ledger?.write("owner.json", ownerBytes, true, before),
      true,
    );
    const state: State = {
      data,
      control,
      locks,
      leases,
      ledger,
      installation: authority.installation,
      certificate,
      certificateEnvelope,
      key: key.privateKey,
      node: null,
      execution: authority.execution,
      authority,
      verifiedAuthority: options.owner,
      slots,
      closed: false,
    };
    const lease = Object.freeze({
      leaseId,
      owner: certificate.owner,
      serviceIds: Object.freeze([...serviceIds]),
      mode: "owner" as const,
    });
    handles.set(lease, state);
    tree(state);
    if (Date.now() >= until)
      throw Error(
        "Target lease acquisition deadline elapsed after publication; reconcile original identity",
      );
    index.close();
    return lease;
  } catch (e) {
    if (!published && index) {
      for (const [kind, slot] of [
        ["active", activeSlot],
        ["history", historySlot],
      ] as const) {
        if (!slot) continue;
        if (kind === "history" && ledger) continue; // Partial records consume retained capacity too.
        const dir = index.directory(kind);
        try {
          removeSlot(dir, slot);
        } finally {
          dir.close();
        }
      }
    }
    index?.close();
    if (!published)
      for (const [id, expected] of Object.entries(acquired)) locks.removeDirectory(id, expected);
    ledger?.close();
    leases.close();
    locks.close();
    control.close();
    data.close();
    throw e;
  }
}
export function verifyFiniteControlEdge(
  role: ControlRecipient | "host-cli",
  kind: string,
  phase: ControlChildPhase,
  recipient: ControlRecipient,
): string[] {
  if (role === "data-manager") {
    if (kind === "catalog.validate") {
      if (
        recipient !== "ops-agent" ||
        !["stop-staging", "restart-staging", "proxy-stage", "proxy-restore"].includes(phase)
      )
        throw Error("Unauthorized catalog validation child edge");
      return [];
    }
    if (
      !["transit-sync", "catalog.activate", "transit-maintenance"].includes(kind) ||
      recipient !== "ops-agent" ||
      ![
        "stop-primary",
        "stop-staging",
        "restart-staging",
        "promote-primary",
        "recover-primary",
        "proxy-stage",
        "proxy-commit",
        "proxy-restore",
        "paired-pin-commit",
      ].includes(phase) ||
      (phase === "paired-pin-commit" && kind !== "catalog.activate")
    )
      throw Error("Unauthorized data-manager child edge");
    return [];
  }
  if (
    role === "ops-agent" &&
    recipient === "fixed-cli" &&
    ["lifecycle", "build", "data-link", "data-clean", "data-finalization"].includes(phase) &&
    childPhaseKinds[phase].includes(kind)
  )
    return phase === "data-clean" ? [] : ["hardlinks"];
  if (
    ["ops-agent", "fixed-cli", "host-cli"].includes(role) &&
    recipient === "data-manager" &&
    phase === "hardlinks" &&
    [
      "service.start",
      "service.update",
      "system.update",
      "service.build",
      "services.buildAll",
      "data.link",
      "configuration.hardlinks.apply",
      "data.update",
    ].includes(kind)
  )
    return [];
  if (
    role === "ops-agent" &&
    recipient === "configuration-helper" &&
    phase === "configuration-handoff" &&
    kind === "configurationHandoff.prepare"
  )
    return [];
  if (role === "ops-agent" && kind === "configurationMaintenance.prepare") {
    if (
      recipient === "data-manager" &&
      ["configuration-fence", "configuration-fence-settle"].includes(phase)
    )
      return [];
    if (
      recipient === "ops-agent" &&
      [
        "configuration-commit",
        "maintenance-hardlinks",
        "maintenance-recreate",
        "maintenance-handoff",
      ].includes(phase)
    )
      return phase === "maintenance-hardlinks"
        ? ["hardlinks"]
        : phase === "maintenance-handoff"
          ? ["configuration-handoff"]
          : [];
  }
  throw Error("Unauthorized finite control edge");
}
function permitted(s: State, child: ControlPlannedChild, parentGrant?: Grant): string[] {
  if (
    parentGrant &&
    (!parentGrant.permittedFurtherEdges.includes(child.phase) || parentGrant.depth >= 2)
  )
    throw Error("Unauthorized descendant edge");
  const key = parentGrant?.childPublicKey ?? s.certificate.ownerPublicKey;
  // Root execution witnesses use the pinned role key; borrowed witnesses use the certified child key.
  const witness = readControlExecutionWitness(
    s.installation,
    s.execution,
    s.node === null ? s.installation.publicKeys[s.execution.executor] : key,
  );
  return verifyFiniteControlEdge(
    parentGrant?.recipient ?? s.installation.installation.role,
    witness.kind,
    child.phase,
    child.recipient,
  );
}
function forwardAncestry(t: ReturnType<typeof tree>, node: string | null): boolean {
  if (t.root.phase !== "held") return false;
  while (node !== null) {
    const grant = t.grants.get(node);
    if (!grant || t.children.get(node)?.phase !== "held" || Date.now() >= grant.child.deadlineAt)
      return false;
    node = grant.parentNode;
  }
  return Date.now() < t.root.certificate.payload.owner.deadlineAt;
}
export async function delegateArtifactTargetLease(
  lease: TargetLeaseAuthority,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    childPublicKey: string;
  },
): Promise<ArtifactDelegationAssertion> {
  const s = stateOf(lease);
  if (s.settlementOnly) throw Error("Recovered lease permits settlement only");
  const authority = s.verifiedAuthority;
  if (!authority) throw Error("A durable local execution must own child grant publication");
  return guarded(s, () =>
    withControlDelegationPublication(authority, child.phase, () =>
      publishReservedLeaseGrant(s, lease, child, authority),
    ),
  );
}
/** Lease → ancestor execution scopes → local execution scope stay held through
 * private reference/outbox, cancellation index and shared/node publication. */
function publishReservedLeaseGrant(
  s: State,
  lease: TargetLeaseAuthority,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    childPublicKey: string;
  },
  authority: VerifiedExecutionAuthority,
): ArtifactDelegationAssertion {
  const current = tree(s);
  const node =
    s.node === null
      ? current.root
      : required(current.children.get(s.node), "Missing retained child node");
  if (!forwardAncestry(current, s.node) || Date.now() >= s.execution.deadlineAt)
    throw Error("Lease does not permit forward delegation");
  let plan = resolveControlChildPlan(authority, child);
  if (plan && canonicalJson(plan.serviceIds) !== canonicalJson(child.serviceIds))
    throw Error("Reserved child target subset changed");
  if (!plan && s.node !== null) {
    const inherited = required(current.grants.get(s.node), "Missing retained child grant");
    const kinds = childPhaseKinds[child.phase];
    if (
      inherited.permittedFurtherEdges.includes(child.phase) &&
      kinds.length === 1 &&
      child.execution.operationKey ===
        controlChildOperationKey(s.execution.operationKey, child.phase, 0)
    )
      plan = { ...child, kind: required(kinds[0], "Missing finite child kind"), ordinal: 0 };
  }
  if (!plan) throw Error("Child is absent from immutable admitted plan");
  if (current.grants.size >= 64) throw Error("Child intent capacity exhausted");
  if (
    [...current.grants.values()].some((g) => g.child.operationKey === child.execution.operationKey)
  )
    throw Error("Attempted child cannot be replayed");
  if (child.serviceIds.some((id) => !lease.serviceIds.includes(id)))
    throw Error("Widened target subset");
  const parentGrant = s.node === null ? undefined : current.grants.get(s.node);
  const edges = permitted(s, plan, parentGrant);
  if (
    s.authority?.kind === "configurationMaintenance.prepare" &&
    [
      "configuration-commit",
      "maintenance-hardlinks",
      "maintenance-recreate",
      "maintenance-handoff",
    ].includes(child.phase)
  )
    verifyControlPreparedTerminal(s.installation, s.execution);
  let delegationId: string = randomUUID();
  if (child.recipient === "fixed-cli" || child.recipient === "configuration-helper") {
    delegationId = fixedControlChildId(s.installation, child.childPublicKey, s.execution);
  } else if (child.childPublicKey !== s.installation.publicKeys[child.recipient])
    throw Error("Child role key mismatch");
  if (!s.certificate.origin) throw Error("Legacy lease is observation-only; upgrade producer");
  assertOriginClockForward(s.installation, s.certificate.origin);
  const grant: Grant = {
    version: 2,
    origin: s.certificate.origin,
    installationId: s.certificate.installationId,
    leaseId: lease.leaseId,
    ownerCertificateDigest: controlDigest(s.certificateEnvelope),
    delegationId,
    parentNode: s.node,
    parent: s.execution,
    child: child.execution,
    childKind: plan.kind,
    phase: child.phase,
    ordinal: plan.ordinal,
    serviceIds: [...child.serviceIds],
    recipient: child.recipient,
    childPublicKey: child.childPublicKey,
    permittedFurtherEdges: edges,
    depth: (parentGrant?.depth ?? 0) + 1,
  };
  const envelope = signControl(s.key, "openmapx-lease-grant-v2", grant);
  const grantDigest = controlDigest(envelope);
  const transition = signControl(s.key, "openmapx-lease-intent-v1", {
    delegationId,
    grantDigest,
    sequence: 1 as const,
    state: "attempted" as const,
  });
  const ancestors: string[] = [];
  let ancestor = s.node;
  while (ancestor) {
    ancestors.unshift(ancestor);
    ancestor = current.grants.get(ancestor)?.parentNode ?? null;
  }
  const fields = {
    version: 1 as const,
    installationId: s.certificate.installationId,
    leaseId: lease.leaseId,
    ownerCertificateDigest: controlDigest(s.certificateEnvelope),
    delegationId,
    grantDigest,
    ancestorDelegationIds: ancestors,
  };
  const signature = signControl(s.key, "openmapx-lease-assertion-v1", fields).signature;
  const assertion = Buffer.from(canonicalJson({ ...fields, signature })).toString(
    "base64url",
  ) as ArtifactDelegationAssertion;
  parseControlAssertion(assertion);
  enlistFamilyIntent(
    s.installation,
    s.certificate.origin,
    delegationId,
    child.execution,
    child.recipient === "data-manager" ? "data-manager" : "ops-agent",
  );
  prepareControlChildPublication(authority, plan, {
    delegationId,
    grantDigest,
    leaseId: lease.leaseId,
  });
  recordLeaseControlAttempt(authority, {
    child: child.execution,
    leaseId: lease.leaseId,
    delegationId,
    grantDigest,
  });
  writePrivateRecord(
    s.installation,
    "attempts",
    `${delegationId}.json`,
    { grant: envelope, transition, assertion },
    true,
    s.certificate.origin,
  );
  writeBounded(s, "grants", `${delegationId}.json`, { grant: envelope, transition }, true);
  node.grantDigests[delegationId] = grantDigest;
  node.sequence++;
  writeNode(s, node);
  tree(s);
  return assertion;
}
function openState(
  dataRoot: string,
  leaseId: string,
  installation: InstallationState,
  terminalObservation = false,
): State {
  uuid.parse(leaseId);
  const data = new AnchoredDirectory(dataRoot);
  const control = data.directory(".admin-target-control"),
    locks = control.directory("locks"),
    leases = control.directory("leases"),
    ledger = leases.directory(leaseId);
  try {
    const raw = z.object({ payload: rootSchema }).parse(json(ledger, "owner.json"));
    const envelope = raw.payload.certificate;
    const cert = certificateSchema.parse(envelope.payload);
    const certificate = verifyControl(
      installation.publicKeys[cert.owner.executor],
      originRecordDomain("openmapx-lease-certificate", envelope),
      envelope,
      certificateSchema,
    );
    if (
      !validateOriginRecord(certificate) ||
      certificate.installationId !== installation.installation.installationId ||
      certificate.leaseId !== leaseId
    )
      throw Error("Foreign lease installation");
    const slots = verifyControl(
      installation.publicKeys[certificate.owner.executor],
      "openmapx-admission-slots-v1",
      json(ledger, "admission.json", 4096),
      admissionSlotSchema,
    );
    if (
      slots.leaseId !== leaseId ||
      slots.installationId !== certificate.installationId ||
      slots.certificateDigest !== controlDigest(envelope)
    )
      throw Error("Admission slot identity mismatch");
    const s = {
      slots,
      data,
      control,
      locks,
      leases,
      ledger,
      installation,
      certificate,
      certificateEnvelope: envelope,
      key: installation.privateKey,
      node: null,
      execution: certificate.owner,
      closed: false,
    } satisfies State;
    if (terminalObservation && readRoot(s).phase === "settled") {
      s.data.check();
      s.ledger.check();
      if (!sameInode(identity(s.data.stat), s.certificate.dataRootIdentity))
        throw Error("Changed physical root");
    } else verifyAnchors(s);
    return s;
  } catch (e) {
    ledger.close();
    leases.close();
    locks.close();
    control.close();
    data.close();
    throw e;
  }
}
export async function adoptArtifactTargetLease(options: {
  dataRoot: string;
  assertion: string;
  peer: VerifiedControlPeer;
  execution: ExecutionRef;
  serviceIds: readonly string[];
}): Promise<BorrowedArtifactTargetLease> {
  const peer = controlPeerState(options.peer);
  if (
    options.assertion !== peer.assertion ||
    controlDigest(options.execution) !== controlDigest(peer.execution)
  )
    throw Error("Peer execution binding mismatch");
  const assertion = parseControlAssertion(options.assertion);
  const s = openState(options.dataRoot, assertion.leaseId, peer.installation);
  try {
    return await guarded(s, () => {
      const t = tree(s);
      const grant = t.grants.get(assertion.delegationId);
      if (
        !grant ||
        controlDigest(s.certificateEnvelope) !== assertion.ownerCertificateDigest ||
        controlDigest(grant.child) !== controlDigest(options.execution) ||
        grant.childKind !== peer.kind ||
        grant.recipient !== peer.recipient ||
        grant.childPublicKey !== peer.childPublicKey ||
        canonicalJson(grant.serviceIds) !== canonicalJson(targetSchema.parse(options.serviceIds))
      )
        throw Error("Wrong peer principal, kind, key, fingerprint, or subset");
      const parentGrant = grant.parentNode ? t.grants.get(grant.parentNode) : undefined;
      const parentKey = parentGrant?.childPublicKey ?? s.certificate.ownerPublicKey;
      const { signature, ...fields } = assertion;
      verifyControl(
        parentKey,
        "openmapx-lease-assertion-v1",
        { payload: fields, signature },
        assertionSchema.omit({ signature: true }),
      );
      const parent = t.children.get(grant.parentNode ?? "") ?? t.root;
      const expectedAncestors: string[] = [];
      let ancestor = grant.parentNode;
      while (ancestor) {
        expectedAncestors.unshift(ancestor);
        ancestor = t.grants.get(ancestor)?.parentNode ?? null;
      }
      if (
        canonicalJson(expectedAncestors) !== canonicalJson(assertion.ancestorDelegationIds) ||
        parent.grantDigests[grant.delegationId] !== assertion.grantDigest
      )
        throw Error("Wrong grant ancestry/digest");
      const issuer = parentGrant?.recipient ?? s.certificate.owner.executor;
      if (
        peer.recipient === "ops-agent" &&
        issuer !== "data-manager" &&
        !(
          issuer === "ops-agent" &&
          peer.local &&
          [
            "configuration-commit",
            "maintenance-hardlinks",
            "maintenance-recreate",
            "maintenance-handoff",
          ].includes(grant.phase)
        )
      )
        throw Error("Wrong peer principal");
      if (
        peer.recipient === "data-manager" &&
        !["ops-agent", "fixed-cli", "host-cli"].includes(issuer)
      )
        throw Error("Wrong peer principal");
      const retained = t.children.get(grant.delegationId);
      if (
        !retained &&
        (!forwardAncestry(t, grant.parentNode) || Date.now() >= grant.child.deadlineAt)
      )
        throw Error("Stale or canceled delegation");
      if (!retained) {
        if (!grant.origin) throw Error("Legacy lease grant is observation-only; upgrade producer");
        assertOriginClockForward(peer.installation, grant.origin);
        reserveControlFamily(peer.installation, grant.origin);
      }
      const admissionName = `${grant.delegationId}.json`;
      const pending = {
        version: 1,
        grantDigest: assertion.grantDigest,
        execution: grant.child,
        state: "pending-adoption",
        assertion: options.assertion,
      };
      let local: unknown;
      try {
        local = readPrivateRecord(peer.installation, "adoptions", admissionName);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (local) {
        const old = z
          .object({
            grantDigest: digest,
            execution: executionRefSchema,
            state: z.enum(["pending-adoption", "ready"]),
          })
          .parse(local);
        if (
          old.grantDigest !== assertion.grantDigest ||
          controlDigest(old.execution) !== controlDigest(grant.child)
        )
          throw Error("Durable duplicate admission conflict");
      } else
        writePrivateRecord(
          peer.installation,
          "adoptions",
          admissionName,
          pending,
          true,
          grant.origin,
        );
      s.key = peer.childPrivateKey;
      s.node = grant.delegationId;
      s.execution = grant.child;
      if (!retained)
        writeBounded(
          s,
          "children",
          `${s.node}.json`,
          signControl(s.key, "openmapx-lease-child-v2", {
            version: 2,
            origin: grant.origin,
            delegationId: s.node,
            grantDigest: assertion.grantDigest,
            execution: grant.child,
            sequence: 0,
            phase: "held",
            grantDigests: {},
            settlement: null,
          } satisfies ChildRecord),
          true,
        );
      writePrivateRecord(
        peer.installation,
        "adoptions",
        admissionName,
        {
          ...pending,
          state: "ready",
        },
        false,
        grant.origin,
      );
      tree(s);
      const handle = Object.freeze({
        leaseId: assertion.leaseId,
        owner: s.certificate.owner,
        execution: grant.child,
        serviceIds: Object.freeze([...grant.serviceIds]),
        mode: "borrowed" as const,
      });
      handles.set(handle, s);
      return handle;
    });
  } catch (e) {
    closeState(s);
    throw e;
  }
}
/** A fixed receiver supplies its own durable execution authority only after adoption. */
export function bindBorrowedControlExecution(
  lease: BorrowedArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
): void {
  const s = stateOf(lease),
    a = executionAuthorityState(authority);
  if (
    controlDigest(a.execution) !== controlDigest(lease.execution) ||
    !sameControlOrigin(a.origin, s.certificate.origin) ||
    a.installation.installation.installationId !== s.certificate.installationId
  )
    throw Error("Borrower execution authority mismatch");
  s.authority = a;
  s.verifiedAuthority = authority;
  if (
    ["generation-hardlinks", "configuration-maintenance.prepare"].includes(a.kind) &&
    a.installation.installation.role === "data-manager"
  ) {
    if (!s.node || !a.origin) throw Error("Original generation adoption required");
    const payload = {
      version: 2,
      origin: a.origin,
      execution: a.execution,
      admissionDigest: a.receiptDigest,
      leaseId: s.certificate.leaseId,
      delegationId: s.node,
      certificateDigest: controlDigest(s.certificateEnvelope),
    };
    const name = `${a.execution.operationKey}.json`;
    const domain =
      a.kind === "generation-hardlinks"
        ? "openmapx-generation-adoption-v2"
        : "openmapx-configuration-fence-adoption-v2";
    let prior: unknown;
    try {
      prior = readPrivateRecord(a.installation, "execution-adoptions", name, 8192);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (prior !== undefined) {
      const saved = verifyControl(
        a.installation.installation.publicKey,
        domain,
        prior,
        z.unknown(),
      );
      if (controlDigest(saved) !== controlDigest(payload))
        throw Error("Generation adoption changed");
    } else
      writePrivateRecord(
        a.installation,
        "execution-adoptions",
        name,
        signControl(a.installation.privateKey, domain, payload),
        true,
        a.origin,
      );
  }
}
/** Source-only recovery address for the original normal DM PREPARE adopter.
 * It allocates no lease/grant or deadline, and reads only this role's records. */
export function retainedConfigurationFenceAdoption(authority: VerifiedExecutionAuthority) {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configuration-maintenance.prepare" ||
    owner.installation.installation.role !== "data-manager" ||
    !owner.origin
  )
    throw Error("Original normal DM fence adopter required");
  const value = verifyControl(
    owner.installation.installation.publicKey,
    "openmapx-configuration-fence-adoption-v2",
    readPrivateRecord(
      owner.installation,
      "execution-adoptions",
      `${owner.execution.operationKey}.json`,
      8192,
    ),
    z.strictObject({
      version: z.literal(2),
      origin: controlOriginSchema,
      execution: executionRefSchema,
      admissionDigest: digest,
      leaseId: uuid,
      delegationId: uuid,
      certificateDigest: digest,
    }),
  );
  if (
    canonicalJson(value.execution) !== canonicalJson(owner.execution) ||
    value.admissionDigest !== owner.receiptDigest ||
    canonicalJson(value.origin) !== canonicalJson(owner.origin)
  )
    throw Error("Original normal DM fence adoption changed");
  return Object.freeze(value);
}
/** Reopen only the original authenticated generation leaf for settlement.
 * There is no adopt, target acquire, deadline renewal or owner-release path. */
export function restoreGenerationHardlinksLeaseForSettlement(
  authority: VerifiedExecutionAuthority,
): BorrowedArtifactTargetLease {
  const a = executionAuthorityState(authority);
  if (
    a.kind !== "generation-hardlinks" ||
    a.installation.installation.role !== "data-manager" ||
    !a.origin
  )
    throw Error("Original generation receiver required");
  const retained = verifyControl(
    a.installation.installation.publicKey,
    "openmapx-generation-adoption-v2",
    readPrivateRecord(
      a.installation,
      "execution-adoptions",
      `${a.execution.operationKey}.json`,
      8192,
    ),
    z.strictObject({
      version: z.literal(2),
      origin: controlOriginSchema,
      execution: executionRefSchema,
      admissionDigest: digest,
      leaseId: uuid,
      delegationId: uuid,
      certificateDigest: digest,
    }),
  );
  if (
    controlDigest(retained.execution) !== controlDigest(a.execution) ||
    retained.admissionDigest !== a.receiptDigest ||
    !sameControlOrigin(retained.origin, a.origin)
  )
    throw Error("Generation retained adoption identity changed");
  const s = openState(a.installation.dataRoot, retained.leaseId, a.installation);
  try {
    return guarded(s, () => {
      const adoption = z
        .object({
          state: z.literal("ready"),
          execution: executionRefSchema,
          assertion: z.string(),
          grantDigest: digest,
        })
        .parse(
          readPrivateRecord(a.installation, "adoptions", `${retained.delegationId}.json`, 8192),
        );
      const assertion = parseControlAssertion(adoption.assertion);
      if (
        assertion.leaseId !== retained.leaseId ||
        assertion.delegationId !== retained.delegationId ||
        assertion.grantDigest !== adoption.grantDigest ||
        retained.certificateDigest !== controlDigest(s.certificateEnvelope) ||
        controlDigest(adoption.execution) !== controlDigest(a.execution) ||
        !sameControlOrigin(a.origin, s.certificate.origin)
      )
        throw Error("Original ready generation grant required");
      s.node = retained.delegationId;
      s.execution = a.execution;
      s.key = a.installation.privateKey;
      s.authority = a;
      s.verifiedAuthority = authority;
      s.settlementOnly = true;
      const t = tree(s),
        grant = t.grants.get(s.node),
        child = t.children.get(s.node);
      if (
        !grant ||
        !child ||
        grant.recipient !== "data-manager" ||
        grant.childKind !== "generation-hardlinks" ||
        grant.childPublicKey !== a.installation.installation.publicKey ||
        controlDigest(grant.child) !== controlDigest(a.execution) ||
        controlDigest(child.execution) !== controlDigest(a.execution)
      )
        throw Error("Original generation child is missing or foreign");
      const handle = Object.freeze({
        leaseId: retained.leaseId,
        owner: s.certificate.owner,
        execution: a.execution,
        serviceIds: Object.freeze([...grant.serviceIds]),
        mode: "borrowed" as const,
      });
      handles.set(handle, s);
      return handle;
    });
  } catch (error) {
    closeState(s);
    throw error;
  }
}
/** Exact borrowed generation leaf containment; its parent root remains held.
 * This authenticates the existing own-effect and physical terminal sources,
 * never a root release, new adoption or forward capability. */
export function verifyRetainedGenerationHardlinksSettlement(
  authority: VerifiedExecutionAuthority,
): void {
  const lease = restoreGenerationHardlinksLeaseForSettlement(authority),
    s = stateOf(lease);
  try {
    guarded(s, () => {
      const current = tree(s),
        child = s.node && current.children.get(s.node),
        effect = childSettlementState(
          verifyControlEffectSettlement(s.installation.installation, s.execution),
        ).evidence;
      if (
        !child ||
        child.phase !== "settled" ||
        !knownOutcome(child.settlement) ||
        controlDigest(child.settlement) !== controlDigest(effect) ||
        [...current.grants.values()].some((value) => value.parentNode === s.node)
      )
        throw Error("Original generation leaf containment required");
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
export async function settleArtifactTargetLeaseChild(
  lease: TargetLeaseAuthority,
  evidence: VerifiedChildSettlement,
): Promise<void> {
  const s = stateOf(lease);
  const proof = childSettlementState(evidence);
  if (
    proof.state !== s.installation ||
    controlDigest(proof.evidence.identity) !== controlDigest(s.execution)
  )
    throw Error("Foreign settlement identity");
  await guarded(s, () => {
    const t = tree(s);
    if (s.node === null && s.authority?.kind === "configurationMaintenance.prepare") {
      if (!s.verifiedAuthority) throw Error("Original maintenance completion authority required");
      assertMaintenanceClosureFromTree(s, s.verifiedAuthority);
    }
    const node =
      s.node === null ? t.root : required(t.children.get(s.node), "Missing retained child node");
    for (const grant of t.grants.values()) {
      if (grant.parentNode === s.node) {
        const child = t.children.get(grant.delegationId);
        if (child?.phase !== "settled" || !knownOutcome(child.settlement))
          throw Error("Unsettled attempted child retains target fence");
      }
    }
    node.settlement = proof.evidence;
    node.phase = knownOutcome(proof.evidence) ? "settled" : "recovery_required";
    node.sequence++;
    writeNode(s, node);
    tree(s);
  });
}
/** Verify the exact agent-signed shared child node; no sibling private mount or
 * caller status can stand in for actual target containment. */
export function inspectArtifactTargetLeaseChildSettlement(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): ChildSettlement | null {
  const s = stateOf(lease);
  return guarded(s, () => {
    const t = tree(s),
      entries = [...t.grants.values()].filter(
        (grant) =>
          grant.parentNode === s.node && controlDigest(grant.child) === controlDigest(execution),
      );
    if (entries.length !== 1) throw Error("Exact retained child grant required");
    const child = t.children.get(entries[0]!.delegationId);
    if (!child || child.phase !== "settled" || !knownOutcome(child.settlement)) return null;
    if (controlDigest(child.execution) !== controlDigest(execution))
      throw Error("Shared child execution changed");
    return child.settlement;
  });
}

/** Observe an original owned child's signed settlement after its root released
 * physical locks. This returns data only: no lease/issuer/forward capability. */
function retainedOwnedTargetState(authority: VerifiedExecutionAuthority) {
  const owner = executionAuthorityState(authority),
    reference = z
      .strictObject({ leaseId: uuid, certificateDigest: digest })
      .parse(
        readPrivateRecord(
          owner.installation,
          "execution-leases",
          `${owner.execution.operationKey}.json`,
        ),
      ),
    saved = z
      .strictObject({
        certificate: signedCertificateSchema,
        privateKey: z.string(),
        executionReceiptDigest: digest,
      })
      .parse(readPrivateRecord(owner.installation, "leases", `${reference.leaseId}.json`)),
    s = openState(owner.installation.dataRoot, reference.leaseId, owner.installation, true);
  try {
    if (
      controlDigest(s.execution) !== controlDigest(owner.execution) ||
      controlDigest(s.certificateEnvelope) !== reference.certificateDigest ||
      controlDigest(saved.certificate) !== reference.certificateDigest ||
      saved.executionReceiptDigest !== owner.receiptDigest ||
      !sameControlOrigin(owner.origin, s.certificate.origin)
    )
      throw Error("Original retained target owner changed");
    return s;
  } catch (error) {
    closeState(s);
    throw error;
  }
}
/** Fixed terminal-only source check for a recovered catalog activation. */
export function assertRetainedCatalogActivationChildrenSettled(
  authority: VerifiedExecutionAuthority,
): void {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "catalog.activate" || owner.installation.installation.role !== "data-manager")
    throw Error("Original catalog activation owner required");
  const s = retainedOwnedTargetState(authority);
  try {
    guarded(
      s,
      () => {
        const current = tree(s);
        for (const grant of current.grants.values()) {
          const child = current.children.get(grant.delegationId);
          if (child?.phase !== "settled" || !knownOutcome(child.settlement))
            throw Error("Catalog child tree remains unsettled");
        }
      },
      !s.slots?.release,
    );
  } finally {
    closeState(s);
  }
}
export function inspectRetainedOwnedArtifactTargetChildSettlement(
  authority: VerifiedExecutionAuthority,
  execution: ExecutionRef,
): ChildSettlement | null {
  const s = retainedOwnedTargetState(authority);
  try {
    return guarded(
      s,
      () => {
        const current = tree(s),
          grants = [...current.grants.values()].filter(
            (grant) =>
              grant.parentNode === null && controlDigest(grant.child) === controlDigest(execution),
          );
        if (grants.length !== 1) throw Error("Exact original child grant required");
        const child = current.children.get(grants[0]!.delegationId);
        if (!child || child.phase !== "settled" || !knownOutcome(child.settlement)) return null;
        if (controlDigest(child.execution) !== controlDigest(execution))
          throw Error("Original child identity changed");
        return child.settlement;
      },
      !s.slots?.release,
    );
  } finally {
    closeState(s);
  }
}
/** Source-only observation of the original held maintenance root. It creates
 * no forward authority, lease, grant or renewed deadline. */
export function configurationMaintenanceTargetOwner(lease: ArtifactTargetLease) {
  const s = stateOf(lease);
  return guarded(s, () => {
    const current = tree(s);
    if (
      s.node !== null ||
      s.installation.installation.role !== "ops-agent" ||
      s.authority?.kind !== "configurationMaintenance.prepare" ||
      !s.certificate.origin ||
      current.root.phase === "settled" ||
      s.slots?.release
    )
      throw Error("Held original maintenance target owner required");
    return Object.freeze({
      installation: s.installation.installation,
      execution: s.execution,
      origin: s.certificate.origin,
      admissionDigest: s.authority.receiptDigest,
      certificateDigest: controlDigest(s.certificateEnvelope),
      serviceIds: s.certificate.serviceIds,
    });
  });
}
/** Fixed owner-store publication order: target journal, original ancestry and
 * execution publication guard, then its role-private writer. */
export function withConfigurationMaintenanceOwnerPublication<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = stateOf(lease);
  if (
    s.node !== null ||
    s.verifiedAuthority !== authority ||
    s.authority?.kind !== "configurationMaintenance.prepare" ||
    s.settlementOnly
  )
    throw Error("Original live configuration maintenance owner required");
  return guarded(s, () =>
    withControlDelegationPublication(authority, "configuration-commit", () =>
      withPrivateEffectWriter(executionAuthorityState(authority), run),
    ),
  );
}
export function withConfigurationMaintenanceOwnerInitialization<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = stateOf(lease);
  if (
    s.node !== null ||
    s.verifiedAuthority !== authority ||
    s.authority?.kind !== "configurationMaintenance.prepare" ||
    s.settlementOnly
  )
    throw Error("Original live maintenance initialization required");
  return guarded(s, () =>
    withControlMaintenanceInitialization(authority, () =>
      withPrivateEffectWriter(executionAuthorityState(authority), run),
    ),
  );
}
/** Lease -> original ancestry/execution publication -> private writer. The
 * callback cannot issue a grant or create a forward/replacement authority. */
export function withConfigurationMaintenanceNoGuardPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    s = stateOf(lease),
    owner = executionAuthorityState(authority);
  try {
    if (s.node !== null || owner.kind !== "configurationMaintenance.prepare")
      throw Error("Original maintenance NoGuard owner required");
    return guarded(s, () => {
      if (tree(s).root.phase === "settled" || s.slots?.release)
        throw Error("Original NoGuard owner already released");
      return withControlMaintenanceNoGuardPublication(authority, () =>
        withPrivateEffectWriter(owner, run),
      );
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** Fixed logical settlement metadata only, including after original expiry or
 * cancellation. Ordinary descendants must already be conclusively settled. */
export function withConfigurationMaintenanceSettlementPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    state = stateOf(lease),
    owner = executionAuthorityState(authority);
  try {
    if (state.node !== null || owner.kind !== "configurationMaintenance.prepare")
      throw Error("Original settlement root required");
    return guarded(state, () => {
      const current = tree(state);
      if (
        current.root.phase === "settled" ||
        state.slots?.release ||
        [...current.children.values()].some(
          (child) => child.phase !== "settled" || !knownOutcome(child.settlement),
        )
      )
        throw Error("Original settlement root/ordinary children unresolved");
      return withControlMaintenanceSettlementPublication(authority, () =>
        withPrivateEffectWriter(owner, run),
      );
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** Publication of already proved guard observations remains possible after
 * cancellation/expiry. This returns no forward lease or dispatch capability. */
export function withConfigurationMaintenanceOwnerObservation<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = stateOf(lease),
    owner = executionAuthorityState(authority);
  if (
    s.node !== null ||
    s.authority?.kind !== "configurationMaintenance.prepare" ||
    owner.receiptDigest !== s.authority.receiptDigest ||
    controlDigest(owner.execution) !== controlDigest(s.execution)
  )
    throw Error("Original configuration maintenance recovery owner required");
  return guarded(s, () => {
    if (tree(s).root.phase === "settled" || s.slots?.release)
      throw Error("Maintenance observation owner already released");
    return withPrivateEffectWriter(owner, run);
  });
}
/** Lease -> original forward ancestry/terminal-prepare -> private writer.
 * This is a metadata CAS scope, not restoration of a forward lease. */
export function withConfigurationMaintenanceDecisionPublication<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const s = stateOf(lease),
    owner = executionAuthorityState(authority);
  if (
    s.node !== null ||
    s.authority?.kind !== "configurationMaintenance.prepare" ||
    owner.receiptDigest !== s.authority.receiptDigest ||
    controlDigest(owner.execution) !== controlDigest(s.execution)
  )
    throw Error("Original maintenance decision owner required");
  return guarded(s, () => {
    if (tree(s).root.phase !== "held" || s.slots?.release)
      throw Error("Original prepared maintenance root is fenced");
    return withControlMaintenanceDecisionPublication(authority, () =>
      withPrivateEffectWriter(owner, run),
    );
  });
}
/** Fixed frozen-phase metadata publication follows the same live original
 * lease/ancestry/private-writer order as that phase's grant. */
export function withConfigurationMaintenancePhasePublication<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  phase:
    | "configuration-commit"
    | "maintenance-hardlinks"
    | "maintenance-recreate"
    | "maintenance-handoff",
  run: () => T,
): T {
  const s = stateOf(lease),
    owner = executionAuthorityState(authority);
  if (
    s.node !== null ||
    s.authority?.kind !== "configurationMaintenance.prepare" ||
    s.settlementOnly ||
    s.verifiedAuthority !== authority
  )
    throw Error("Original frozen maintenance issuer required");
  return guarded(s, () =>
    withControlDelegationPublication(authority, phase, () => {
      if (tree(s).root.phase !== "held" || s.slots?.release)
        throw Error("Original maintenance phase is fenced");
      return withPrivateEffectWriter(owner, run);
    }),
  );
}
/** Original PREPARE reservation publication can restore its own retained handle,
 * but the handle never escapes and its forward clock/ancestry are rechecked. */
export function withConfigurationMaintenanceReservationPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    s = stateOf(lease),
    owner = executionAuthorityState(authority);
  try {
    if (owner.kind !== "configurationMaintenance.prepare" || s.node !== null)
      throw Error("Original maintenance reservation owner required");
    return guarded(s, () => {
      if (tree(s).root.phase !== "held" || s.slots?.release)
        throw Error("Original pre-effect maintenance root required");
      return withControlDelegationPublication(authority, "configuration-fence", () =>
        withPrivateEffectWriter(owner, run),
      );
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
function finishOwnedRelease(s: State): void {
  guarded(
    s,
    () => {
      const t = tree(s);
      if (t.root.phase !== "settled" || !knownOutcome(t.root.settlement))
        throw Error("Durable own-effect settlement is required");
      if (s.authority?.kind === "configurationMaintenance.prepare") {
        if (!s.verifiedAuthority) throw Error("Original maintenance release authority required");
        assertMaintenanceClosureFromTree(s, s.verifiedAuthority);
      }
      for (const id of t.grants.keys()) {
        const child = t.children.get(id);
        if (child?.phase !== "settled" || !knownOutcome(child.settlement))
          throw Error("Every attempted descendant must settle");
      }
      if (!s.slots) throw Error("Missing admission slots");
      const persist = () =>
        writeBounded(
          s,
          "owner",
          "admission.json",
          signControl(
            s.installation.privateKey,
            "openmapx-admission-slots-v1",
            admissionSlotSchema.parse(s.slots),
          ),
        );
      const saved = s.slots.release;
      let release: z.infer<typeof releaseProgressSchema>;
      if (saved && !("version" in saved)) {
        if (
          saved.locks.some((id, i) => id !== s.certificate.serviceIds[i]) ||
          (saved.pending !== undefined &&
            saved.pending !== s.certificate.serviceIds[saved.locks.length])
        )
          throw Error("Invalid legacy release prefix");
        release = {
          version: 2,
          phase: saved.phase,
          completedTargets: saved.locks.length,
          active: saved.active,
          ...(saved.pending === undefined ? {} : { pending: saved.locks.length }),
          ...(saved.activePlanned === undefined ? {} : { activePlanned: saved.activePlanned }),
        };
      } else
        release = saved ?? { version: 2, phase: "planned", completedTargets: 0, active: false };
      releaseProgressSchema.parse(release);
      if (
        release.completedTargets > s.certificate.serviceIds.length ||
        (release.pending !== undefined &&
          (release.pending !== release.completedTargets ||
            release.pending >= s.certificate.serviceIds.length)) ||
        ((release.active || release.activePlanned) &&
          (release.completedTargets !== s.certificate.serviceIds.length ||
            release.pending !== undefined)) ||
        (release.phase === "released" && !release.active)
      )
        throw Error("Invalid release journal certified prefix");
      s.slots.release = release;
      for (let index = release.completedTargets; index < s.certificate.serviceIds.length; index++) {
        const id = required(s.certificate.serviceIds[index], "Missing certified target");
        if (release.pending !== undefined && release.pending !== index)
          throw Error("Conflicting physical release step");
        if (release.pending === undefined) {
          const lock = s.locks.directory(id);
          try {
            if (
              !sameInode(
                identity(lock.stat),
                required(s.certificate.lockIdentities[id], "Missing certified inode"),
              ) ||
              lock.hasEntries()
            )
              throw Error("Changed unplanned target release");
          } finally {
            lock.close();
          }
          release.pending = index;
          persist();
        }
        try {
          s.locks.removeDirectory(
            id,
            required(s.certificate.lockIdentities[id], "Missing certified target inode"),
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        release.completedTargets = index + 1;
        delete release.pending;
        persist();
      }
      if (!release.active) {
        const previouslyPlanned = release.activePlanned === true;
        const index = s.control.directory("admission-index-v1"),
          active = index.directory("active");
        try {
          if (!previouslyPlanned) {
            const current = active.directory(s.slots.active.name);
            try {
              if (!sameInode(identity(current.stat), s.slots.active.identity))
                throw Error("Replaced unplanned active slot");
              if (
                s.slots.active.generation &&
                z.strictObject({ generation: uuid }).parse(json(current, "generation.json", 1024))
                  .generation !== s.slots.active.generation
              )
                throw Error("Reused unplanned active slot");
            } finally {
              current.close();
            }
            release.activePlanned = true;
            persist();
          }
          let slot: AnchoredDirectory | undefined;
          try {
            slot = active.directory(s.slots.active.name);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          if (slot) {
            try {
              if (!sameInode(identity(slot.stat), s.slots.active.identity))
                throw Error("Replaced active slot inode");
              if (s.slots.active.generation) {
                try {
                  const g = z
                    .strictObject({ generation: uuid })
                    .parse(json(slot, "generation.json", 1024));
                  if (g.generation !== s.slots.active.generation)
                    throw Error("Reused active slot generation");
                  slot.removeFile("generation.json");
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
                }
              }
            } finally {
              slot.close();
            }
            active.removeDirectory(s.slots.active.name, s.slots.active.identity);
          }
        } finally {
          active.close();
          index.close();
        }
        release.active = true;
        persist();
      }
      release.phase = "released";
      s.slots.releasedAt ??= Date.now();
      persist();
      if (s.certificate.origin)
        markFamilyLeaseReleased(
          s.installation,
          s.certificate.origin,
          s.certificate.leaseId,
          controlDigest(s.certificateEnvelope),
        );
    },
    !s.slots?.release,
  );
}
export async function releaseArtifactTargetLease(lease: ArtifactTargetLease): Promise<void> {
  const s = stateOf(lease);
  if (s.node !== null) throw Error("Borrower cannot release root");
  finishOwnedRelease(s);
  closeState(s);
}
/** Read-only original root release proof for a data command's parent. */
export function verifyRetainedArtifactTargetRootRelease(
  authority: VerifiedExecutionAuthority,
): Readonly<{ releasedAt: number }> {
  const a = executionAuthorityState(authority),
    reference = z
      .strictObject({ leaseId: uuid, certificateDigest: digest })
      .parse(
        readPrivateRecord(a.installation, "execution-leases", `${a.execution.operationKey}.json`),
      );
  const s = openState(a.installation.dataRoot, reference.leaseId, a.installation, true);
  try {
    const t = tree(s),
      effect = childSettlementState(
        verifyControlEffectSettlement(a.installation.installation, a.execution),
      ).evidence;
    if (
      controlDigest(s.execution) !== controlDigest(a.execution) ||
      controlDigest(s.certificateEnvelope) !== reference.certificateDigest ||
      !Number.isSafeInteger(s.slots?.releasedAt) ||
      !s.slots?.releasedAt ||
      s.slots?.release?.phase !== "released" ||
      t.root.phase !== "settled" ||
      controlDigest(t.root.settlement) !== controlDigest(effect) ||
      [...t.grants.keys()].some(
        (id) =>
          t.children.get(id)?.phase !== "settled" || !knownOutcome(t.children.get(id)?.settlement),
      )
    )
      throw Error("Original root release is not proved");
    return Object.freeze({ releasedAt: s.slots.releasedAt! });
  } finally {
    closeState(s);
  }
}
/** Reopen the original owned lease for cancellation/settlement only. This never
 * acquires a target, creates a certificate, renews a deadline or permits grants. */
export function restoreArtifactTargetLeaseForSettlement(
  authority: VerifiedExecutionAuthority,
): ArtifactTargetLease {
  const a = executionAuthorityState(authority);
  const retained = z
    .strictObject({ leaseId: uuid, certificateDigest: digest })
    .parse(
      readPrivateRecord(a.installation, "execution-leases", `${a.execution.operationKey}.json`),
    );
  const s = openState(a.installation.dataRoot, retained.leaseId, a.installation);
  try {
    const saved = z
      .strictObject({
        certificate: signedCertificateSchema,
        privateKey: z.string(),
        executionReceiptDigest: digest,
      })
      .parse(readPrivateRecord(a.installation, "leases", `${retained.leaseId}.json`));
    if (
      controlDigest(s.execution) !== controlDigest(a.execution) ||
      retained.certificateDigest !== controlDigest(s.certificateEnvelope) ||
      controlDigest(saved.certificate) !== retained.certificateDigest ||
      saved.executionReceiptDigest !== a.receiptDigest ||
      !sameControlOrigin(a.origin, s.certificate.origin)
    )
      throw Error("Original retained lease identity changed");
    s.key = createPrivateKey({
      key: Buffer.from(saved.privateKey, "base64url"),
      type: "pkcs8",
      format: "der",
    });
    s.authority = a;
    s.verifiedAuthority = authority;
    s.settlementOnly = true;
    const lease = Object.freeze({
      leaseId: retained.leaseId,
      owner: s.execution,
      serviceIds: s.certificate.serviceIds,
      mode: "owner" as const,
    });
    handles.set(lease, s);
    return lease;
  } catch (error) {
    closeState(s);
    throw error;
  }
}
/** Reopen only the actual prepared owner's already-authorized frozen phase
 * issuer. Its ordinary terminal execution still cannot perform a target
 * effect; only the existing finite delegation publisher consumes this handle.
 * No lease/root/certificate, clock, target or reservation is allocated. */
export function restoreConfigurationMaintenancePhaseIssuer(
  authority: VerifiedExecutionAuthority,
  phase:
    | "configuration-commit"
    | "maintenance-hardlinks"
    | "maintenance-recreate"
    | "maintenance-handoff",
): ArtifactTargetLease {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configurationMaintenance.prepare" ||
    ![
      "configuration-commit",
      "maintenance-hardlinks",
      "maintenance-recreate",
      "maintenance-handoff",
    ].includes(phase)
  )
    throw Error("Original authorized maintenance phase issuer required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    s = stateOf(lease);
  try {
    guarded(s, () =>
      withControlDelegationPublication(authority, phase, () => {
        if (
          s.node !== null ||
          tree(s).root.phase !== "held" ||
          s.slots?.release ||
          !owner.reservations.some((value) => value.phase === phase)
        )
          throw Error("Original frozen maintenance root is fenced");
        s.settlementOnly = false;
      }),
    );
    return lease;
  } catch (error) {
    closeArtifactTargetLeaseHandle(lease);
    throw error;
  }
}
export async function reconcileArtifactTargetLease(options: {
  dataRoot: string;
  leaseId: string;
  authority: VerifiedRecoveryAuthority;
}): Promise<"released" | "fenced"> {
  const recovery = recoveryAuthorityState(options.authority);
  const s = openState(options.dataRoot, options.leaseId, recovery.authority.installation, true);
  try {
    if (controlDigest(s.execution) !== controlDigest(recovery.authority.execution))
      throw Error("Foreign recovery execution");
    const saved = z
      .object({
        certificate: signedCertificateSchema,
        privateKey: z.string(),
        executionReceiptDigest: digest,
      })
      .parse(readPrivateRecord(s.installation, "leases", `${options.leaseId}.json`));
    if (
      controlDigest(saved.certificate) !== controlDigest(s.certificateEnvelope) ||
      saved.executionReceiptDigest !== recovery.authority.receiptDigest
    )
      throw Error("Recovery certificate mismatch");
    s.key = createPrivateKey({
      key: Buffer.from(saved.privateKey, "base64url"),
      type: "pkcs8",
      format: "der",
    });
    if (recovery.authority.kind === "configurationMaintenance.prepare") {
      s.authority = recovery.authority;
      s.verifiedAuthority = restoreAdmittedControlExecution(
        s.installation.installation,
        recovery.authority.execution,
      );
    }
    const t = tree(s);
    if (
      !knownOutcome(recovery.evidence) ||
      [...t.grants.keys()].some(
        (id) =>
          t.children.get(id)?.phase !== "settled" || !knownOutcome(t.children.get(id)?.settlement),
      )
    )
      return "fenced";
    if (s.slots?.release) {
      finishOwnedRelease(s);
      return "released";
    }
    await guarded(s, () => {
      if (s.authority?.kind === "configurationMaintenance.prepare") {
        if (!s.verifiedAuthority) throw Error("Original maintenance recovery authority required");
        assertMaintenanceClosureFromTree(s, s.verifiedAuthority);
      }
      const root = readRoot(s);
      root.settlement = recovery.evidence;
      root.phase = "settled";
      root.sequence++;
      writeNode(s, root);
    });
    const lease = Object.freeze({
      leaseId: options.leaseId,
      owner: s.execution,
      serviceIds: s.certificate.serviceIds,
      mode: "owner" as const,
    });
    handles.set(lease, s);
    await releaseArtifactTargetLease(lease);
    return "released";
  } finally {
    closeState(s);
  }
}
/** Finish only this original unused root, including its existing partial
 * release cursor. No acquisition, forward authority, new clock or caller ID. */
export async function reconcileConfigurationPreEffectRoot(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  inspectConfigurationPreEffectRefusal(authority);
  const state = executionAuthorityState(authority),
    name = `${state.execution.operationKey}.json`;
  if (!state.origin) throw Error("Original pre-effect root source required");
  let raw: unknown;
  try {
    raw = readPrivateRecord(state.installation, "execution-leases", name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && state.kind === "service.pull") return;
    throw error;
  }
  if (raw === null && state.kind === "service.pull") return;
  if (state.kind === "service.pull")
    throw Error("Normal coordinator pull cannot own a physical target root");
  const reference = z.strictObject({ leaseId: uuid, certificateDigest: digest }).parse(raw);
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "execution-leases", container: "", name },
    canonicalJson(raw),
  );
  const ownerName = `${reference.leaseId}.json`,
    saved = readPrivateRecord(state.installation, "leases", ownerName);
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "leases", container: "", name: ownerName },
    canonicalJson(saved),
  );
  if (
    controlDigest((saved as { certificate: unknown }).certificate) !== reference.certificateDigest
  )
    throw Error("Original pre-effect root certificate changed");
  try {
    verifyRetainedArtifactTargetRootRelease(authority);
    return;
  } catch {
    /* Only the existing exact recovery path may finish a partial release. */
  }
  if (
    (await reconcileArtifactTargetLease({
      dataRoot: state.installation.dataRoot,
      leaseId: reference.leaseId,
      authority: verifyControlRecoveryAuthority(authority),
    })) !== "released"
  )
    throw Error("Original pre-effect root remains fenced");
  verifyRetainedArtifactTargetRootRelease(authority);
}
export async function withArtifactTargetLease<T>(
  options: {
    dataRoot: string;
    serviceIds: readonly string[];
    owner: VerifiedExecutionAuthority;
    inherited?: BorrowedArtifactTargetLease;
    signal?: AbortSignal;
  },
  run: (lease: TargetLeaseAuthority) => Promise<T>,
): Promise<T> {
  if (options.inherited) {
    assertControlExecutionForward(options.owner);
    const state = stateOf(options.inherited);
    const requestedRoot = new AnchoredDirectory(options.dataRoot);
    try {
      if (!sameInode(identity(requestedRoot.stat), state.certificate.dataRootIdentity))
        throw Error("Inherited physical root mismatch");
    } finally {
      requestedRoot.close();
    }
    const authority = executionAuthorityState(options.owner);
    if (
      controlDigest(state.execution) !== controlDigest(authority.execution) ||
      options.serviceIds.some((id) => !options.inherited?.serviceIds.includes(id))
    )
      throw Error("Inherited target closure cannot widen or reacquire");
    assertArtifactTargetLeaseForward(options.inherited);
    const inheritedGrant = state.node === null ? undefined : tree(state).grants.get(state.node);
    if (inheritedGrant?.recipient === "configuration-helper")
      verifyConfigurationHelperReady(options.inherited);
    return run(options.inherited);
  }
  const lease = await acquireArtifactTargetLease(options);
  try {
    assertArtifactTargetLeaseForward(lease);
    const result = await run(lease);
    await releaseArtifactTargetLease(lease);
    return result;
  } catch (e) {
    const s = stateOf(lease);
    try {
      await guarded(s, () => {
        const root = readRoot(s);
        if (root.phase !== "settled") {
          root.phase = "recovery_required";
          root.sequence++;
          writeNode(s, root);
        }
      });
    } finally {
      closeState(s);
    }
    throw e;
  }
}

/** Verification-only preview for fixed admission adapters. No adoption or effect authority. */
export function inspectArtifactDelegation(options: {
  dataRoot: string;
  assertion: string;
  installation: import("./control-authority").ControlInstallation;
}) {
  const parsed = parseControlAssertion(options.assertion);
  const s = openState(options.dataRoot, parsed.leaseId, installationState(options.installation));
  try {
    const t = tree(s);
    const grant = t.grants.get(parsed.delegationId);
    if (!grant || parsed.ownerCertificateDigest !== controlDigest(s.certificateEnvelope))
      throw Error("Unanchored delegation");
    const parent = grant.parentNode
      ? required(t.grants.get(grant.parentNode), "Missing parent grant")
      : undefined;
    const parentKey = parent?.childPublicKey ?? s.certificate.ownerPublicKey;
    const { signature, ...fields } = parsed;
    verifyControl(
      parentKey,
      "openmapx-lease-assertion-v1",
      { payload: fields, signature },
      assertionSchema.omit({ signature: true }),
    );
    const parentNode = grant.parentNode
      ? required(t.children.get(grant.parentNode), "Missing parent adoption")
      : t.root;
    if (parentNode.grantDigests[grant.delegationId] !== parsed.grantDigest)
      throw Error("Grant digest mismatch");
    return Object.freeze({
      leaseId: parsed.leaseId,
      ownerCertificateDigest: controlDigest(s.certificateEnvelope),
      owner: s.certificate.owner,
      origin: grant.origin,
      parent: grant.parent,
      execution: grant.child,
      kind: grant.childKind,
      serviceIds: Object.freeze([...grant.serviceIds]),
      recipient: grant.recipient,
      phase: grant.phase,
      delegationId: grant.delegationId,
      retained: !!t.children.get(grant.delegationId),
    });
  } finally {
    closeState(s);
  }
}
/** Read-only FIRST-use check for the fixed logical guard settlement receiver.
 * It consumes the DM's ACTUAL retained preparation assertion, checks the same
 * anchored physical root/all ordinary descendants, and returns no lease/peer,
 * execution or forward capability. Historical settled observations omit it. */
export function verifyConfigurationFenceSettlementHeldOwner(
  installation: import("./control-authority").ControlInstallation,
  originalPrepareAssertion: string,
  expected: {
    ownerPrepare: ExecutionRef;
    ownerCertificateDigest: string;
    serviceIds: readonly string[];
  },
): void {
  const local = installationState(installation),
    parsed = parseControlAssertion(originalPrepareAssertion),
    inspected = inspectArtifactDelegation({
      installation,
      dataRoot: local.dataRoot,
      assertion: originalPrepareAssertion,
    }),
    state = openState(local.dataRoot, parsed.leaseId, local);
  try {
    guarded(state, () => {
      const current = tree(state);
      if (
        installation.role !== "data-manager" ||
        local.fixedChildId ||
        inspected.kind !== "configuration-maintenance.prepare" ||
        inspected.phase !== "configuration-fence" ||
        inspected.recipient !== "data-manager" ||
        canonicalJson(inspected.parent) !== canonicalJson(expected.ownerPrepare) ||
        canonicalJson(inspected.owner) !== canonicalJson(expected.ownerPrepare) ||
        inspected.ownerCertificateDigest !== expected.ownerCertificateDigest ||
        canonicalJson(state.certificate.serviceIds) !== canonicalJson(expected.serviceIds) ||
        current.root.phase === "settled" ||
        state.slots?.release ||
        [...current.children.values()].some(
          (child) => child.phase !== "settled" || !knownOutcome(child.settlement),
        )
      )
        throw Error("Original logical settlement owner/ordinary children unresolved");
    });
  } finally {
    closeState(state);
  }
}
/** Historical retirement only: the original prepared assertion and complete
 * physical tree must prove actual release. Returns no peer/lease/forward grant. */
export function verifyConfigurationFenceSettlementReleasedOwner(
  installation: import("./control-authority").ControlInstallation,
  originalPrepareAssertion: string,
  expected: {
    ownerPrepare: ExecutionRef;
    ownerCertificateDigest: string;
    serviceIds: readonly string[];
  },
): number {
  const local = installationState(installation),
    parsed = parseControlAssertion(originalPrepareAssertion),
    state = openState(local.dataRoot, parsed.leaseId, local, true);
  try {
    const current = tree(state),
      grant = required(
        current.grants.get(parsed.delegationId),
        "Original preparation grant required",
      ),
      parent = grant.parentNode
        ? required(current.grants.get(grant.parentNode), "Original preparation parent required")
        : undefined,
      parentNode = grant.parentNode
        ? required(current.children.get(grant.parentNode), "Original preparation adoption required")
        : current.root,
      { signature, ...fields } = parsed;
    verifyControl(
      parent?.childPublicKey ?? state.certificate.ownerPublicKey,
      "openmapx-lease-assertion-v1",
      { payload: fields, signature },
      assertionSchema.omit({ signature: true }),
    );
    if (
      installation.role !== "data-manager" ||
      local.fixedChildId ||
      grant.childKind !== "configuration-maintenance.prepare" ||
      grant.phase !== "configuration-fence" ||
      grant.recipient !== "data-manager" ||
      parentNode.grantDigests[grant.delegationId] !== parsed.grantDigest ||
      canonicalJson(grant.parent) !== canonicalJson(expected.ownerPrepare) ||
      canonicalJson(state.certificate.owner) !== canonicalJson(expected.ownerPrepare) ||
      parsed.ownerCertificateDigest !== controlDigest(state.certificateEnvelope) ||
      parsed.ownerCertificateDigest !== expected.ownerCertificateDigest ||
      canonicalJson(state.certificate.serviceIds) !== canonicalJson(expected.serviceIds) ||
      current.root.phase !== "settled" ||
      !knownOutcome(current.root.settlement) ||
      state.slots?.release?.phase !== "released" ||
      !Number.isSafeInteger(state.slots.releasedAt) ||
      !state.slots.releasedAt ||
      [...current.children.values()].some(
        (child) => child.phase !== "settled" || !knownOutcome(child.settlement),
      )
    )
      throw Error("Original prepared root release required for retirement");
    return state.slots.releasedAt;
  } finally {
    closeState(state);
  }
}

export async function cancelArtifactTargetLease(
  lease: TargetLeaseAuthority,
): Promise<readonly ExecutionRef[]> {
  const s = stateOf(lease);
  return guarded(s, () => {
    const t = tree(s);
    const node =
      s.node === null ? t.root : required(t.children.get(s.node), "Missing retained child node");
    if (node.phase !== "settled") {
      node.phase = "cancel_pending";
      node.sequence++;
      writeNode(s, node);
      tree(s);
    }
    // These immutable attempted identities are the adapter's cancellation
    // outbox, including lost admissions. No descendant evidence is released.
    return Object.freeze(
      [...t.grants.values()]
        .filter((grant) => {
          let parent = grant.parentNode;
          if (s.node === null) return true;
          while (parent !== null) {
            if (parent === s.node) return true;
            parent = t.grants.get(parent)?.parentNode ?? null;
          }
          return false;
        })
        .map((grant) => Object.freeze({ ...grant.child })),
    );
  });
}

/** A helper can adopt before its preparer exits, but may not enter drain/writer work before terminal preparation. */
export function verifyConfigurationHelperReady(lease: BorrowedArtifactTargetLease): void {
  const s = stateOf(lease);
  const t = tree(s);
  const grant = s.node === null ? undefined : t.grants.get(s.node);
  if (
    grant?.recipient !== "configuration-helper" ||
    grant.phase !== "configuration-handoff" ||
    !forwardAncestry(t, s.node) ||
    Date.now() >= grant.child.deadlineAt
  )
    throw Error("Configuration helper cannot enter drain");
  verifyControlPreparedTerminal(s.installation, grant.parent);
}

/** Observation/adoption of an old identity is not permission to start another forward effect. */
export function assertArtifactTargetLeaseForward(lease: TargetLeaseAuthority): void {
  const s = stateOf(lease);
  if (s.settlementOnly) throw Error("Recovered lease permits settlement only");
  if (!s.certificate.origin)
    throw Error("Legacy lease is observation/settlement only; upgrade producer");
  assertOriginClockForward(s.installation, s.certificate.origin);
  if (s.verifiedAuthority) assertControlExecutionForward(s.verifiedAuthority);
  const t = tree(s);
  const node = s.node === null ? t.root : t.children.get(s.node);
  if (!node || !forwardAncestry(t, s.node) || Date.now() >= s.execution.deadlineAt)
    throw Error("Target lease permits observation/settlement only");
}
/** Fixed catalog-store adapter; caller DTOs cannot construct physical ownership. */
export function catalogPinTargetOwner(lease: TargetLeaseAuthority) {
  assertArtifactTargetLeaseForward(lease);
  const s = stateOf(lease);
  if (!s.certificate.serviceIds.includes("motis") || !s.certificate.origin)
    throw Error("MOTIS target authority required for catalog pins");
  if (!["ops-agent", "host-cli"].includes(s.installation.installation.role))
    throw Error("Catalog pins are owned by the agent or standalone host CLI");
  return {
    installation: s.installation.installation,
    execution: s.execution,
    origin: s.certificate.origin,
  };
}
export function assertArtifactTargetLeaseExecution(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): void {
  const state = stateOf(lease);
  if (controlDigest(state.execution) !== controlDigest(execution))
    throw Error("Lifecycle lease execution mismatch");
  assertArtifactTargetLeaseForward(lease);
}

/** Receipt-only evidence: the exact physical owner may record containment after cancellation.
 * This does not authorize a forward effect, delegation, acquisition or release. */
export function assertArtifactTargetLeaseReceiptOwner(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): void {
  const s = stateOf(lease);
  if (controlDigest(s.execution) !== controlDigest(execution))
    throw Error("Receipt lease execution mismatch");
  const t = tree(s),
    node = s.node === null ? t.root : t.children.get(s.node);
  if (!node || node.phase === "settled") throw Error("Receipt owner is already settled");
}

/** Drop local descriptors only. Durable locks, ownership and all unknown fences remain untouched. */
export function closeArtifactTargetLeaseHandle(lease: TargetLeaseAuthority): void {
  const s = handles.get(lease);
  if (!s) throw Error("Unverified target lease handle");
  closeState(s);
  handles.delete(lease);
}

/** Read-only terminal evidence after root release: never mints a reusable lease handle. */
export function verifyRetainedArtifactTargetSettlement(
  installation: import("./control-authority").ControlInstallation,
  adoption: import("./control-authority").ControlAdoption,
  execution: ExecutionRef,
): void {
  const local = installationState(installation);
  const s = openState(local.dataRoot, adoption.leaseId, local, true);
  try {
    const t = tree(s);
    const child = t.children.get(adoption.delegationId);
    const proof = childSettlementState(verifyControlEffectSettlement(installation, execution));
    if (
      child?.phase !== "settled" ||
      !knownOutcome(child.settlement) ||
      controlDigest(child.execution) !== controlDigest(execution) ||
      controlDigest(child.settlement) !== controlDigest(proof.evidence)
    )
      throw Error("Terminal child settlement is not proved");
  } finally {
    closeState(s);
  }
}

// Fixed closure and original children consume this module's one nominal tree observation.
export function readOriginalMaintenanceFinalChildren(
  authority: VerifiedExecutionAuthority,
  observation: ConfigurationMaintenanceClosureObservation,
) {
  const state = executionAuthorityState(authority),
    tree = configurationMaintenanceClosureObservationState(observation, authority),
    admitted = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: { maintenanceId?: string } } },
    name = `${admitted.payload?.operation?.maintenanceId}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name),
    owner = verifyControl(
      state.installation.installation.publicKey,
      "openmapx-configuration-maintenance-owner-v2",
      raw,
      configurationMaintenanceOwnerRecordSchema,
    );
  assertConfigurationMaintenanceDecisionSource(owner);
  verifyFamilyOwnedRecord(
    state.installation,
    owner.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name },
    canonicalJson(raw),
  );
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    !owner.guardSource ||
    tree.certificateDigest !== owner.rootCertificateDigest ||
    owner.admissionDigest !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution)
  )
    throw Error("Original final child owner required");
  const children: ReturnType<typeof configurationChildEvidenceSchema.parse>[] = [],
    allowed = new Set([controlDigest(owner.guardSource.prepareExecution)]);
  for (const step of owner.plan.steps) {
    const source = owner.apiControls.steps.find((value) => value.ordinal === step.ordinal),
      publication = inspectControlChildPublication(authority, step);
    if (!source) {
      if (publication.binding !== null || publication.publication.state !== "unissued")
        throw Error("Frozen child attempt has no original source");
      continue;
    }
    if (!source.canonical || !source.receiptDelivery)
      throw Error("Original frozen child canonical delivery pending");
    const actual = configurationMaintenanceChildState(
        verifyConfigurationMaintenanceChildTerminal(
          authority,
          step.ordinal,
          source.canonical.status,
          source.canonical.terminalAt,
        ),
        authority,
      ),
      physical = tree.children.find(
        (value) => canonicalJson(value.execution) === canonicalJson(actual.execution),
      );
    if (!physical || canonicalJson(physical.settlement) !== canonicalJson(actual.settlement))
      throw Error("Original child physical settlement changed");
    allowed.add(controlDigest(actual.execution));
    children.push(
      configurationChildEvidenceSchema.parse({
        planIndex: step.ordinal,
        execution: actual.execution,
        terminalDigest: actual.terminalDigest,
        terminalAt: actual.terminalAt,
        effectSettlementDigest: actual.effectSettlementDigest,
        publication: actual.settlement.publication,
      }),
    );
    if (step.phase === "maintenance-hardlinks" && owner.plan.nestedHardlinks) {
      const child = restoreAdmittedControlExecution(
          state.installation.installation,
          actual.execution,
        ),
        binding = lookupControlChildPhaseBinding(child, owner.plan.nestedHardlinks);
      if (!binding) throw Error("Original middle owner's DM leaf unavailable");
      const terminal = verifyDataControlTerminalWitness(
          state.installation.installation,
          binding.child.execution,
        ),
        physical = tree.children.find(
          (value) => canonicalJson(value.execution) === canonicalJson(binding.child.execution),
        );
      if (
        !physical ||
        physical.settlement.outcome !== "committed" ||
        physical.settlement.publication !== "committed" ||
        terminal.status.kind !== "generation-hardlinks" ||
        terminal.status.status !== "ok" ||
        terminal.status.publication !== "committed" ||
        terminal.status.result?.kind !== "generation-hardlinks"
      )
        throw Error("Original exact DM generation leaf settlement unavailable");
      allowed.add(controlDigest(binding.child.execution));
      children.push(
        configurationChildEvidenceSchema.parse({
          planIndex: step.ordinal,
          execution: binding.child.execution,
          terminalDigest: terminal.terminalDigest,
          terminalAt: terminal.terminalAt,
          effectSettlementDigest: controlDigest(physical.settlement),
          publication: "committed",
        }),
      );
    }
  }
  if (
    tree.children.some((value) => !allowed.has(controlDigest(value.execution))) ||
    tree.children.length !== allowed.size
  )
    throw Error("Unaccounted original maintenance descendant");
  children.sort(
    (a, b) =>
      a.planIndex - b.planIndex || a.execution.operationKey.localeCompare(b.execution.operationKey),
  );
  return {
    ownerDigest: controlDigest(owner),
    children,
    complete: owner.plan.steps.every((step) =>
      owner.apiControls.steps.some(
        (value) => value.ordinal === step.ordinal && value.canonical && value.receiptDelivery,
      ),
    ),
    generation: children.find((value) => value.planIndex === 0),
    generationResult: owner.apiControls.steps.find((value) => value.ordinal === 0)?.canonical
      ? configurationApplyResultSchema.parse(
          owner.apiControls.steps.find((value) => value.ordinal === 0)!.canonical!.status.result,
        )
      : null,
    followUpReceiptDigests: [
      ...new Set(
        children.filter((value) => value.planIndex !== 0).map((value) => value.terminalDigest),
      ),
    ].sort(),
  };
}

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
/** PreparedAndSettled uses the actual private inspector/final, original
 * prepared physical child, full signed logical terminal/admission/effect and
 * durable sender copy/ACK. Parsed prepared status alone cannot enter it. */
function assertPreparedAndSettledClosure(
  authority: VerifiedExecutionAuthority,
  observation: ConfigurationMaintenanceClosureObservation,
  input: unknown,
): void {
  const tree = configurationMaintenanceClosureObservationState(observation, authority);
  const state = executionAuthorityState(authority),
    owner = configurationMaintenanceOwnerRecordSchema.parse(input);
  assertConfigurationMaintenanceDecisionSource(owner);
  assertFixedConfigurationMaintenancePlan(owner.plan, owner.installationId);
  if (
    owner.final?.ownerFinal.payload.outcome === "applied" ||
    owner.final?.ownerFinal.payload.outcome === "contained"
  ) {
    const contained = owner.final.ownerFinal.payload.outcome === "contained";
    if (contained) assertContainedConfigurationMaintenanceFinalState(owner);
    else assertAppliedConfigurationMaintenanceFinalState(owner);
    const actual = readOriginalMaintenanceFinalChildren(authority, observation);
    need(
      (contained
        ? actual.generationResult?.outcome === "not_committed" &&
          !actual.generationResult.cleanupFailed &&
          actual.children.length === 1
        : actual.complete) &&
        same(actual.children, owner.final.evidence.children) &&
        owner.final.evidence.generation.commitReceiptDigest ===
          (contained ? null : actual.generation?.terminalDigest) &&
        same(owner.final.evidence.followUp.receiptDigests, actual.followUpReceiptDigests),
      "Original applied final child sources changed",
    );
  } else assertUnusedConfigurationMaintenanceFinalState(owner);
  need(
    owner.final &&
      owner.inspection &&
      owner.guardSource &&
      owner.capacity &&
      owner.apiControls.decide?.receiptDelivery &&
      !owner.noGuard,
    "Actual prepared final/inspection/guard source required",
  );
  need(
    owner.installationId === state.installation.installation.installationId &&
      owner.admissionDigest === state.receiptDigest &&
      same(owner.origin, state.origin) &&
      same(owner.plan.prepare, state.execution) &&
      owner.rootCertificateDigest === tree.certificateDigest &&
      same(owner.plan.reservations, state.reservations),
    "Original prepared root identity changed",
  );
  const final = verifyControl(
      state.installation.installation.publicKey,
      domains.ownerFinal,
      owner.final.ownerFinal,
      configurationOwnerFinalSchema,
    ),
    inspection = verifyControl(
      state.installation.installation.publicKey,
      domains.inspection,
      owner.inspection,
      configurationMaintenanceRuntimeInspectionSchema,
    );
  verifyControl(
    state.installation.installation.publicKey,
    configurationMaintenanceDecisionCommitmentDomain,
    owner.apiControls.decide.commitment,
    configurationMaintenanceDecisionCommitmentPayloadSchema,
  );
  need(
    final.privateInspectionId === inspection.inspectionId &&
      final.evidenceDigest === owner.final.evidenceDigest,
    "Original actual final/inspection changed",
  );
  for (const step of final.outcome === "unused" ? owner.plan.steps : []) {
    const phase = inspectControlChildPublication(authority, step);
    need(
      phase.binding === null && phase.publication.state === "unissued",
      "Unused final has attempted frozen work",
    );
  }
  const prepare = state.reservations.find((value) => value.phase === "configuration-fence"),
    settle = state.reservations.find((value) => value.phase === "configuration-fence-settle");
  need(
    prepare &&
      settle &&
      inspectControlChildPublication(authority, settle).publication.state === "unissued",
    "Original purpose-only settlement reservation required",
  );
  const descriptors = configurationSettlementRecordDescriptors(
      { ownerPrepare: state.execution, reservation: settle },
      prepare.execution.operationKey,
    ),
    control = verifyControl(
      state.installation.installation.publicKey,
      domains.control,
      readConfigurationSettlementCell(
        state.installation,
        { origin: owner.origin },
        descriptors.sender[2]!,
      ),
      configurationSettlementControlCellSchema.shape.payload,
    ),
    projection = verifyControl(
      state.installation.installation.publicKey,
      domains.signedProjection,
      control.projection,
      configurationSettlementReservationProjectionSchema,
    ),
    committed = verifyControl(
      state.installation.installation.publicKey,
      domains.reference,
      readConfigurationSettlementCell(state.installation, projection, descriptors.sender[0]!),
      configurationCommittedSettlementSchema,
    );
  need(
    control.binding &&
      !("unused" in control) &&
      same(projection.ownerPrepare, state.execution) &&
      projection.rootAdmissionDigest === state.receiptDigest &&
      projection.rootCertificateDigest === tree.certificateDigest &&
      same(projection.reservation, settle) &&
      same(projection.operation, {
        kind: "configuration-maintenance.settle",
        ...owner.plan.dmSettle,
      }) &&
      projection.reservationDigest === settlementRecordDigest(domains.reservationTuple, settle) &&
      projection.reservation.operationFingerprint === controlDigest(projection.operation) &&
      projection.settlementId === final.identity.settlementId &&
      projection.planDigest === owner.plan.planDigest &&
      same(committed.identity, final.identity) &&
      same(committed.final, final) &&
      same(committed.evidence, owner.final.evidenceProjection) &&
      committed.evidenceDigest === owner.final.evidenceDigest &&
      committed.ownerReceiptDigest === owner.final.ownerReceiptDigest &&
      committed.committedAt === final.settlingAt &&
      committed.referenceOperationFingerprint === settle.operationFingerprint,
    "Original committed prepared settlement changed",
  );
  const envelope = verifyControl(
      state.installation.installation.publicKey,
      domains.control,
      control.binding,
      configurationSettlementControlEnvelopeSchema,
    ),
    binding = verifyControl(
      state.installation.installation.publicKey,
      domains.binding,
      readConfigurationSettlementCell(state.installation, projection, descriptors.sender[1]!),
      configurationSettlementControlEnvelopeSchema,
    ),
    capacity = verifyControl(
      state.installation.publicKeys["data-manager"],
      domains.capacity,
      owner.capacity,
      configurationSettlementCapacitySchema,
    ),
    commitmentDigest = settlementRecordDigest(domains.commitment, committed),
    {
      operationFingerprint: _op,
      fingerprint: _fp,
      deadlineAt: _deadline,
      ...address
    } = envelope.execution,
    slot = readConfigurationSettlementFamilySlot(state.installation, projection);
  need(
    same(binding, envelope) &&
      envelope.installationId === owner.installationId &&
      same(envelope.origin, owner.origin) &&
      same(envelope.ownerPrepare, state.execution) &&
      envelope.admissionDigest === state.receiptDigest &&
      envelope.rootCertificateDigest === tree.certificateDigest &&
      envelope.settlementId === projection.settlementId &&
      envelope.projectionDigest === settlementRecordDigest(domains.projection, projection) &&
      envelope.reservationDigest === projection.reservationDigest &&
      envelope.commitmentDigest === commitmentDigest &&
      same(envelope.operation, projection.operation) &&
      same(address, settle.execution) &&
      envelope.execution.operationFingerprint === settle.operationFingerprint &&
      same(envelope.serviceIds, owner.plan.serviceIds) &&
      envelope.execution.fingerprint ===
        executionFingerprint({
          kind: projection.operation.kind,
          operationFingerprint: settle.operationFingerprint,
          deadlineAt: envelope.controlDeadlineAt,
          parent: {
            issuer: "ops-agent",
            operationKey: state.execution.operationKey,
            fingerprint: state.execution.fingerprint,
            deadlineAt: state.execution.deadlineAt,
            execution: state.execution,
          },
        }) &&
      slot.state === "bound" &&
      slot.executionDigest === controlDigest(envelope.execution) &&
      slot.controlBindingDigest === settlementRecordDigest(domains.binding, envelope),
    "Original prepared logical binding changed",
  );
  verifyPublishedBoundDmConfigurationSettlementSlots(
    state.installation,
    projection,
    owner.capacity,
  );
  const opened: AnchoredDirectory[] = [],
    own = (directory: AnchoredDirectory) => {
      opened.push(directory);
      return directory;
    };
  try {
    const root = own(new AnchoredDirectory(state.installation.dataRoot)),
      shared = own(root.directory(".admin-target-control")),
      executions = own(shared.directory("executions")),
      dm = own(executions.directory("data-manager")),
      prepared = verifyControl(
        state.installation.publicKeys["data-manager"],
        dataConfigurationFencePreparedWitnessDomain,
        JSON.parse(
          dm.read(`${prepare.execution.operationKey}.data-terminal.json`, 8192).toString("utf8"),
        ),
        dataConfigurationFencePreparedWitnessSchema,
      ),
      terminalBytes = dm.read(
        `${envelope.execution.operationKey}.configuration-settlement-terminal.json`,
        4096,
      ),
      signedTerminal = JSON.parse(terminalBytes.toString("utf8")),
      terminal = verifyControl(
        state.installation.publicKeys["data-manager"],
        domains.terminal,
        signedTerminal,
        configurationSettlementPublishedTerminalSchema,
      ),
      tuple = terminal.tuple,
      guard = owner.guardSource,
      physical = tree.children.find((value) => same(value.execution, guard.prepareExecution));
    need(
      terminalBytes.length === 4096 &&
        same(prepared, guard) &&
        physical &&
        physical.settlement.outcome === "committed" &&
        physical.settlement.publication === "committed" &&
        physical.settlement.terminalReceiptDigest === guard.effectReceiptDigest &&
        guard.effectSettlementDigest ===
          controlDigest({
            ...physical.settlement,
            receipt: {
              kind: "data-configuration-fence",
              receipt: guard.preparedReceipt,
              guardDigest: guard.guardDigest,
            },
          }),
      "Original actual prepared child proof changed",
    );
    const admissionPayload = configurationSettlementAdmissionSchema.parse({
        version: 2,
        purpose: "configuration-fence-settlement",
        installationId: owner.installationId,
        origin: owner.origin,
        settlementId: projection.settlementId,
        projectionDigest: envelope.projectionDigest,
        reservationDigest: envelope.reservationDigest,
        prepareExecutionDigest: controlDigest(guard.prepareExecution),
        prepareAdmissionDigest: guard.prepareAdmissionDigest,
        preparedReceiptDigest: guard.preparedReceiptDigest,
        capacityReceiptDigest: settlementRecordDigest(domains.capacity, capacity),
        rootCertificateDigest: tree.certificateDigest,
        controlEnvelope: control.binding,
        commitmentDigest,
        executionOrdinal: capacity.reservedExecutionOrdinal,
        intentOrdinal: capacity.reservedIntentOrdinal,
        sqlSessionNonce: envelope.execution.executionId,
        boundAt: terminal.admissionSource.boundAt,
      }),
      admission = verifyControl(
        state.installation.publicKeys["data-manager"],
        domains.admission,
        { payload: admissionPayload, signature: terminal.admissionSource.signature },
        configurationSettlementAdmissionSchema,
      ),
      effect = verifyControl(
        state.installation.publicKeys["data-manager"],
        domains.effect,
        {
          payload: { ...terminal.effectSource.fields, terminal: tuple },
          signature: terminal.effectSource.signature,
        },
        configurationSettlementEffectSchema,
      ),
      { terminalDigest, ...tuplePreimage } = tuple;
    need(
      same(terminal.origin, owner.origin) &&
        same(tuple.execution, envelope.execution) &&
        tuple.settlementId === projection.settlementId &&
        tuple.commitmentDigest === commitmentDigest &&
        tuple.fenceId === guard.preparedReceipt.fenceId &&
        same(tuple.result, {
          ...guard.preparedReceipt,
          state: "settled",
          sequence: guard.preparedReceipt.sequence + 1,
        }) &&
        tuple.terminalAt >= envelope.controlStartedAt &&
        tuple.terminalAt < envelope.controlDeadlineAt &&
        terminalDigest === settlementRecordDigest(domains.terminal, tuplePreimage) &&
        terminal.admissionDigest === settlementRecordDigest(domains.admission, admission) &&
        admission.boundAt >= envelope.controlStartedAt &&
        admission.boundAt < envelope.controlDeadlineAt &&
        effect.phase === "committed" &&
        same(effect.origin, owner.origin) &&
        effect.settlementId === projection.settlementId &&
        effect.controlExecutionDigest === controlDigest(envelope.execution) &&
        effect.controlEnvelopeDigest === settlementRecordDigest(domains.binding, envelope) &&
        effect.admissionDigest === terminal.admissionDigest &&
        effect.commitmentDigest === commitmentDigest &&
        effect.preparedReceiptDigest === guard.preparedReceiptDigest &&
        effect.expectedDmSequence === guard.preparedReceipt.sequence &&
        effect.sqlSession.sessionNonce === envelope.execution.executionId &&
        effect.attemptedAt >= admission.boundAt &&
        effect.attemptedAt < envelope.controlDeadlineAt &&
        terminal.effectSettlementDigest === settlementRecordDigest(domains.effect, effect),
      "Actual original logical guard settlement required",
    );
    const copied = configurationSettlementSenderAckCellSchema.parse(
        readConfigurationSettlementCell(state.installation, projection, descriptors.sender[4]!),
      ),
      sharedAck = readConfigurationSettlementCell(
        state.installation,
        projection,
        descriptors.sender[5]!,
      );
    need(
      same(copied.terminal, signedTerminal) && copied.ack && same(copied.ack, sharedAck),
      "Original durable sender copy/ACK required",
    );
    const ack = verifyControl(
      state.installation.installation.publicKey,
      domains.ack,
      sharedAck,
      configurationSettlementAckSchema,
    );
    need(
      ack.installationId === owner.installationId &&
        same(ack.origin, owner.origin) &&
        ack.settlementId === projection.settlementId &&
        ack.controlExecutionDigest === controlDigest(envelope.execution) &&
        ack.commitmentDigest === commitmentDigest &&
        ack.terminalDigest === tuple.terminalDigest &&
        ack.terminalAt === tuple.terminalAt,
      "Original exact sender settlement ACK changed",
    );
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
export function assertConfigurationMaintenanceRootClosure(
  authority: VerifiedExecutionAuthority,
  observed: ConfigurationMaintenanceClosureObservation,
): void {
  const state = executionAuthorityState(authority),
    tree = configurationMaintenanceClosureObservationState(observed, authority);
  need(
    state.kind === "configurationMaintenance.prepare" &&
      state.installation.installation.role === "ops-agent" &&
      !state.installation.fixedChildId &&
      state.origin,
    "Original maintenance root closure source required",
  );
  const admission = readPrivateRecord(
      state.installation,
      "executions",
      `${state.execution.operationKey}.json`,
      65536,
    ) as { payload?: { operation?: { maintenanceId?: string } } },
    name = `${z.uuid().parse(admission.payload?.operation?.maintenanceId)}.json`,
    raw = readPrivateRecord(state.installation, "configuration-maintenance", name),
    owner = verifyControl(
      state.installation.installation.publicKey,
      "openmapx-configuration-maintenance-owner-v2",
      raw,
      z
        .object({
          installationId: z.uuid(),
          origin: controlOriginSchema,
          admissionDigest: hash,
          rootCertificateDigest: hash,
          sequence: z.number(),
          plan: z
            .object({
              prepare: executionRefSchema,
              planDigest: hash,
              operation: z.object({ maintenanceId: z.uuid(), candidateId: z.uuid() }).passthrough(),
            })
            .passthrough(),
          receipt: z
            .object({
              state: z.string(),
              dmFence: z.unknown(),
              generation: z.string(),
              decision: z.unknown(),
            })
            .passthrough(),
          guardSource: z.unknown(),
          final: z.unknown(),
          inspection: z.unknown(),
          issuance: z.string(),
          noGuard: configurationNoGuardIntentSchema.nullable(),
        })
        .passthrough(),
    );
  verifyFamilyOwnedRecord(
    state.installation,
    state.origin,
    { scope: "private", namespace: "configuration-maintenance", container: "", name },
    canonicalJson(raw),
  );
  if (owner.guardSource !== null || owner.final !== null || owner.inspection !== null) {
    need(
      owner.guardSource !== null && owner.final !== null && owner.inspection !== null,
      "Conclusive original maintenance guard/NoGuard closure required",
    );
    assertPreparedAndSettledClosure(authority, observed, owner);
    return;
  }
  // A genuinely never-prepared root uses the disjoint original NoGuard source.
  need(
    owner.receipt.state === "settled" &&
      owner.receipt.dmFence === null &&
      owner.receipt.generation === "not_started" &&
      owner.guardSource === null &&
      owner.final === null &&
      owner.inspection === null &&
      owner.issuance === "closed_without_guard" &&
      owner.noGuard,
    "Conclusive original maintenance guard/NoGuard closure required",
  );
  need(
    owner.installationId === state.installation.installation.installationId &&
      owner.admissionDigest === state.receiptDigest &&
      same(owner.origin, state.origin) &&
      same(owner.plan.prepare, state.execution) &&
      owner.rootCertificateDigest === tree.certificateDigest,
    "Original maintenance closure identity changed",
  );
  const prepare = state.reservations.find((value) => value.phase === "configuration-fence"),
    settle = state.reservations.find((value) => value.phase === "configuration-fence-settle");
  need(prepare && settle, "Original finite prepare/settlement reservations required");
  const provisional = { origin: state.origin },
    descriptors = configurationSettlementRecordDescriptors(
      { ownerPrepare: state.execution, reservation: settle },
      prepare.execution.operationKey,
    ),
    control = verifyControl(
      state.installation.installation.publicKey,
      domains.control,
      readConfigurationSettlementCell(state.installation, provisional, descriptors.sender[2]!),
      configurationSettlementControlCellSchema.shape.payload,
    ),
    projection = verifyControl(
      state.installation.installation.publicKey,
      domains.signedProjection,
      control.projection,
      configurationSettlementReservationProjectionSchema,
    ),
    projectionDigest = settlementRecordDigest(domains.projection, projection),
    bundle = verifyControl(
      state.installation.installation.publicKey,
      domains.reference,
      readConfigurationSettlementCell(state.installation, projection, descriptors.sender[0]!),
      configurationSettlementCommitmentCellSchema.shape.payload,
    );
  need(
    bundle.phase === "unused" && control.binding === null && "unused" in control,
    "Both original NoGuard cells required",
  );
  configurationNoGuardBundleSchema.parse(bundle);
  const closure = verifyControl(
      state.installation.installation.publicKey,
      domains.closure,
      bundle.closure,
      configurationNoGuardClosureSchema,
    ),
    identity = closure.identity,
    { closureDigest: _digest, ...closureSource } = closure,
    intent = owner.noGuard,
    slot = readConfigurationSettlementFamilySlot(state.installation, projection),
    evidence = closure.noGuardEvidence;
  need(
    same(bundle, intent.bundle?.payload) &&
      bundle.settlementId === projection.settlementId &&
      bundle.projectionDigest === projectionDigest &&
      projection.installationId === owner.installationId &&
      same(projection.origin, state.origin) &&
      same(projection.ownerPrepare, state.execution) &&
      projection.rootAdmissionDigest === state.receiptDigest &&
      projection.rootCertificateDigest === tree.certificateDigest &&
      projection.maintenanceId === owner.plan.operation.maintenanceId &&
      projection.candidateId === owner.plan.operation.candidateId &&
      projection.planDigest === owner.plan.planDigest &&
      same(projection.reservation, settle) &&
      projection.reservationDigest === settlementRecordDigest(domains.reservationTuple, settle) &&
      projection.reservation.operationFingerprint === controlDigest(projection.operation) &&
      projection.operation.maintenanceId === projection.maintenanceId &&
      projection.operation.candidateId === projection.candidateId &&
      projection.operation.planDigest === projection.planDigest &&
      projection.operation.settlementId === projection.settlementId &&
      projection.settlementId ===
        deriveConfigurationFenceSettlementId({
          installationId: owner.installationId,
          ownerPrepare: state.execution,
          maintenanceId: projection.maintenanceId,
          candidateId: projection.candidateId,
          planDigest: projection.planDigest,
        }) &&
      same(identity, {
        installationId: owner.installationId,
        origin: state.origin,
        ownerPrepare: state.execution,
        admissionDigest: state.receiptDigest,
        rootCertificateDigest: tree.certificateDigest,
        maintenanceId: projection.maintenanceId,
        candidateId: projection.candidateId,
        planDigest: projection.planDigest,
        settlementId: projection.settlementId,
      }) &&
      closure.ownerSequence === owner.sequence &&
      closure.ownerSequence === intent.ownerSequence &&
      closure.closedAt === intent.closedAt &&
      same(evidence, intent.noGuardEvidence) &&
      closure.closureDigest === settlementRecordDigest(domains.closure, closureSource) &&
      same(bundle.issuerFreezeProof, intent.issuerFreezeProof) &&
      same(bundle.issuerUnused, intent.issuerUnused) &&
      slot.role === "ops-agent" &&
      slot.state === "UNUSED" &&
      slot.executionDigest === null &&
      slot.controlBindingDigest === null,
    "Original NoGuard bundle/identity/source changed",
  );
  const freezeDomain =
      evidence.kind === "never_issued" ? domains.neverIssued : domains.issuedRefused,
    freezeProof =
      evidence.kind === "never_issued"
        ? verifyControl(
            state.installation.installation.publicKey,
            freezeDomain,
            bundle.issuerFreezeProof,
            configurationNeverIssuedProofSchema,
          )
        : verifyControl(
            state.installation.installation.publicKey,
            freezeDomain,
            bundle.issuerFreezeProof,
            configurationIssuedPrepareRefusedProofSchema,
          ),
    issued = evidence.kind === "receiver_refused",
    expectedPublications = state.reservations
      .filter((value) => !issued || value !== prepare)
      .map((value) => {
        const actual = inspectControlChildPublication(authority, value);
        need(
          actual.publication.state === "unissued" &&
            lookupControlChildPhaseAttempt(authority, value) === null,
          "Original frozen phase was issued/attempted",
        );
        return {
          phase: value.phase,
          ordinal: value.ordinal,
          operationKey: value.execution.operationKey,
          grantState: "unissued",
          intentState: "not_attempted",
        };
      });
  need(
    same(freezeProof.identity, identity) &&
      freezeProof.issuerSequence === owner.sequence &&
      freezeProof.frozenAt === closure.closedAt &&
      evidence.issuerFreezeProofDigest === settlementRecordDigest(freezeDomain, freezeProof) &&
      same(
        expectedPublications,
        "remainingPublicationStates" in freezeProof
          ? freezeProof.remainingPublicationStates
          : freezeProof.publicationStates,
      ),
    "Original frozen issuer preimages changed",
  );
  for (const descriptor of descriptors.sender.filter(
    (value) => value.scope === "private" || value.name.endsWith("-ack.json"),
  ))
    need(
      readConfigurationSettlementCell(state.installation, projection, descriptor) === null,
      "Bound/attempted control cannot close UNUSED",
    );
  const ownIntent = verifyControl(
      state.installation.installation.publicKey,
      domains.unusedIntent,
      bundle.issuerUnused.intent,
      configurationUnusedCapacityIntentSchema,
    ),
    ownConfirmation = verifyControl(
      state.installation.installation.publicKey,
      domains.unusedConfirmation,
      bundle.issuerUnused.confirmation,
      configurationUnusedCapacityConfirmationSchema,
    ),
    ownIntentDigest = settlementRecordDigest(domains.unusedIntent, ownIntent),
    ownConfirmationDigest = settlementRecordDigest(domains.unusedConfirmation, ownConfirmation),
    safeSlot = {
      executionOrdinal: slot.executionOrdinal,
      intentOrdinal: slot.intentOrdinal,
      recordDescriptorsDigest: slot.recordDescriptorsDigest,
      allocatedDescriptorDigests: slot.allocatedDescriptorDigests,
      state: "UNUSED",
      intentDigest: ownIntentDigest,
    };
  need(
    ownIntent.role === "ops-agent" &&
      ownIntent.installationId === owner.installationId &&
      same(ownIntent.origin, state.origin) &&
      ownIntent.ownerPrepareDigest === controlDigest(state.execution) &&
      ownIntent.settlementId === projection.settlementId &&
      ownIntent.projectionDigest === projectionDigest &&
      ownIntent.prepareExecutionDigest ===
        (evidence.kind === "receiver_refused" ? evidence.prepareExecutionDigest : null) &&
      ownIntent.capacityReceiptDigest ===
        (evidence.kind === "receiver_refused" ? evidence.capacityReceiptDigest : null) &&
      ownIntent.sourceProofDigest === configurationIssuerUnusedSourceDigest(evidence) &&
      ownIntent.executionOrdinal === slot.executionOrdinal &&
      ownIntent.intentOrdinal === slot.intentOrdinal &&
      ownIntent.recordDescriptorsDigest === controlDigest(descriptors.sender) &&
      same(
        ownIntent.allocatedDescriptorDigests,
        descriptors.sender.map((value) => controlDigest(value)).sort(),
      ) &&
      slot.unusedIntentDigest === ownIntentDigest &&
      ownConfirmation.role === "ops-agent" &&
      ownConfirmation.installationId === owner.installationId &&
      same(ownConfirmation.origin, state.origin) &&
      ownConfirmation.ownerPrepareDigest === ownIntent.ownerPrepareDigest &&
      ownConfirmation.settlementId === projection.settlementId &&
      ownConfirmation.projectionDigest === projectionDigest &&
      ownConfirmation.intentDigest === ownIntentDigest &&
      ownConfirmation.slotStateDigest === controlDigest(safeSlot) &&
      ownConfirmation.confirmedAt === slot.unusedConfirmedAt &&
      ownConfirmation.confirmedAt >= ownIntent.createdAt,
    "Original issuer UNUSED CAS/confirmation changed",
  );
  const opened: AnchoredDirectory[] = [],
    own = (value: AnchoredDirectory) => {
      opened.push(value);
      return value;
    };
  let dmContainment: string | undefined,
    dmUnused:
      | { role: "data-manager"; intentDigest: string; confirmationDigest: string }
      | undefined;
  try {
    const descriptor = descriptors.receiver[0]!;
    if (evidence.kind === "never_issued") {
      need(
        !("kind" in freezeProof) &&
          tree.children.length === 0 &&
          evidence.prepareReservationDigest === controlDigest(prepare) &&
          evidence.publicationStatesDigest ===
            settlementRecordDigest(domains.neverIssued, freezeProof) &&
          evidence.issuerSequence === owner.sequence &&
          evidence.frozenAt === closure.closedAt,
        "Original NeverIssued source changed",
      );
      assertNoUnissuedConfigurationReceiverPublication(
        state.installation,
        prepare.execution.operationKey,
      );
    } else {
      need("kind" in freezeProof, "Issued preparation cannot use NeverIssued proof");
      const root = own(new AnchoredDirectory(state.installation.dataRoot)),
        target = own(root.directory(".admin-target-control")),
        executions = own(target.directory("executions")),
        dm = own(executions.directory("data-manager")),
        preparePublication = inspectControlChildPublication(authority, prepare),
        attempt = preparePublication.binding?.child,
        bytes = dm.read(descriptor.name, descriptor.cap),
        cell = configurationDmCapacityCellSchema.parse(JSON.parse(bytes.toString("utf8"))),
        key = state.installation.publicKeys["data-manager"];
      need(
        bytes.length === descriptor.cap &&
          cell.refusal &&
          cell.unused?.confirmation &&
          attempt &&
          tree.children.length === 1 &&
          preparePublication.publication.state === "grant_prepared" &&
          preparePublication.publication.grantDigest === freezeProof.prepareGrantDigest,
        "Actual original issued/refused DM packet required",
      );
      const outbox = readPrivateRecord(
          state.installation,
          "attempts",
          `${preparePublication.publication.delegationId}.json`,
          65536,
        ) as { grant: unknown },
        refusal = verifyControl(
          key,
          domains.refusal,
          cell.refusal,
          configurationDmNoGuardRefusalSchema,
        ),
        capacity =
          cell.capacity &&
          verifyControl(
            key,
            domains.capacity,
            cell.capacity,
            configurationSettlementCapacitySchema,
          ),
        refusalDigest = settlementRecordDigest(domains.refusal, refusal),
        child = tree.children[0]!,
        witness = readControlExecutionWitness(state.installation, attempt.execution, key),
        unusedIntent = verifyControl(
          key,
          domains.unusedIntent,
          cell.unused.intent,
          configurationUnusedCapacityIntentSchema,
        ),
        unusedConfirmation = verifyControl(
          key,
          domains.unusedConfirmation,
          cell.unused.confirmation,
          configurationUnusedCapacityConfirmationSchema,
        ),
        unusedIntentDigest = settlementRecordDigest(domains.unusedIntent, unusedIntent),
        unusedConfirmationDigest = settlementRecordDigest(
          domains.unusedConfirmation,
          unusedConfirmation,
        ),
        expectedAllocated = (capacity ? descriptors.receiver : [descriptor])
          .map((value) => controlDigest(value))
          .sort(),
        dmSlot = {
          executionOrdinal: capacity?.reservedExecutionOrdinal ?? null,
          intentOrdinal: capacity?.reservedIntentOrdinal ?? null,
          recordDescriptorsDigest: controlDigest(descriptors.receiver),
          allocatedDescriptorDigests: expectedAllocated,
          state: "UNUSED",
          intentDigest: unusedIntentDigest,
        };
      need(
        child.grantDigest === freezeProof.prepareGrantDigest &&
          controlDigest(outbox.grant) === child.grantDigest &&
          same(child.execution, attempt.execution) &&
          child.settlement.outcome === "failed_without_effect" &&
          child.settlement.publication === "not_started" &&
          same(refusal.prepareExecution, attempt.execution) &&
          refusal.prepareAdmissionDigest === witness.authorityDigest &&
          witness.kind === "configuration-maintenance.prepare" &&
          same(witness.origin, state.origin) &&
          refusal.installationId === owner.installationId &&
          same(refusal.origin, state.origin) &&
          same(refusal.ownerPrepare, state.execution) &&
          refusal.rootAdmissionDigest === state.receiptDigest &&
          refusal.rootCertificateDigest === tree.certificateDigest &&
          refusal.maintenanceId === projection.maintenanceId &&
          refusal.candidateId === projection.candidateId &&
          refusal.planDigest === projection.planDigest &&
          refusal.settlementId === projection.settlementId &&
          refusal.projectionDigest === projectionDigest &&
          refusal.reservationDigest === projection.reservationDigest &&
          refusal.refusalReceipt.maintenanceId === projection.maintenanceId &&
          refusal.effectReceiptDigest === controlDigest(refusal.refusalReceipt) &&
          child.settlement.terminalReceiptDigest === refusal.effectReceiptDigest &&
          refusal.effectSettlementDigest ===
            controlDigest({ ...child.settlement, receipt: refusal.refusalReceipt }) &&
          refusal.canonicalTerminalDigest ===
            controlDigest({ version: 1, refused: refusal.refusalReceipt }) &&
          evidence.prepareExecutionDigest === controlDigest(attempt.execution) &&
          evidence.prepareAdmissionDigest === refusal.prepareAdmissionDigest &&
          evidence.refusalProjectionDigest === refusalDigest &&
          evidence.effectSettlementDigest === refusal.effectSettlementDigest &&
          evidence.canonicalTerminalDigest === refusal.canonicalTerminalDigest &&
          evidence.canonicalTerminalAt === refusal.canonicalTerminalAt &&
          evidence.capacityReceiptDigest === refusal.capacityReceiptDigest &&
          evidence.dmUnusedIntentDigest === unusedIntentDigest &&
          evidence.dmUnusedConfirmationDigest === unusedConfirmationDigest &&
          freezeProof.prepareExecutionDigest === evidence.prepareExecutionDigest &&
          freezeProof.refusalProjectionDigest === refusalDigest &&
          unusedIntent.role === "data-manager" &&
          unusedIntent.installationId === owner.installationId &&
          same(unusedIntent.origin, state.origin) &&
          unusedIntent.ownerPrepareDigest === controlDigest(state.execution) &&
          unusedIntent.prepareExecutionDigest === evidence.prepareExecutionDigest &&
          unusedIntent.settlementId === projection.settlementId &&
          unusedIntent.projectionDigest === projectionDigest &&
          unusedIntent.capacityReceiptDigest === refusal.capacityReceiptDigest &&
          unusedIntent.sourceProofDigest === refusalDigest &&
          unusedIntent.executionOrdinal === dmSlot.executionOrdinal &&
          unusedIntent.intentOrdinal === dmSlot.intentOrdinal &&
          unusedIntent.recordDescriptorsDigest === dmSlot.recordDescriptorsDigest &&
          same(unusedIntent.allocatedDescriptorDigests, expectedAllocated) &&
          unusedConfirmation.role === "data-manager" &&
          unusedConfirmation.installationId === owner.installationId &&
          same(unusedConfirmation.origin, state.origin) &&
          unusedConfirmation.ownerPrepareDigest === controlDigest(state.execution) &&
          unusedConfirmation.settlementId === projection.settlementId &&
          unusedConfirmation.projectionDigest === projectionDigest &&
          unusedConfirmation.intentDigest === unusedIntentDigest &&
          unusedConfirmation.slotStateDigest === controlDigest(dmSlot) &&
          unusedConfirmation.confirmedAt >= unusedIntent.createdAt,
        "Actual DM refusal/UNUSED preimages changed",
      );
      if (capacity)
        need(
          capacity.installationId === owner.installationId &&
            same(capacity.origin, state.origin) &&
            capacity.ownerPrepareDigest === controlDigest(state.execution) &&
            capacity.settlementId === projection.settlementId &&
            capacity.projectionDigest === projectionDigest &&
            capacity.reservationDigest === projection.reservationDigest &&
            same(capacity.proposedExecutionAddress, projection.reservation.execution) &&
            capacity.recordDescriptorsDigest === controlDigest(descriptors.receiver) &&
            capacity.maxBytes === descriptors.receiver.reduce((sum, value) => sum + value.cap, 0) &&
            refusal.capacityReceiptDigest === settlementRecordDigest(domains.capacity, capacity),
          "Original DM capacity certificate changed",
        );
      else
        need(
          refusal.capacityReceiptDigest === null && refusal.refusalReceipt.reason === "capacity",
          "Actual capacity-null refusal required",
        );
      verifyPublishedUnusedDmConfigurationSettlementSlots(state.installation, projection, {
        executionOrdinal: dmSlot.executionOrdinal,
        intentOrdinal: dmSlot.intentOrdinal,
        projectionDigest,
        intentDigest: unusedIntentDigest,
      });
      dmContainment = refusal.effectSettlementDigest;
      dmUnused = {
        role: "data-manager",
        intentDigest: unusedIntentDigest,
        confirmationDigest: unusedConfirmationDigest,
      };
    }
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
  verifyControlEffectSettlement(state.installation.installation, state.execution);
  const ownEffect = readPrivateRecord(
    state.installation,
    "effects",
    `${state.execution.operationKey}.json`,
    65536,
  ) as {
    payload: {
      outcome: string;
      publication: string;
      receipt: unknown;
    };
  };
  need(
    ownEffect.payload.outcome === "failed_without_effect" &&
      ownEffect.payload.publication === "not_started" &&
      same(ownEffect.payload.receipt, {
        kind: "configuration-no-guard",
        issuerFreezeProofDigest: evidence.issuerFreezeProofDigest,
        issuerUnusedConfirmationDigest: ownConfirmationDigest,
      }) &&
      same(
        closure.originalContainmentDigests,
        [controlDigest(ownEffect.payload), ...(dmContainment ? [dmContainment] : [])].sort(),
      ) &&
      same(closure.unusedSlotDigests, [
        ...(dmUnused ? [dmUnused] : []),
        {
          role: "ops-agent",
          intentDigest: ownIntentDigest,
          confirmationDigest: ownConfirmationDigest,
        },
      ]) &&
      same(control.unused, {
        bundleDigest: settlementRecordDigest(domains.bundle, bundle),
        closureDigest: closure.closureDigest,
        issuerFreezeProofDigest: evidence.issuerFreezeProofDigest,
        issuerUnusedIntentDigest: ownIntentDigest,
        issuerUnusedConfirmationDigest: ownConfirmationDigest,
      }),
    "Original own containment/bundle links changed",
  );
}
