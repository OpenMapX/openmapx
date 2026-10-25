import { createPrivateKey, type KeyObject, randomUUID } from "node:crypto";
import { fsyncSync, mkdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  type ExecutionRef,
  executionFingerprint,
  executionRefSchema,
} from "../ops/execution-identity";
import { canonicalJson } from "../ops/fingerprint";
import {
  type ArtifactDelegationAssertion,
  type AuthorityState,
  assertControlDelegationForward,
  assertControlExecutionForward,
  assertionSchema,
  type ChildSettlement,
  type ControlChildPhase,
  type ControlPlannedChild,
  type ControlRecipient,
  childPhaseKinds,
  childSettlementState,
  controlChildOperationKey,
  controlDigest,
  controlOriginSchema,
  controlPeerState,
  digest,
  encodePrivate,
  executionAuthorityState,
  fixedControlChildId,
  type InstallationState,
  installationState,
  newControlKey,
  originRecordDomain,
  parseControlAssertion,
  readControlExecutionWitness,
  readPrivateRecord,
  recoveryAuthorityState,
  retainedControlParent,
  sameControlOrigin,
  signControl,
  targetSchema,
  uuid,
  type VerifiedChildSettlement,
  type VerifiedControlPeer,
  type VerifiedExecutionAuthority,
  type VerifiedRecoveryAuthority,
  validateOriginRecord,
  verifyControl,
  verifyControlEffectSettlement,
  verifyControlPreparedTerminal,
  writePrivateRecord,
} from "./control-authority";
import { CONTROL_RETENTION_LIMITS, reserveAuthoritySlot } from "./control-retention";
import { AnchoredDirectory, type FileIdentity, identity, sameInode } from "./filesystem";
import { assertOriginClockForward } from "./retention-clock";
import {
  enlistFamilyIntent,
  familyRecordWrite,
  hasLocalRetentionFamily,
  markFamilyLeaseReleased,
  registerFamilyLease,
  reserveControlFamily,
  trackFamilyDirectory,
} from "./retention-family";

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
const admissionSlotSchema = z.strictObject({
  version: z.literal(1),
  installationId: uuid,
  leaseId: uuid,
  certificateDigest: digest,
  active: slotSchema,
  history: slotSchema,
  release: z
    .object({
      phase: z.enum(["planned", "released"]),
      locks: z.array(z.string()).max(16),
      active: z.boolean(),
      pending: z.string().optional(),
      activePlanned: z.boolean().optional(),
    })
    .optional(),
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
  slots?: AdmissionSlots;
}
const handles = new WeakMap<object, State>();
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
      const expectedEdges = verifyFiniteEdge(
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
      signControl(authority.installation.privateKey, "openmapx-admission-slots-v1", slots),
    );
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
function verifyFiniteEdge(
  role: ControlRecipient | "host-cli",
  kind: string,
  phase: ControlChildPhase,
  recipient: ControlRecipient,
): string[] {
  if (role === "data-manager") {
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
    ["lifecycle", "build", "data-link", "data-clean"].includes(phase) &&
    childPhaseKinds[phase].includes(kind)
  )
    return phase === "data-clean" ? [] : ["hardlinks"];
  if (
    ["ops-agent", "fixed-cli", "host-cli"].includes(role) &&
    recipient === "data-manager" &&
    phase === "hardlinks" &&
    [
      "service.start",
      "system.update",
      "service.build",
      "services.buildAll",
      "data.link",
      "configuration.hardlinks.apply",
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
  return verifyFiniteEdge(
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
  if (s.verifiedAuthority) assertControlDelegationForward(s.verifiedAuthority, child.phase);
  return guarded(s, () => {
    const current = tree(s);
    const node =
      s.node === null
        ? current.root
        : required(current.children.get(s.node), "Missing retained child node");
    if (!forwardAncestry(current, s.node) || Date.now() >= s.execution.deadlineAt)
      throw Error("Lease does not permit forward delegation");
    let plan = s.authority?.plan.find(
      (p) =>
        controlDigest(p.execution) === controlDigest(child.execution) &&
        p.phase === child.phase &&
        p.recipient === child.recipient &&
        canonicalJson(p.serviceIds) === canonicalJson(child.serviceIds),
    );
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
      [...current.grants.values()].some(
        (g) => g.child.operationKey === child.execution.operationKey,
      )
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
  });
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
function finishOwnedRelease(s: State): void {
  guarded(
    s,
    () => {
      const t = tree(s);
      if (t.root.phase !== "settled" || !knownOutcome(t.root.settlement))
        throw Error("Durable own-effect settlement is required");
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
          signControl(s.installation.privateKey, "openmapx-admission-slots-v1", s.slots),
        );
      const release = s.slots.release ?? { phase: "planned" as const, locks: [], active: false };
      s.slots.release = release;
      if (
        release.locks.some((id) => !s.certificate.serviceIds.includes(id)) ||
        (release.pending && !s.certificate.serviceIds.includes(release.pending))
      )
        throw Error("Invalid release journal target");
      for (const id of s.certificate.serviceIds) {
        if (release.locks.includes(id)) continue;
        if (release.pending && release.pending !== id)
          throw Error("Conflicting physical release step");
        if (release.pending !== id) {
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
          release.pending = id;
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
        release.locks.push(id);
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
  if (!s.certificate.origin)
    throw Error("Legacy lease is observation/settlement only; upgrade producer");
  assertOriginClockForward(s.installation, s.certificate.origin);
  if (s.verifiedAuthority) assertControlExecutionForward(s.verifiedAuthority);
  const t = tree(s);
  const node = s.node === null ? t.root : t.children.get(s.node);
  if (!node || !forwardAncestry(t, s.node) || Date.now() >= s.execution.deadlineAt)
    throw Error("Target lease permits observation/settlement only");
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
