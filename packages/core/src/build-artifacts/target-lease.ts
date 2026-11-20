import { randomUUID } from "node:crypto";
import { canonicalJson } from "../ops/canonical-json";
import { opsOperationSchema } from "../ops/contract";
import { controlOriginSchema } from "../ops/control-root-key";
import type { ExecutionRef, VerifiedParentExecution } from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
import type { DataManagerTransport } from "../services/data-manager/transport";
import { controlDigest, type InstallationState, targetSchema } from "./control-records";
import { verifyDataUpdatePrerequisites } from "./data-update";
import {
  assertControlDelegationForward,
  assertControlExecutionForward,
  attestParentExecution,
  type ChildSettlement,
  type ControlDelegation,
  controlPeerState,
  type ExecutionHandle,
  fixedChildSpawn,
  inspectControlChildPublication,
  type LeaseChildRef,
  lookupControlChildPhase,
  prepareControlChildPublication,
  resolveControlChildPlan,
  retainedControlParent,
  type VerifiedControlPeer,
  verifyControlEffectSettlement,
  verifyControlPreparedTerminal,
  withControlDelegationPublication,
} from "./execution-record";
import {
  admitRootLease,
  type ControlChildPhase,
  type ControlRecipient,
  childPhaseKinds,
  controlChildOperationKey,
  descendantsOf,
  furtherEdges,
  knownSettlement,
  type LeaseBackend,
  type LeaseRecord,
  leaseChildrenOf,
  leaseNodeForward,
  localLeases,
  requireLocalLeases,
  rootLeaseId,
  sameExecution,
  settledKnown,
} from "./lease-store";
import { installationState } from "./private-records";

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

interface State {
  backend: LeaseBackend;
  installation: InstallationState;
  leaseId: string;
  node: string | null;
  owner: ExecutionRef;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  authority?: ExecutionHandle;
  settlementOnly?: boolean;
  /** A remote lease is only read when asked; this remembers what was last seen. */
  seen?: LeaseRecord;
  canceled?: boolean;
}
const handles = new WeakMap<object, State>();
/** Operation keys with an open root handle from `acquireArtifactTargetLease` in this process. */
const openRoots = new Set<string>();
function stateOf(lease: TargetLeaseAuthority): State {
  const state = handles.get(lease);
  if (!state || (lease.mode === "owner") !== (state.node === null))
    throw Error("Unverified or mixed target lease authority");
  return state;
}
function handleFor(state: State): TargetLeaseAuthority {
  const lease =
    state.node === null
      ? Object.freeze({
          leaseId: state.leaseId,
          owner: state.owner,
          serviceIds: Object.freeze([...state.serviceIds]),
          mode: "owner" as const,
        })
      : Object.freeze({
          leaseId: state.leaseId,
          owner: state.owner,
          execution: state.execution,
          serviceIds: Object.freeze([...state.serviceIds]),
          mode: "borrowed" as const,
        });
  handles.set(lease, state);
  return lease;
}
/** The current record of a lease the role can read without waiting, else the last one seen. */
function current(s: State): LeaseRecord | undefined {
  const local = localLeases(s.backend);
  if (local) {
    const record = local.readSync(s.leaseId);
    s.seen = record;
    return record;
  }
  return s.seen;
}
async function fresh(s: State): Promise<LeaseRecord | undefined> {
  s.seen = await s.backend.read(s.leaseId);
  return s.seen;
}

export async function acquireArtifactTargetLease(options: {
  serviceIds: readonly string[];
  owner: ExecutionHandle;
  signal?: AbortSignal;
  /** Where a Full Update reads its data children's terminals. */
  dataManager?: DataManagerTransport;
}): Promise<ArtifactTargetLease> {
  const authority = options.owner;
  if (authority.installation.fixedChildId)
    throw Error("Fixed children must borrow and cannot acquire a root");
  const serviceIds = targetSchema.parse(options.serviceIds);
  if (
    serviceIds.some((id) => !authority.serviceIds.includes(id)) ||
    Date.now() >= authority.execution.deadlineAt
  )
    throw Error("Target closure or execution deadline mismatch");
  if (authority.kind === "data.update")
    await verifyDataUpdatePrerequisites(options.owner, options.dataManager, options.signal);
  await assertControlExecutionForward(options.owner);
  options.signal?.throwIfAborted();
  // The store returns an existing lease to a repeated acquisition, so a lost
  // reply can be retried; a second root handle in this process is refused.
  const key = authority.execution.operationKey;
  if (openRoots.has(key))
    throw Error("Execution already acquired a root lease; reconcile its original identity");
  const record = await admitRootLease(
    authority.installation.leases,
    { owner: authority.execution, ownerKind: authority.kind, targets: serviceIds },
    options.signal,
  );
  openRoots.add(key);
  return handleFor({
    backend: authority.installation.leases,
    installation: authority.installation,
    leaseId: record.leaseId,
    node: null,
    owner: authority.execution,
    execution: authority.execution,
    serviceIds,
    authority: options.owner,
    seen: record,
  }) as ArtifactTargetLease;
}

export async function delegateArtifactTargetLease(
  lease: TargetLeaseAuthority,
  child: {
    execution: ExecutionRef;
    phase: ControlChildPhase;
    serviceIds: readonly string[];
    recipient: ControlRecipient;
    /** A fixed CLI child's key, chosen with its spawn record; others get a fresh one. */
    childKey?: string;
    evidence?: Record<string, unknown>;
  },
): Promise<ControlDelegation> {
  const s = stateOf(lease);
  if (s.settlementOnly) throw Error("Recovered lease permits settlement only");
  const authority = s.authority;
  if (!authority) throw Error("A durable local execution must own child grant publication");
  const owner = authority;
  const record = await fresh(s);
  if (!record) throw Error("Target lease is not held");
  if (!leaseNodeForward(record, s.node, Date.now()) || Date.now() >= s.execution.deadlineAt)
    throw Error("Lease does not permit forward delegation");
  let plan = await resolveControlChildPlan(authority, child);
  if (plan && canonicalJson(plan.serviceIds) !== canonicalJson(child.serviceIds))
    throw Error("Reserved child target subset changed");
  const parent = s.node === null ? undefined : record.children.find((c) => c.key === s.node);
  if (!plan && parent) {
    const kinds = childPhaseKinds[child.phase];
    if (
      furtherEdges(record, parent).includes(child.phase) &&
      kinds.length === 1 &&
      child.execution.operationKey ===
        controlChildOperationKey(s.execution.operationKey, child.phase, 0)
    )
      plan = { ...child, kind: kinds[0] as string, ordinal: 0 };
  }
  if (!plan) throw Error("Child is absent from immutable admitted plan");
  if (child.serviceIds.some((id) => !lease.serviceIds.includes(id)))
    throw Error("Widened target subset");
  if (
    owner.kind === "configurationMaintenance.prepare" &&
    [
      "configuration-commit",
      "maintenance-hardlinks",
      "maintenance-recreate",
      "maintenance-handoff",
    ].includes(child.phase)
  )
    verifyControlPreparedTerminal(owner.installation, s.execution);
  const childKey =
    child.recipient === "fixed-cli"
      ? fixedChildSpawn(owner.installation, child.childKey ?? "", child.execution).childKey
      : randomUUID();
  const row = {
    key: childKey,
    parentKey: s.node,
    parent: s.execution,
    execution: child.execution,
    kind: plan.kind,
    phase: child.phase,
    recipient: child.recipient,
    targets: [...child.serviceIds],
    origin: owner.origin,
  };
  const delegation: ControlDelegation = {
    leaseId: s.leaseId,
    childKey,
    owner: s.owner,
    parent: s.execution,
    execution: child.execution,
    kind: plan.kind,
    phase: child.phase,
    targets: [...child.serviceIds],
    origin: owner.origin,
  };
  // The reserved phase records the child before its store row: a child is
  // attempted once the phase says so, and recovery reads the phase first.
  await withControlDelegationPublication(authority, child.phase, (progress) => {
    prepareControlChildPublication(authority, progress, plan, delegation);
  });
  s.seen = await s.backend.delegate({
    leaseId: s.leaseId,
    child: { ...row, ...(child.evidence ? { evidence: child.evidence } : {}) },
  });
  return delegation;
}

/** The store row of a child, for a receiver that reads the store. No adoption or effect authority. */
export function inspectArtifactDelegation(options: {
  leaseChild: LeaseChildRef;
  installation: import("./control-records").ControlInstallation;
}) {
  const local = installationState(options.installation);
  const lease = requireLocalLeases(local.leases).readSync(options.leaseChild.leaseId),
    grant = lease?.children.find((child) => child.key === options.leaseChild.childKey);
  if (!lease || !grant) throw Error("Unanchored delegation");
  return Object.freeze({
    leaseId: lease.leaseId,
    owner: lease.owner,
    parent: grant.parent,
    execution: grant.execution,
    kind: grant.kind,
    serviceIds: Object.freeze([...grant.targets]),
    recipient: grant.recipient,
    phase: grant.phase,
    childKey: grant.key,
    origin: grant.origin,
    retained: grant.adopted,
  });
}

/** The parent that issued a delegation, for a recipient that reads the store. */
export function verifiedParentForArtifactDelegation(
  installation: import("./control-records").ControlInstallation,
  leaseChild: LeaseChildRef,
  execution: ExecutionRef,
): VerifiedParentExecution {
  const inspected = inspectArtifactDelegation({ leaseChild, installation });
  if (!sameExecution(inspected.execution, execution)) throw Error("Wrong delegated execution");
  const parent = Object.freeze(retainedControlParent(inspected.parent)) as VerifiedParentExecution;
  verifiedParents.add(parent);
  verifiedParentOrigins.set(parent, controlOriginSchema.parse(inspected.origin));
  return parent;
}
export async function adoptArtifactTargetLease(options: {
  peer: VerifiedControlPeer;
  execution: ExecutionRef;
  serviceIds: readonly string[];
}): Promise<BorrowedArtifactTargetLease> {
  const peer = controlPeerState(options.peer);
  if (controlDigest(options.execution) !== controlDigest(peer.execution))
    throw Error("Peer execution binding mismatch");
  const inspected = inspectArtifactDelegation({
    leaseChild: peer.leaseChild,
    installation: peer.installation.installation,
  });
  const lease = localLeases(peer.installation.leases)?.readSync(inspected.leaseId);
  if (!lease) throw Error("Unanchored delegation");
  if (
    !sameExecution(inspected.execution, options.execution) ||
    inspected.kind !== peer.kind ||
    inspected.recipient !== peer.recipient ||
    canonicalJson(inspected.serviceIds) !== canonicalJson(targetSchema.parse(options.serviceIds))
  )
    throw Error("Wrong peer principal, kind, key, fingerprint, or subset");
  const parent = lease.children.find((child) => child.key === inspected.childKey)?.parentKey;
  const issuer =
    (parent && lease.children.find((child) => child.key === parent)?.recipient) ??
    lease.owner.executor;
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
      ].includes(inspected.phase)
    )
  )
    throw Error("Wrong peer principal");
  const adopted = await requireLocalLeases(peer.installation.leases).adopt({
    leaseId: inspected.leaseId,
    key: inspected.childKey,
    execution: inspected.execution,
  });
  return handleFor({
    backend: peer.installation.leases,
    installation: peer.installation,
    leaseId: inspected.leaseId,
    node: inspected.childKey,
    owner: adopted.owner,
    execution: inspected.execution,
    serviceIds: inspected.serviceIds,
    seen: adopted,
  }) as BorrowedArtifactTargetLease;
}

/** A fixed receiver supplies its own durable execution authority only after adoption. */
export function bindBorrowedControlExecution(
  lease: BorrowedArtifactTargetLease,
  authority: ExecutionHandle,
): void {
  const s = stateOf(lease);
  if (!sameExecution(authority.execution, lease.execution))
    throw Error("Borrower execution authority mismatch");
  s.authority = authority;
}

export async function settleArtifactTargetLeaseChild(
  lease: TargetLeaseAuthority,
  settlement: ChildSettlement,
): Promise<void> {
  const s = stateOf(lease);
  if (!sameExecution(settlement.identity, s.execution)) throw Error("Foreign settlement identity");
  s.seen = await s.backend.settle({ leaseId: s.leaseId, key: s.node, settlement });
}

/** Whether the lease is still in the store; releasing it removes it. */
export async function artifactTargetLeaseHeld(lease: TargetLeaseAuthority): Promise<boolean> {
  const s = stateOf(lease);
  return (await s.backend.read(s.leaseId)) !== undefined;
}
export async function releaseArtifactTargetLease(lease: ArtifactTargetLease): Promise<void> {
  const s = stateOf(lease);
  if (s.node !== null) throw Error("Borrower cannot release root");
  await s.backend.release({ leaseId: s.leaseId });
  s.seen = undefined;
}

export async function cancelArtifactTargetLease(
  lease: TargetLeaseAuthority,
): Promise<readonly ExecutionRef[]> {
  const s = stateOf(lease);
  s.canceled = true;
  const record = await s.backend.cancel({ leaseId: s.leaseId, key: s.node });
  s.seen = record;
  // These immutable attempted identities are the adapter's cancellation outbox.
  return Object.freeze(
    (record ? descendantsOf(record, s.node) : []).map((child) =>
      Object.freeze({ ...child.execution }),
    ),
  );
}

/** Observation/adoption of an old identity is not permission to start another forward effect. */
export async function assertArtifactTargetLeaseForward(lease: TargetLeaseAuthority): Promise<void> {
  const s = stateOf(lease);
  if (s.settlementOnly || s.canceled) throw Error("Recovered lease permits settlement only");
  if (s.authority) await assertControlExecutionForward(s.authority);
  const record = current(s);
  if (
    !record ||
    !leaseNodeForward(record, s.node, Date.now()) ||
    Date.now() >= s.execution.deadlineAt
  )
    throw Error("Target lease permits observation/settlement only");
}
export async function assertArtifactTargetLeaseExecution(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): Promise<void> {
  if (!sameExecution(stateOf(lease).execution, execution))
    throw Error("Lifecycle lease execution mismatch");
  await assertArtifactTargetLeaseForward(lease);
}
/** Receipt-only evidence: the exact owner may record containment after cancellation. */
export function assertArtifactTargetLeaseReceiptOwner(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): void {
  const s = stateOf(lease);
  if (!sameExecution(s.execution, execution)) throw Error("Receipt lease execution mismatch");
  const record = current(s);
  const node = record && (s.node === null ? record : record.children.find((c) => c.key === s.node));
  if (!node || node.state === "settled") throw Error("Receipt owner is already settled");
}
/** The owner that ran the effects; a lease restored for settlement never records them. */
export function assertArtifactTargetLeaseContainmentOwner(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): void {
  assertArtifactTargetLeaseReceiptOwner(lease, execution);
  if (stateOf(lease).settlementOnly) throw Error("Recovered lease permits settlement only");
}
/** Drops the in-process handle. The lease, its children and every unknown fence remain. */
export function closeArtifactTargetLeaseHandle(lease: TargetLeaseAuthority): void {
  const s = handles.get(lease);
  if (!s || !handles.delete(lease)) throw Error("Unverified target lease handle");
  if (s.node === null && !s.settlementOnly) openRoots.delete(s.execution.operationKey);
}

function executionLeaseId(authority: ExecutionHandle): string {
  return rootLeaseId(authority.execution);
}
/** Reopen the original owned lease for cancellation and settlement only. */
export function restoreArtifactTargetLeaseForSettlement(
  authority: ExecutionHandle,
): ArtifactTargetLease {
  const a = authority;
  return handleFor({
    backend: a.installation.leases,
    installation: a.installation,
    leaseId: executionLeaseId(authority),
    node: null,
    owner: a.execution,
    execution: a.execution,
    serviceIds: a.serviceIds,
    authority,
    settlementOnly: true,
  }) as ArtifactTargetLease;
}
/** Settles the owner from recovery evidence and releases it when every child is known. */
export async function reconcileArtifactTargetLease(options: {
  leaseId: string;
  authority: ExecutionHandle;
}): Promise<"released" | "fenced"> {
  const owner = options.authority;
  const backend = owner.installation.leases;
  const lease = await backend.read(options.leaseId);
  if (!lease) return "released";
  if (!sameExecution(lease.owner, owner.execution)) throw Error("Foreign recovery execution");
  const evidence = await verifyControlEffectSettlement(
    owner.installation.installation,
    owner.execution,
  );
  if (!knownSettlement(evidence) || lease.children.some((child) => !settledKnown(child)))
    return "fenced";
  if (lease.state !== "settled")
    await backend.settle({ leaseId: lease.leaseId, key: null, settlement: evidence });
  await backend.release({ leaseId: lease.leaseId });
  return "released";
}
/** Image pulls hold no lease, but never run while their target is held. */
export function assertCoordinatorPullLeaseCompatibility(authority: ExecutionHandle): void {
  assertImagePullTargetFree(authority, "service.pull");
}
export function assertImageStageLeaseCompatibility(authority: ExecutionHandle): void {
  assertImagePullTargetFree(authority, "service.image.stage");
}
function assertImagePullTargetFree(
  state: ExecutionHandle,
  kind: "service.pull" | "service.image.stage",
): void {
  const operation = opsOperationSchema.parse(state.operation);
  if (
    state.installation.fixedChildId ||
    state.kind !== kind ||
    operation.kind !== kind ||
    !("serviceId" in operation) ||
    (operation.kind === "service.pull" &&
      (operation.serviceId !== "data-manager" || !operation.candidateId)) ||
    opsOperationFingerprint(operation) !== state.execution.operationFingerprint
  )
    throw Error("Actual normal coordinator pull required");
  const target = operation.serviceId;
  if (!state.installation.registeredTargets.has(target))
    throw Error("Registered image target required");
  const local = localLeases(state.installation.leases);
  if (!local) throw Error("Image pulls run in the agent");
  for (const lease of local.listSync())
    if (lease.targets.includes(target)) throw Error("Coordinator target is held");
}

function childSettlementOf(
  record: LeaseRecord | undefined,
  node: string | null,
  execution: ExecutionRef,
): ChildSettlement | null {
  if (!record) throw Error("Target lease is not held");
  const entries = leaseChildrenOf(record, node).filter((child) =>
    sameExecution(child.execution, execution),
  );
  const [child] = entries;
  if (entries.length !== 1 || !child) throw Error("Exact retained child grant required");
  return settledKnown(child) ? (child.settlement as ChildSettlement) : null;
}
/** The settlement of the exact child `execution` issued by this lease node, if it is known. */
export async function inspectArtifactTargetLeaseChildSettlement(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): Promise<ChildSettlement | null> {
  const s = stateOf(lease);
  return childSettlementOf(await fresh(s), s.node, execution);
}
/** The same, for a role that reads the store itself. */
export function inspectLocalLeaseChildSettlement(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): ChildSettlement | null {
  const s = stateOf(lease);
  requireLocalLeases(s.backend);
  return childSettlementOf(current(s), s.node, execution);
}
/**
 * Settles the child `execution` this lease node issued, from the answer its
 * recipient gave to this role over an authenticated route. A recorded
 * settlement never changes.
 */
export async function settleIssuedLeaseChild(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
  evidence: Omit<ChildSettlement, "identity">,
): Promise<ChildSettlement> {
  const s = stateOf(lease);
  const record = await fresh(s);
  const child = record
    ? leaseChildrenOf(record, s.node).find((value) => sameExecution(value.execution, execution))
    : undefined;
  if (!record || !child) throw Error("Exact retained child grant required");
  if (child.settlement && child.state === "settled") {
    if (
      child.settlement.outcome !== evidence.outcome ||
      child.settlement.publication !== evidence.publication
    )
      throw Error("Original child settlement changed");
    return child.settlement as ChildSettlement;
  }
  const settlement: ChildSettlement = { identity: execution, ...evidence };
  s.seen = await s.backend.settle({ leaseId: s.leaseId, key: child.key, settlement });
  return settlement;
}
/** The settlement of an original owned child, read through the owner's lease reference. */
export async function inspectRetainedOwnedArtifactTargetChildSettlement(
  authority: ExecutionHandle,
  execution: ExecutionRef,
): Promise<ChildSettlement | null> {
  const lease = restoreArtifactTargetLeaseForSettlement(authority);
  try {
    return await inspectArtifactTargetLeaseChildSettlement(lease, execution).catch(
      (error: unknown) => {
        if ((error as Error).message === "Target lease is not held") return null;
        throw error;
      },
    );
  } finally {
    closeArtifactTargetLeaseHandle(lease);
  }
}
/** Terminal-only check for a recovered catalog activation: every child settled. */
export async function assertRetainedCatalogActivationChildrenSettled(
  owner: ExecutionHandle,
): Promise<void> {
  const authority = owner;
  if (owner.kind !== "catalog.activate" || owner.installation.installation.role !== "data-manager")
    throw Error("Original catalog activation owner required");
  const lease = await owner.installation.leases.read(executionLeaseId(authority));
  if (lease && lease.children.some((child) => !settledKnown(child)))
    throw Error("Catalog child tree remains unsettled");
}

/** Holder of MOTIS for catalog pins: the agent or the standalone host CLI. */
export async function catalogPinTargetOwner(lease: TargetLeaseAuthority) {
  await assertArtifactTargetLeaseForward(lease);
  const s = stateOf(lease);
  if (!s.serviceIds.includes("motis"))
    throw Error("MOTIS target authority required for catalog pins");
  if (!["ops-agent", "host-cli"].includes(s.installation.installation.role))
    throw Error("Catalog pins are owned by the agent or standalone host CLI");
  return {
    installation: s.installation.installation,
    execution: s.execution,
    origin: s.authority?.origin,
  };
}

/** The delegation's root lease is still held by its owner. Observation only. */
export function assertArtifactDelegationRootHeld(
  installation: import("./control-records").ControlInstallation,
  leaseChild: LeaseChildRef,
): void {
  const local = installationState(installation),
    lease = localLeases(local.leases)?.readSync(leaseChild.leaseId);
  if (!lease || lease.state === "settled") throw Error("Original owner lease is no longer held");
}
/** Read-only terminal evidence of a borrowed child after the agent restarted. */
export async function verifyRetainedArtifactTargetSettlement(
  installation: import("./control-records").ControlInstallation,
  leaseChild: LeaseChildRef,
  execution: ExecutionRef,
): Promise<void> {
  const local = installationState(installation);
  const lease = localLeases(local.leases)?.readSync(leaseChild.leaseId);
  const child = lease?.children.find((value) => value.key === leaseChild.childKey);
  const proof = await verifyControlEffectSettlement(installation, execution);
  if (
    lease &&
    (!child ||
      !settledKnown(child) ||
      !sameExecution(child.execution, execution) ||
      canonicalJson(child.settlement) !== canonicalJson(proof))
  )
    throw Error("Terminal child settlement is not proved");
}

export async function restoreConfigurationMaintenancePhaseIssuer(
  owner: ExecutionHandle,
  phase:
    | "configuration-commit"
    | "maintenance-hardlinks"
    | "maintenance-recreate"
    | "maintenance-handoff",
): Promise<ArtifactTargetLease> {
  if (owner.kind !== "configurationMaintenance.prepare")
    throw Error("Original authorized maintenance phase issuer required");
  const lease = restoreArtifactTargetLeaseForSettlement(owner),
    s = stateOf(lease);
  try {
    await assertControlDelegationForward(owner, phase);
    if (current(s)?.state !== "held" || !owner.reservations.some((value) => value.phase === phase))
      throw Error("Original frozen maintenance root is fenced");
    s.settlementOnly = false;
    return lease;
  } catch (error) {
    closeArtifactTargetLeaseHandle(lease);
    throw error;
  }
}

const dispatchBrand = Symbol("fresh-control-child-dispatch");
export type FreshControlChildDispatch = Readonly<{ [dispatchBrand]: true }>;
const tickets = new WeakMap<
  FreshControlChildDispatch,
  {
    used: boolean;
    authority: ExecutionHandle;
    phase: ControlChildPhase;
    deadlineAt: number;
  }
>();
export async function issueControlChildPhase(
  authority: ExecutionHandle,
  input: {
    phase: ControlChildPhase;
    ordinal: number;
    /** A fixed CLI child's key, chosen with its spawn record. */
    childKey?: string;
    lease?: TargetLeaseAuthority;
  },
) {
  const child = await lookupControlChildPhase(authority, input);
  if (!child) throw Error("Child phase is not bound");
  const before = await inspectControlChildPublication(authority, input);
  if (before.publication.state !== "unissued") throw Error("Attempted child requires observation");
  if (
    input.lease &&
    controlDigest(input.lease.mode === "owner" ? input.lease.owner : input.lease.execution) !==
      controlDigest(authority.execution)
  )
    throw Error("Foreign phase target authority");
  const delegation = input.lease
    ? await delegateArtifactTargetLease(input.lease, {
        ...child,
        ...(input.childKey ? { childKey: input.childKey } : {}),
        // What the child acts on, as its cell recorded it before the binding.
        ...(before.evidence ? { evidence: before.evidence } : {}),
      })
    : await attestParentExecution(authority, {
        ...child,
        ...(input.childKey ? { childKey: input.childKey } : {}),
      });
  const saved = await inspectControlChildPublication(authority, input);
  if (saved.publication.state !== "grant_prepared")
    throw Error("Child publication was not retained");
  const dispatchTicket = Object.freeze({ [dispatchBrand]: true as const });
  tickets.set(dispatchTicket, {
    used: false,
    authority,
    phase: input.phase,
    deadlineAt: child.execution.deadlineAt,
  });
  return {
    channel: input.lease ? ("delegation" as const) : ("parent" as const),
    delegation,
    dispatchTicket,
  };
}
export async function consumeControlChildDispatch(
  ticket: FreshControlChildDispatch,
): Promise<void> {
  const saved = tickets.get(ticket);
  if (!saved || saved.used) throw Error("Missing or consumed child dispatch ticket");
  saved.used = true;
  await assertControlDelegationForward(saved.authority, saved.phase);
  if (Date.now() >= saved.deadlineAt) throw Error("Child dispatch deadline elapsed");
}
