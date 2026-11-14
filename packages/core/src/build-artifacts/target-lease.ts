import { createPrivateKey, type KeyObject, randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
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
import {
  CONFIGURATION_PREPARE_NON_ADMISSION_DOMAIN,
  configurationPrepareNonAdmissionPayloadSchema,
  configurationPrepareNonAdmissionSchema,
  type DataConfigurationFencePrepare,
} from "../services/data-manager/contracts/configuration-maintenance";
import {
  GENERATION_HARDLINKS_NON_ADMISSION_DOMAIN,
  generationHardlinksNonAdmissionPayloadSchema,
  generationHardlinksNonAdmissionSchema,
} from "../services/data-manager/contracts/executions";
// biome-ignore-start lint/suspicious/noImportCycles: Original receipt recovery is called after initialization, never during module evaluation.
import {
  readFailedServiceHardlinksReceipt,
  readFailedServiceLifecycleReceipt,
} from "../services/service-lifecycle-receipt";
// biome-ignore-end lint/suspicious/noImportCycles: Original receipt recovery is called after initialization, never during module evaluation.
// biome-ignore-start lint/suspicious/noImportCycles: Exact and reserved children share the same live guards; phase schemas are lazy and these cross-module calls run after initialization.
import {
  inspectControlChildPublication,
  lookupControlChildPhaseBinding,
  prepareControlChildPublication,
  resolveControlChildPlan,
} from "./child-phase";
// biome-ignore-end lint/suspicious/noImportCycles: Same exact deferred guard import.
import {
  assertAppliedConfigurationMaintenanceFinalState,
  assertContainedConfigurationMaintenanceFinalState,
  assertUnusedConfigurationMaintenanceFinalState,
  configurationChildEvidenceSchema,
  configurationFinalDomains,
  configurationMaintenanceRuntimeInspectionSchema,
  configurationOwnerFinalSchema,
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
  cancelControlExecution,
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
  readCompletedConfigurationHandoff,
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
import {
  AnchoredDirectory,
  acquireGuardDirectory,
  type FileIdentity,
  identity,
  sameInode,
} from "./filesystem";
import { assertFixedConfigurationMaintenancePlan } from "./fixed-configuration-maintenance";

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
  origin: controlOriginSchema,
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
const admissionSlotSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  leaseId: uuid,
  certificateDigest: digest,
  active: slotSchema,
  history: slotSchema,
  release: releaseProgressSchema.optional(),
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
  origin: controlOriginSchema,
  certificate: signedCertificateSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: phaseSchema,
  grantDigests: z.record(uuid, digest),
  settlement: outcomeSchema.nullable(),
});
type RootRecord = z.infer<typeof rootSchema>;
const grantSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  origin: controlOriginSchema,
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
  origin: controlOriginSchema,
  delegationId: uuid,
  grantDigest: digest,
  execution: executionRefSchema,
  sequence: z.number().int().nonnegative().safe(),
  phase: phaseSchema,
  grantDigests: z.record(uuid, digest),
  settlement: outcomeSchema.nullable(),
  nonAdmission: configurationPrepareNonAdmissionSchema.optional(),
});
type ChildRecord = z.infer<typeof childSchema>;
const unadoptedLifecycleDomain = "openmapx-unadopted-service-hardlinks-v1";
const unadoptedLifecycleSchema = z.strictObject({
  version: z.literal(1),
  origin: controlOriginSchema,
  leaseId: uuid,
  certificateDigest: digest,
  delegationId: uuid,
  grantDigest: digest,
  parent: executionRefSchema,
  child: executionRefSchema,
  failedReceiptDigest: digest,
  canceledSequence: z.number().int().positive().safe(),
  nonAdmission: generationHardlinksNonAdmissionSchema,
});
type ObservedChild = ChildRecord & {
  unadoptedRevocation?: true;
  failedLifecycleReceiptDigest?: string;
};
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
function readChild(s: State, grant: Grant): ObservedChild | undefined {
  const dir = childDirectory(s, "children");
  try {
    let raw: unknown;
    try {
      raw = json(dir, `${grant.delegationId}.json`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (raw && typeof raw === "object" && "unadoptedRevocation" in raw) {
      const envelope = z.strictObject({ unadoptedRevocation: z.unknown() }).parse(raw),
        revoked = verifyControl(
          s.certificate.ownerPublicKey,
          unadoptedLifecycleDomain,
          envelope.unadoptedRevocation,
          unadoptedLifecycleSchema,
        ),
        root = readRoot(s),
        nonAdmission = verifyControl(
          s.installation.publicKeys["data-manager"],
          GENERATION_HARDLINKS_NON_ADMISSION_DOMAIN,
          revoked.nonAdmission,
          generationHardlinksNonAdmissionPayloadSchema,
        );
      if (
        s.certificate.owner.executor !== "host-cli" ||
        grant.parentNode !== null ||
        grant.phase !== "hardlinks" ||
        grant.childKind !== "generation-hardlinks" ||
        grant.recipient !== "data-manager" ||
        grant.depth !== 1 ||
        revoked.leaseId !== s.certificate.leaseId ||
        revoked.certificateDigest !== controlDigest(s.certificateEnvelope) ||
        revoked.delegationId !== grant.delegationId ||
        revoked.grantDigest !== root.grantDigests[grant.delegationId] ||
        controlDigest(revoked.parent) !== controlDigest(s.certificate.owner) ||
        controlDigest(revoked.child) !== controlDigest(grant.child) ||
        !sameControlOrigin(revoked.origin, grant.origin) ||
        root.phase === "held" ||
        root.sequence < revoked.canceledSequence
      )
        throw Error("Original unadopted lifecycle revocation changed");
      if (
        nonAdmission.installationId !== s.certificate.installationId ||
        nonAdmission.leaseId !== revoked.leaseId ||
        nonAdmission.certificateDigest !== revoked.certificateDigest ||
        nonAdmission.delegationId !== revoked.delegationId ||
        nonAdmission.grantDigest !== revoked.grantDigest ||
        controlDigest(nonAdmission.parent) !== controlDigest(revoked.parent) ||
        controlDigest(nonAdmission.child) !== controlDigest(revoked.child) ||
        controlDigest(nonAdmission.origin) !== controlDigest(revoked.origin) ||
        nonAdmission.canceledSequence !== revoked.canceledSequence
      )
        throw Error("Data Manager non-admission binding changed");
      return {
        version: 2,
        origin: grant.origin,
        delegationId: grant.delegationId,
        grantDigest: revoked.grantDigest,
        execution: grant.child,
        sequence: 0,
        phase: "settled",
        grantDigests: {},
        unadoptedRevocation: true,
        failedLifecycleReceiptDigest: revoked.failedReceiptDigest,
        settlement: {
          identity: grant.child,
          outcome: "failed_without_effect",
          publication: "not_started",
          terminalReceiptDigest: controlDigest(envelope.unadoptedRevocation),
        },
      };
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
    if (child.nonAdmission) {
      const proof = verifyControl(
        grant.childPublicKey,
        CONFIGURATION_PREPARE_NON_ADMISSION_DOMAIN,
        child.nonAdmission,
        configurationPrepareNonAdmissionPayloadSchema,
      );
      if (
        grant.recipient !== "data-manager" ||
        grant.childKind !== "configuration-maintenance.prepare" ||
        grant.phase !== "configuration-fence" ||
        grant.parentNode !== null ||
        proof.installationId !== s.certificate.installationId ||
        proof.leaseId !== s.certificate.leaseId ||
        proof.certificateDigest !== controlDigest(s.certificateEnvelope) ||
        proof.delegationId !== grant.delegationId ||
        proof.grantDigest !== child.grantDigest ||
        !sameControlOrigin(proof.origin, grant.origin) ||
        controlDigest(proof.child) !== controlDigest(grant.child) ||
        controlDigest(proof.input.ownerPrepare) !== controlDigest(grant.parent) ||
        controlDigest({ kind: grant.childKind, ...proof.input }) !==
          grant.child.operationFingerprint ||
        proof.observedAt <= Math.max(grant.child.deadlineAt, grant.parent.deadlineAt) ||
        proof.canceledSequence > readRoot(s).sequence ||
        child.phase !== "settled" ||
        Object.keys(child.grantDigests).length ||
        child.settlement?.outcome !== "failed_without_effect" ||
        child.settlement.publication !== "not_started" ||
        child.settlement.terminalReceiptDigest !== controlDigest(proof)
      )
        throw Error("Original unadmitted preparation settlement changed");
    }
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
  writePrivateRecord(s.installation, "observations", name, nodes, false);
}
type LeaseTree = {
  root: RootRecord;
  grants: Map<string, Grant>;
  children: Map<string, ObservedChild>;
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
  const children = new Map<string, ObservedChild>();
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
    if (s.certificate.origin) dir.write(name, bytes, exclusive);
    else dir.write(name, bytes, exclusive);
  } finally {
    if (dir !== s.ledger) dir.close();
  }
}
/** Only failure to acquire the existing journal guard, before its body runs.
 * This is coordination evidence, never permission to reclaim a held lock. */
export class ArtifactTargetJournalBusyError extends Error {
  constructor(cause: unknown) {
    super("Lease journal writer is busy or requires supervised recovery", { cause });
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
    acquireGuardDirectory(path);
    fsyncSync(s.ledger.fd);
  } catch (cause) {
    throw new ArtifactTargetJournalBusyError(cause);
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
/** At most this many leases are held at once, and this many are retained
 * until the control prune removes released ones. */
const ACTIVE_LEASES = 256,
  RETAINED_LEASES = 1024;
function reserveAuthoritySlot(dir: AnchoredDirectory, maximum: number, until: number) {
  for (let slot = 0; slot < maximum; slot++) {
    if (Date.now() >= until) throw Error("Target lease acquisition deadline elapsed");
    const name = `slot-${slot}`;
    try {
      mkdirSync(dir.name(name), { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    fsyncSync(dir.fd);
    const child = dir.directory(name);
    try {
      const generation = randomUUID();
      child.write("generation.json", JSON.stringify({ generation }), true);
      return { name, identity: identity(child.stat), generation };
    } finally {
      child.close();
    }
  }
  throw Error("Retained lease capacity exhausted; await the control prune or containment");
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
  assertImagePullTargetLeaseCompatibility(authority, "service.pull");
}
/** Conservative reciprocal target check for the one fixed immutable image stage. */
export function assertImageStageLeaseCompatibility(authority: VerifiedExecutionAuthority): void {
  assertImagePullTargetLeaseCompatibility(authority, "service.image.stage");
}
function assertImagePullTargetLeaseCompatibility(
  authority: VerifiedExecutionAuthority,
  kind: "service.pull" | "service.image.stage",
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
          kind: z.literal(kind),
          execution: executionRefSchema,
          operation: opsOperationSchema,
        })
        .passthrough(),
    );
  if (
    !state.origin ||
    state.installation.fixedChildId ||
    state.kind !== kind ||
    controlDigest(raw) !== state.receiptDigest ||
    controlDigest(admitted.execution) !== controlDigest(state.execution) ||
    admitted.operation.kind !== kind ||
    !("serviceId" in admitted.operation) ||
    (admitted.operation.kind === "service.pull" &&
      (admitted.operation.serviceId !== "data-manager" || !admitted.operation.candidateId)) ||
    opsOperationFingerprint(admitted.operation) !== state.execution.operationFingerprint
  )
    throw Error("Actual normal coordinator pull required");
  if (!("serviceId" in admitted.operation)) throw Error("Image target required");
  const target = admitted.operation.serviceId;
  if (!state.installation.registeredTargets.has(target))
    throw Error("Registered image target required");
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
            .listBounded(ACTIVE_LEASES)
            .sort()
            .map((name) => {
              if (!/^slot-\d{1,4}$/.test(name) || Number(name.slice(5)) >= ACTIVE_LEASES)
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
    if (locks.listBounded(256).includes(target)) throw Error("Coordinator target is held");
    const names = leases.listBounded(RETAINED_LEASES + 3).sort();
    for (const name of names) {
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
        if (owner.certificate.serviceIds.includes(target))
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
      canonicalJson(leases.listBounded(RETAINED_LEASES + 3).sort()) !== canonicalJson(names) ||
      locks.listBounded(256).includes(target)
    )
      throw Error("Physical target index is changing");
    for (const dir of opened) dir.check();
  } finally {
    for (const dir of opened.reverse()) dir.close();
    data.close();
  }
}
/** Names who holds a target. The refusal stands even when the holder cannot be read. */
function heldTargetError(
  installation: InstallationState,
  leases: AnchoredDirectory,
  target: string,
): Error {
  let holder: string | undefined;
  try {
    for (const name of leases.listBounded(RETAINED_LEASES + 3)) {
      if (holder || !uuid.safeParse(name).success) continue;
      try {
        const owner = openState(installation.dataRoot, name, installation, true);
        try {
          if (owner.certificate.serviceIds.includes(target) && !owner.slots?.releasedAt)
            holder = owner.execution.operationKey;
        } finally {
          closeState(owner);
        }
      } catch {
        /* A lease being written or retired is not the one to name. */
      }
    }
  } catch {
    /* The lease directory could not be listed. */
  }
  return Error(
    holder
      ? `Target lease busy: ${target} is held by operation ${holder}. Wait for it to finish; a service start or update records its state in infra/docker/data/ops-agent/lifecycle/${holder}.json.`
      : `Target lease busy: ${target} is held by an operation that could not be identified. Inspect infra/docker/data/.admin-target-control/leases.`,
  );
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
      historySlot = reserveAuthoritySlot(history, RETAINED_LEASES, until);
      activeSlot = reserveAuthoritySlot(active, ACTIVE_LEASES, until);
    } finally {
      active.close();
      history.close();
    }
    for (const id of serviceIds) {
      for (;;) {
        options.signal?.throwIfAborted();
        if (Date.now() >= until) throw heldTargetError(authority.installation, leases, id);
        try {
          mkdirSync(locks.name(id), { mode: 0o700 });
          fsyncSync(locks.fd);
          const lock = locks.directory(id);
          acquired[id] = identity(lock.stat);
          lock.close();
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
          if (Date.now() >= until) throw heldTargetError(authority.installation, leases, id);
          await delay(Math.min(50, until - Date.now()), undefined, { signal: options.signal });
        }
      }
    }
    const leaseId = randomUUID();
    ledger = leases.directory(leaseId, true, true);
    ledger.directory("grants", true).close();
    ledger.directory("children", true).close();
    const key = newControlKey();
    if (!authority.origin) throw Error("Control origin required");
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
    const admissionBytes = canonicalJson(
      signControl(
        authority.installation.privateKey,
        "openmapx-admission-slots-v1",
        admissionSlotSchema.parse(slots),
      ),
    );
    if (Buffer.byteLength(admissionBytes) > 4096)
      throw Error("Admission journal exceeds byte capacity");
    ledger?.write("admission.json", admissionBytes, true);
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
    );
    published = true;
    const ownerBytes = canonicalJson(
      signControl(key.privateKey, "openmapx-lease-owner-v2", record),
    );
    ledger?.write("owner.json", ownerBytes, true);
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
      "service.build",
      "services.buildAll",
      "data.link",
      "configuration.hardlinks.apply",
      "data.update",
      "artifactTransfer.import",
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
      if (retained?.unadoptedRevocation) throw Error("Original unadopted grant was revoked");
      if (
        !retained &&
        (!forwardAncestry(t, grant.parentNode) || Date.now() >= grant.child.deadlineAt)
      )
        throw Error("Stale or canceled delegation");
      if (!retained && !grant.origin) throw Error("Control origin required");
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
      } else writePrivateRecord(peer.installation, "adoptions", admissionName, pending, true);
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
/** The fixed PREPARE receiver serializes private admission with cancellation
 * and negative recovery under the existing physical journal guard. */
export function withConfigurationFenceReceiverAdmission(
  lease: BorrowedArtifactTargetLease,
  run: () => VerifiedExecutionAuthority,
): VerifiedExecutionAuthority {
  const s = stateOf(lease);
  if (!s.node || s.installation.installation.role !== "data-manager" || s.installation.fixedChildId)
    throw Error("Original normal configuration receiver required");
  return guarded(s, () => {
    const grant = tree(s).grants.get(s.node!);
    if (
      grant?.childKind !== "configuration-maintenance.prepare" ||
      grant.phase !== "configuration-fence"
    )
      throw Error("Original configuration preparation grant required");
    return run();
  });
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
/** Complete only the original terminal handoff preparer after its exact fixed
 * helper has committed and physically settled. No target/root is acquired. */
export async function settlePreparedConfigurationHandoff(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configurationHandoff.prepare" ||
    owner.installation.fixedChildId ||
    owner.installation.installation.role !== "ops-agent" ||
    !owner.origin
  )
    throw Error("Original handoff preparer required");
  const admitted = readPrivateRecord(
      owner.installation,
      "executions",
      `${owner.execution.operationKey}.json`,
      65536,
    ) as { payload: { operation: unknown } },
    operation = opsOperationSchema.parse(admitted.payload.operation);
  if (operation.kind !== "configurationHandoff.prepare")
    throw Error("Original handoff operation required");
  const source = readCompletedConfigurationHandoff(
      owner.installation.installation,
      operation.handoffId,
    ),
    s = openState(owner.installation.dataRoot, source.intent.leaseId, owner.installation);
  try {
    const current = tree(s),
      parent = [...current.grants.values()].filter(
        (grant) => canonicalJson(grant.child) === canonicalJson(owner.execution),
      ),
      helper = current.grants.get(source.intent.delegationId),
      child = current.children.get(source.intent.delegationId);
    if (
      parent.length !== 1 ||
      canonicalJson(source.intent.preparer) !== canonicalJson(owner.execution) ||
      canonicalJson(source.intent.operation) !== canonicalJson(operation) ||
      source.intent.preparerAdmissionDigest !== owner.receiptDigest ||
      source.intent.ownerCertificateDigest !== controlDigest(s.certificateEnvelope) ||
      canonicalJson(source.intent.ownerPrepare) !== canonicalJson(s.execution) ||
      helper?.parentNode !== parent[0]!.delegationId ||
      helper.recipient !== "configuration-helper" ||
      helper.phase !== "configuration-handoff" ||
      helper.childKind !== "configuration-helper" ||
      helper.childPublicKey !== source.intent.helperPublicKey ||
      canonicalJson(helper.child) !== canonicalJson(source.intent.helper) ||
      child?.phase !== "settled" ||
      canonicalJson(child.settlement) !== canonicalJson(source.settlement) ||
      parent[0]!.childPublicKey !== owner.installation.installation.publicKey
    )
      throw Error("Original prepared helper tree changed");
    verifyControlPreparedTerminal(owner.installation, owner.execution);
    const evidence = verifyControlEffectSettlement(
        owner.installation.installation,
        owner.execution,
      ),
      proof = childSettlementState(evidence).evidence;
    if (proof.outcome !== "committed" || proof.publication !== "committed")
      throw Error("Original prepared handoff effect required");
    const prior = current.children.get(parent[0]!.delegationId);
    if (prior?.phase === "settled") {
      if (canonicalJson(prior.settlement) !== canonicalJson(proof))
        throw Error("Original handoff settlement changed");
      return;
    }
    s.node = parent[0]!.delegationId;
    s.execution = owner.execution;
    s.key = owner.installation.privateKey;
    s.authority = owner;
    s.verifiedAuthority = authority;
    s.settlementOnly = true;
    const lease = Object.freeze({
      leaseId: source.intent.leaseId,
      owner: s.certificate.owner,
      execution: owner.execution,
      serviceIds: parent[0]!.serviceIds,
      mode: "borrowed" as const,
    });
    handles.set(lease, s);
    try {
      await settleArtifactTargetLeaseChild(lease, evidence);
    } finally {
      handles.delete(lease);
    }
  } finally {
    closeState(s);
  }
}
/** Receipt-only reopening of the original completed fixed helper. The signed
 * completion/effect and original ready adoption must already exist. No target
 * acquire/adopt, forward capability or clock renewal is available here. */
export async function settleRetainedConfigurationHandoffHelper(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "configuration-helper" || !owner.installation.fixedChildId || !owner.origin)
    throw Error("Original completed fixed helper required");
  const raw = readPrivateRecord(
      owner.installation,
      "executions",
      `${owner.execution.operationKey}.json`,
      65536,
    ) as { payload: { operation: { handoffId?: unknown } } },
    source = readCompletedConfigurationHandoff(
      owner.installation.installation,
      uuid.parse(raw.payload.operation.handoffId),
    ),
    adopted = readPrivateRecord(
      owner.installation,
      "adoptions",
      `${source.intent.delegationId}.json`,
      8192,
    ),
    adoption = z
      .object({
        state: z.literal("ready"),
        execution: executionRefSchema,
        assertion: z.string(),
        grantDigest: digest,
      })
      .parse(adopted),
    assertion = parseControlAssertion(adoption.assertion);
  if (
    canonicalJson(source.intent.helper) !== canonicalJson(owner.execution) ||
    source.intent.helperPublicKey !== owner.installation.installation.publicKey ||
    source.intent.delegationId !== owner.installation.fixedChildId ||
    adoption.assertion !== source.intent.assertion ||
    canonicalJson(adoption.execution) !== canonicalJson(owner.execution) ||
    assertion.leaseId !== source.intent.leaseId ||
    assertion.delegationId !== source.intent.delegationId ||
    assertion.grantDigest !== adoption.grantDigest
  )
    throw Error("Original helper ready adoption changed");
  const s = openState(owner.installation.dataRoot, source.intent.leaseId, owner.installation);
  try {
    const current = tree(s),
      grant = current.grants.get(source.intent.delegationId),
      child = current.children.get(source.intent.delegationId);
    if (
      controlDigest(s.certificateEnvelope) !== source.intent.ownerCertificateDigest ||
      !sameControlOrigin(s.certificate.origin, owner.origin) ||
      grant?.recipient !== "configuration-helper" ||
      grant.childKind !== "configuration-helper" ||
      grant.childPublicKey !== owner.installation.installation.publicKey ||
      child?.grantDigest !== adoption.grantDigest ||
      canonicalJson(grant.child) !== canonicalJson(owner.execution) ||
      !child
    )
      throw Error("Original retained helper tree changed");
    if (child.phase === "settled") {
      if (canonicalJson(child.settlement) !== canonicalJson(source.settlement))
        throw Error("Original helper settlement changed");
      return;
    }
    verifyControlPreparedTerminal(owner.installation, source.intent.preparer);
    s.node = source.intent.delegationId;
    s.execution = owner.execution;
    s.key = owner.installation.privateKey;
    s.authority = owner;
    s.verifiedAuthority = authority;
    s.settlementOnly = true;
    const lease = Object.freeze({
      leaseId: source.intent.leaseId,
      owner: s.certificate.owner,
      execution: owner.execution,
      serviceIds: grant.serviceIds,
      mode: "borrowed" as const,
    });
    handles.set(lease, s);
    try {
      await settleArtifactTargetLeaseChild(
        lease,
        verifyControlEffectSettlement(owner.installation.installation, owner.execution),
      );
    } finally {
      handles.delete(lease);
    }
  } finally {
    closeState(s);
  }
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
      const release: z.infer<typeof releaseProgressSchema> = saved ?? {
        version: 2,
        phase: "planned",
        completedTargets: 0,
        active: false,
      };
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
/** Removes the released root lease of an execution whose records are being
 * pruned: first its retained history slot, then its ledger. */
export function removeReleasedArtifactTargetLease(authority: VerifiedExecutionAuthority): void {
  verifyRetainedArtifactTargetRootRelease(authority);
  const a = executionAuthorityState(authority),
    { leaseId } = z
      .object({ leaseId: uuid })
      .parse(
        readPrivateRecord(a.installation, "execution-leases", `${a.execution.operationKey}.json`),
      ),
    s = openState(a.installation.dataRoot, leaseId, a.installation, true);
  try {
    if (s.slots) {
      const index = s.control.directory("admission-index-v1"),
        history = index.directory("history");
      try {
        removeSlot(history, s.slots.history);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        history.close();
        index.close();
      }
    }
  } finally {
    closeState(s);
  }
  rmSync(join(a.installation.dataRoot, ".admin-target-control", "leases", leaseId), {
    recursive: true,
    force: true,
  });
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
/** Receiver-only settlement after the fixed receiver has locked SQL and
 * excluded both this execution and maintenance identity. No admission, effect
 * authority or forward handle is created, including for the expired child. */
export function settleUnadmittedConfigurationPrepare(
  installation: import("./control-authority").ControlInstallation,
  assertion: string,
  input: DataConfigurationFencePrepare,
) {
  const local = installationState(installation),
    parsed = parseControlAssertion(assertion),
    inspected = inspectArtifactDelegation({ dataRoot: local.dataRoot, installation, assertion });
  if (
    installation.role !== "data-manager" ||
    local.fixedChildId ||
    inspected.owner.executor !== "ops-agent" ||
    inspected.owner.principal !== "api" ||
    inspected.kind !== "configuration-maintenance.prepare" ||
    inspected.phase !== "configuration-fence" ||
    inspected.recipient !== "data-manager" ||
    !inspected.origin ||
    controlDigest(inspected.parent) !== controlDigest(inspected.owner) ||
    controlDigest(input.ownerPrepare) !== controlDigest(inspected.owner) ||
    canonicalJson(input.serviceIds) !== canonicalJson(inspected.serviceIds) ||
    controlDigest({ kind: inspected.kind, ...input }) !==
      inspected.execution.operationFingerprint ||
    Date.now() <= Math.max(inspected.execution.deadlineAt, inspected.owner.deadlineAt)
  )
    throw Error("Original expired configuration preparation required");
  const s = openState(local.dataRoot, inspected.leaseId, local);
  try {
    return guarded(s, () => {
      const t = tree(s),
        grant = t.grants.get(parsed.delegationId),
        child = t.children.get(parsed.delegationId);
      if (
        t.root.phase !== "cancel_pending" ||
        t.grants.size !== 1 ||
        t.children.size !== 1 ||
        !grant ||
        grant.parentNode !== null ||
        !child ||
        Object.keys(child.grantDigests).length ||
        (!child.nonAdmission && (child.phase !== "held" || child.settlement !== null))
      )
        throw Error("Original frozen unadmitted preparation child required");
      const name = `${grant.delegationId}.json`,
        raw = readPrivateRecord(local, "adoptions", name, 8192),
        adoption = z
          .object({
            state: z.literal("ready"),
            execution: executionRefSchema,
            grantDigest: digest,
            assertion: z.string(),
          })
          .parse(raw);
      if (
        adoption.assertion !== assertion ||
        adoption.grantDigest !== parsed.grantDigest ||
        controlDigest(adoption.execution) !== controlDigest(grant.child)
      )
        throw Error("Original ready receiver adoption required");
      // This is checked inside the physical journal guard. An admitted worker
      // always retains its private execution BEFORE any SQL/guard/effect work.
      for (const [namespace, file] of [
        ["executions", `${grant.child.operationKey}.json`],
        ["effects", `${grant.child.operationKey}.json`],
        ["effect-started", `${grant.child.operationKey}.json`],
        ["execution-adoptions", `${grant.child.operationKey}.json`],
        ["observations", `terminal-${grant.child.operationKey}.json`],
      ]) {
        try {
          readPrivateRecord(local, namespace!, file!);
          throw Error("Admitted or ambiguous receiver preparation remains fenced");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (child.nonAdmission) {
        if (
          child.nonAdmission.payload.adoptionDigest !== controlDigest(raw) ||
          canonicalJson(child.nonAdmission.payload.input) !== canonicalJson(input)
        )
          throw Error("Original negative receiver proof changed");
        return child.nonAdmission;
      }
      const proof = signControl(
        local.privateKey,
        CONFIGURATION_PREPARE_NON_ADMISSION_DOMAIN,
        configurationPrepareNonAdmissionPayloadSchema.parse({
          version: 1,
          kind: "configuration-prepare-not-admitted",
          installationId: installation.installationId,
          origin: grant.origin,
          leaseId: inspected.leaseId,
          certificateDigest: inspected.ownerCertificateDigest,
          delegationId: grant.delegationId,
          grantDigest: parsed.grantDigest,
          child: grant.child,
          input,
          adoptionDigest: controlDigest(raw),
          canceledSequence: t.root.sequence,
          observedAt: Date.now(),
        }),
      );
      // Preserve the ready adoption and immutable failed agent canonical. Only
      // this exact DM-signed child advances to a negative physical settlement.
      writeBounded(
        s,
        "children",
        `${grant.delegationId}.json`,
        signControl(local.privateKey, "openmapx-lease-child-v2", {
          ...child,
          sequence: child.sequence + 1,
          phase: "settled",
          nonAdmission: proof,
          settlement: {
            identity: grant.child,
            outcome: "failed_without_effect",
            publication: "not_started",
            terminalReceiptDigest: controlDigest(proof.payload),
          },
        }),
      );
      tree(s);
      return proof;
    });
  } finally {
    closeState(s);
  }
}

/** Reads a receiver's signed negative settlement from the exact original tree;
 * no sibling private directory, admission or parsed caller proof is trusted. */
export function readConfigurationPrepareNonAdmission(authority: VerifiedExecutionAuthority) {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configurationMaintenance.prepare" ||
    owner.installation.installation.role !== "ops-agent"
  )
    throw Error("Original maintenance owner required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    s = stateOf(lease);
  try {
    return guarded(s, () => {
      const t = tree(s),
        children = [...t.children.values()],
        child = children[0];
      if (
        t.grants.size !== 1 ||
        children.length !== 1 ||
        !child?.nonAdmission ||
        child.phase !== "settled" ||
        child.settlement?.terminalReceiptDigest !== controlDigest(child.nonAdmission.payload)
      )
        throw Error("Original negative receiver settlement required");
      return child.nonAdmission;
    });
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}

/** Seal only this original failed producer before asking its recipient for a
 * non-admission certificate. This alone is not containment or lease release. */
export async function prepareFailedServiceLifecycleRecovery(
  authority: VerifiedExecutionAuthority,
  lease: ArtifactTargetLease,
) {
  readFailedServiceHardlinksReceipt(authority);
  const state = executionAuthorityState(authority),
    s = stateOf(lease);
  if (Date.now() < state.execution.deadlineAt) throw Error("Original lifecycle must be expired");
  if (
    s.node !== null ||
    !s.settlementOnly ||
    controlDigest(s.execution) !== controlDigest(state.execution)
  )
    throw Error("Original settlement-only host lease required");
  await guarded(s, () => {
    const t = tree(s);
    if (
      t.grants.size !== 1 ||
      [...t.grants.values()].some(
        (g) =>
          g.parentNode !== null ||
          g.phase !== "hardlinks" ||
          g.childKind !== "generation-hardlinks" ||
          g.recipient !== "data-manager",
      )
    )
      throw Error("Original single hardlink grant required");
    if (t.children.size) throw Error("An adopted or unresolved hardlink child remains fenced");
    if (t.root.phase === "settled") throw Error("Original lifecycle already settled");
    if (t.root.phase !== "cancel_pending") {
      t.root.phase = "cancel_pending";
      t.root.sequence++;
      writeNode(s, t.root);
    }
  });
  cancelControlExecution(authority);
}
/** Receiver-side observation of the original canceled, expired host grant.
 * No peer, adoption, target handle or forward authority is returned. */
export function observeUnadoptedServiceHardlinkGrant(
  installation: import("./control-authority").ControlInstallation,
  assertion: string,
) {
  const local = installationState(installation),
    parsed = parseControlAssertion(assertion);
  const grant = inspectArtifactDelegation({ dataRoot: local.dataRoot, installation, assertion });
  if (
    installation.role !== "data-manager" ||
    local.fixedChildId ||
    grant.owner.executor !== "host-cli" ||
    grant.owner.principal !== "host-cli" ||
    grant.kind !== "generation-hardlinks" ||
    grant.phase !== "hardlinks" ||
    grant.recipient !== "data-manager" ||
    !grant.origin ||
    controlDigest(grant.parent) !== controlDigest(grant.owner) ||
    Date.now() < grant.owner.deadlineAt ||
    Date.now() < grant.execution.deadlineAt
  )
    throw Error("Original expired host hardlink grant required");
  const s = openState(local.dataRoot, grant.leaseId, local);
  try {
    return guarded(s, () => {
      const t = tree(s),
        witness = readControlExecutionWitness(
          local,
          grant.owner,
          local.publicKeys[grant.owner.executor],
        );
      if (
        !["service.start", "service.update"].includes(witness.kind) ||
        t.root.phase !== "cancel_pending" ||
        t.grants.size !== 1 ||
        t.children.size ||
        t.root.grantDigests[grant.delegationId] !== parsed.grantDigest
      )
        throw Error("Original canceled unadopted lifecycle grant required");
      return generationHardlinksNonAdmissionPayloadSchema.parse({
        version: 1,
        kind: "generation-hardlinks-not-admitted",
        installationId: installation.installationId,
        origin: grant.origin,
        leaseId: grant.leaseId,
        certificateDigest: grant.ownerCertificateDigest,
        delegationId: grant.delegationId,
        grantDigest: parsed.grantDigest,
        parent: grant.owner,
        child: grant.execution,
        canceledSequence: t.root.sequence,
      });
    });
  } finally {
    closeState(s);
  }
}
/** Only the original failed host producer may revoke its one never-adopted
 * hardlink grant. Adoption and revocation share the physical journal guard.
 * No recipient key, completion, SQL terminal or successful update is invented. */
export async function revokeUnadoptedServiceHardlinks(
  authority: VerifiedExecutionAuthority,
  lease: ArtifactTargetLease,
  nonAdmission?: unknown,
): Promise<void> {
  if (nonAdmission === undefined) throw Error("Data Manager non-admission proof required");
  const receipt = readFailedServiceHardlinksReceipt(authority),
    state = executionAuthorityState(authority),
    s = stateOf(lease);
  if (Date.now() < state.execution.deadlineAt) throw Error("Original lifecycle must be expired");
  if (
    s.node !== null ||
    controlDigest(s.execution) !== controlDigest(state.execution) ||
    !s.settlementOnly
  )
    throw Error("Original settlement-only host lease required");
  await guarded(s, () => {
    const t = tree(s);
    if (
      t.grants.size !== 1 ||
      [...t.grants.values()].some(
        (grant) =>
          grant.parentNode !== null ||
          grant.childKind !== "generation-hardlinks" ||
          grant.phase !== "hardlinks" ||
          grant.recipient !== "data-manager",
      )
    )
      throw Error("Original single hardlink grant required");
    if ([...t.children.values()].some((child) => !child.unadoptedRevocation))
      throw Error("An adopted hardlink child remains unresolved");
    if (t.root.phase !== "cancel_pending") throw Error("Original lifecycle must be canceled first");
    const proof = verifyControl(
      s.installation.publicKeys["data-manager"],
      GENERATION_HARDLINKS_NON_ADMISSION_DOMAIN,
      nonAdmission,
      generationHardlinksNonAdmissionPayloadSchema,
    );
    const [originalGrant] = t.grants.values();
    if (
      !originalGrant ||
      proof.installationId !== s.certificate.installationId ||
      proof.leaseId !== s.certificate.leaseId ||
      proof.certificateDigest !== controlDigest(s.certificateEnvelope) ||
      proof.delegationId !== originalGrant.delegationId ||
      proof.grantDigest !== t.root.grantDigests[originalGrant.delegationId] ||
      controlDigest(proof.parent) !== controlDigest(s.execution) ||
      controlDigest(proof.child) !== controlDigest(originalGrant.child) ||
      controlDigest(proof.origin) !== controlDigest(originalGrant.origin) ||
      proof.canceledSequence !== t.root.sequence
    )
      throw Error("Data Manager non-admission proof does not match original grant");
    for (const [id, grant] of t.grants) {
      if (t.children.has(id)) {
        if (t.children.get(id)?.failedLifecycleReceiptDigest !== controlDigest(receipt))
          throw Error("Original failed lifecycle receipt changed");
        continue;
      }
      if (!grant.origin) throw Error("Original origin-bound grant required");
      const revoked = unadoptedLifecycleSchema.parse({
        version: 1,
        origin: grant.origin,
        leaseId: s.certificate.leaseId,
        certificateDigest: controlDigest(s.certificateEnvelope),
        delegationId: id,
        grantDigest: t.root.grantDigests[id],
        parent: s.execution,
        child: grant.child,
        failedReceiptDigest: controlDigest(receipt),
        canceledSequence: t.root.sequence,
        nonAdmission,
      });
      writeBounded(
        s,
        "children",
        `${id}.json`,
        { unadoptedRevocation: signControl(s.key, unadoptedLifecycleDomain, revoked) },
        true,
      );
    }
    tree(s);
  });
}
/** The effect producer re-reads the actual signed failure and complete shared
 * tree; a caller-provided HTTP status or observation is never containment.
 * A failure whose tree holds no grant issued nothing that could outlive it.
 * Once a grant exists, only its recorded unadopted revocation contains it. */
export function verifyFailedServiceLifecycleContainment(authority: VerifiedExecutionAuthority) {
  const state = executionAuthorityState(authority);
  const reference = z
    .strictObject({ leaseId: uuid, certificateDigest: digest })
    .parse(
      readPrivateRecord(
        state.installation,
        "execution-leases",
        `${state.execution.operationKey}.json`,
      ),
    );
  const s = openState(state.installation.dataRoot, reference.leaseId, state.installation, true);
  try {
    const t = tree(s);
    if (
      controlDigest(s.certificateEnvelope) !== reference.certificateDigest ||
      controlDigest(s.execution) !== controlDigest(state.execution)
    )
      throw Error("Original unadopted hardlink revocation required");
    if (t.grants.size === 0 && t.children.size === 0) {
      const failure = readFailedServiceLifecycleReceipt(authority);
      return {
        failedReceiptDigest: controlDigest(failure),
        revisionId: failure.finalRevisionId,
        leaseId: reference.leaseId,
      };
    }
    const receipt = readFailedServiceHardlinksReceipt(authority),
      failedReceiptDigest = controlDigest(receipt);
    if (
      t.root.phase === "held" ||
      t.grants.size !== 1 ||
      t.children.size !== 1 ||
      [...t.children.values()].some(
        (child) =>
          !child.unadoptedRevocation || child.failedLifecycleReceiptDigest !== failedReceiptDigest,
      )
    )
      throw Error("Original unadopted hardlink revocation required");
    return {
      failedReceiptDigest,
      revisionId: receipt.finalRevisionId,
      leaseId: reference.leaseId,
    };
  } finally {
    closeState(s);
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
  const ownerName = `${reference.leaseId}.json`,
    saved = readPrivateRecord(state.installation, "leases", ownerName);
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

/** The delegation's root lease is still held by its owner: not released and
 * not settled. Observation only; it returns no lease or capability. */
export function assertArtifactDelegationRootHeld(
  installation: import("./control-authority").ControlInstallation,
  assertion: string,
): void {
  const local = installationState(installation),
    parsed = parseControlAssertion(assertion),
    state = openState(local.dataRoot, parsed.leaseId, local);
  try {
    guarded(state, () => {
      if (tree(state).root.phase === "settled" || state.slots?.release)
        throw Error("Original owner lease is no longer held");
    });
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

/** The physical owner that ran the effects; a lease restored for settlement never records them. */
export function assertArtifactTargetLeaseContainmentOwner(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): void {
  assertArtifactTargetLeaseReceiptOwner(lease, execution);
  if (stateOf(lease).settlementOnly) throw Error("Recovered lease permits settlement only");
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
  if (
    state.kind !== "configurationMaintenance.prepare" ||
    !owner.preparedFence ||
    tree.certificateDigest !== owner.rootCertificateDigest ||
    owner.admissionDigest !== state.receiptDigest ||
    canonicalJson(owner.plan.prepare) !== canonicalJson(state.execution)
  )
    throw Error("Original final child owner required");
  const fence = state.reservations.find((value) => value.phase === "configuration-fence"),
    fenceBinding = fence && lookupControlChildPhaseBinding(authority, fence);
  if (!fenceBinding) throw Error("Original fence preparation binding required");
  const children: ReturnType<typeof configurationChildEvidenceSchema.parse>[] = [],
    allowed = new Set([controlDigest(fenceBinding.child.execution)]);
  for (const step of owner.plan.steps) {
    const source = owner.apiControls.steps.find((value) => value.ordinal === step.ordinal),
      publication = inspectControlChildPublication(authority, step);
    if (!source) {
      if (publication.binding !== null || publication.publication.state !== "unissued")
        throw Error("Frozen child attempt has no original source");
      continue;
    }
    if (!source.canonical) throw Error("Original frozen child canonical delivery pending");
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
    if (step.phase === "maintenance-handoff" && owner.plan.handoff && owner.plan.nestedHandoff) {
      const helper = readCompletedConfigurationHandoff(
          state.installation.installation,
          owner.plan.handoff.handoffId,
        ),
        physical = tree.children.find(
          (value) => canonicalJson(value.execution) === canonicalJson(helper.intent.helper),
        );
      if (
        canonicalJson(helper.intent.operation) !== canonicalJson(step.operation) ||
        canonicalJson(helper.intent.preparer) !== canonicalJson(actual.execution) ||
        helper.intent.ownerCertificateDigest !== owner.rootCertificateDigest ||
        !physical ||
        canonicalJson(physical.settlement) !== canonicalJson(helper.settlement)
      )
        throw Error("Original fixed helper settlement unavailable");
      allowed.add(controlDigest(helper.intent.helper));
      children.push(
        configurationChildEvidenceSchema.parse({
          planIndex: step.ordinal,
          execution: helper.intent.helper,
          terminalDigest: controlDigest(helper.completion),
          terminalAt: helper.completion.completedAt,
          effectSettlementDigest: controlDigest(helper.settlement),
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
      owner.apiControls.steps.some((value) => value.ordinal === step.ordinal && value.canonical),
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

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function need(value: unknown, message: string): asserts value {
  if (!value) throw Error(message);
}
/** The original owner's own final and inspection, after the data-manager
 * confirmed the settle. Parsed prepared status alone cannot enter it. */
function assertPreparedAndSettledClosure(
  authority: VerifiedExecutionAuthority,
  observation: ConfigurationMaintenanceClosureObservation,
  owner: z.infer<typeof configurationMaintenanceOwnerRecordSchema>,
): void {
  const tree = configurationMaintenanceClosureObservationState(observation, authority),
    state = executionAuthorityState(authority);
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
      owner.preparedFence &&
      owner.receipt.dmFence?.state === "settled" &&
      owner.apiControls.decide,
    "Actual prepared final, inspection and settled fence required",
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
      configurationFinalDomains.ownerFinal,
      owner.final.ownerFinal,
      configurationOwnerFinalSchema,
    ),
    inspection = verifyControl(
      state.installation.installation.publicKey,
      configurationFinalDomains.inspection,
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
      final.evidenceDigest === owner.final.evidenceDigest &&
      owner.receipt.dmFence.fenceId === owner.preparedFence.fenceId,
    "Original actual final/inspection changed",
  );
  for (const step of final.outcome === "unused" ? owner.plan.steps : []) {
    const phase = inspectControlChildPublication(authority, step);
    need(
      phase.binding === null && phase.publication.state === "unissued",
      "Unused final has attempted frozen work",
    );
  }
}
/** The maintenance root may release once every descendant is contained and
 * either its fence is settled after a final, or no fence was ever prepared
 * and its own prepare recorded that it failed without effect. */
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
      configurationMaintenanceOwnerRecordSchema,
    );
  if (owner.preparedFence !== null || owner.final !== null || owner.inspection !== null) {
    assertPreparedAndSettledClosure(authority, observed, owner);
    return;
  }
  need(
    owner.receipt.dmFence === null &&
      owner.receipt.generation === "not_started" &&
      owner.installationId === state.installation.installation.installationId &&
      owner.admissionDigest === state.receiptDigest &&
      same(owner.origin, state.origin) &&
      same(owner.plan.prepare, state.execution) &&
      owner.rootCertificateDigest === tree.certificateDigest &&
      tree.children.every((child) => child.settlement.outcome !== "committed"),
    "Never-prepared maintenance closure required",
  );
  const own = childSettlementState(
    verifyControlEffectSettlement(state.installation.installation, state.execution),
  ).evidence;
  need(
    own.outcome === "failed_without_effect" &&
      own.terminalReceiptDigest ===
        controlDigest({
          kind: "configuration-fence-not-prepared",
          maintenanceId: owner.plan.operation.maintenanceId,
        }),
    "Original never-prepared maintenance effect required",
  );
}
