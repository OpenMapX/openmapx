import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { configurationApplyResultSchema, opsOperationSchema } from "../ops/contract";
import {
  type ExecutionRef,
  executionRefSchema,
  type VerifiedParentExecution,
} from "../ops/execution-identity";
import { opsOperationFingerprint } from "../ops/fingerprint";
import { verifiedParentOrigins, verifiedParents } from "../ops/verified-parent-internal";
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
  assertControlExecutionForward,
  type ChildSettlement,
  type ControlChildPhase,
  type ControlRecipient,
  childPhaseKinds,
  childSettlementState,
  configurationMaintenanceChildState,
  controlPeerState,
  encodeControlAssertion,
  executionAuthorityState,
  fixedControlChildId,
  type InstallationState,
  inspectConfigurationPreEffectRefusal,
  installationState,
  parseControlAssertion,
  readCompletedConfigurationHandoff,
  readDataControlTerminalObservation,
  readPrivateRecord,
  recordDataControlTerminalObservation,
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
  verifyDataUpdatePrerequisites,
  withControlDelegationPublication,
  withControlMaintenanceDecisionPublication,
  withControlMaintenanceInitialization,
  withPrivateEffectWriter,
  writePrivateRecord,
} from "./control-authority";
// biome-ignore-end lint/suspicious/noImportCycles: Live protocol dependency described above.
import { controlChildOperationKey } from "./control-child-records";
import { controlDigest, targetSchema, uuid, verifyControl } from "./control-records";
import { assertFixedConfigurationMaintenancePlan } from "./fixed-configuration-maintenance";
import {
  admitLease,
  knownSettlement,
  type LeaseChild,
  type LeaseRecord,
  type LeaseSettlement,
  type LeaseStore,
  leaseChildrenOf,
  leaseNodeForward,
  sameExecution,
  TargetBusyError,
} from "./lease-store";

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

/**
 * Where a role keeps its leases. The agent, its fixed CLI children and its
 * configuration helper use the store directly; data-manager and the host CLI
 * ask the agent, which applies the same rules on their behalf.
 */
export interface LeaseBackend {
  acquire(input: {
    owner: ExecutionRef;
    ownerKind: string;
    targets: readonly string[];
  }): Promise<LeaseRecord>;
  read(leaseId: string): Promise<LeaseRecord | undefined>;
  /** Only the store itself can answer without waiting. */
  readSync?(leaseId: string): LeaseRecord | undefined;
  listSync?(): LeaseRecord[];
  list(): Promise<LeaseRecord[]>;
  delegate(input: {
    leaseId: string;
    child: Omit<LeaseChild, "state" | "adopted" | "settlement">;
  }): Promise<LeaseRecord>;
  adopt(input: { leaseId: string; key: string; execution: ExecutionRef }): Promise<LeaseRecord>;
  settle(input: {
    leaseId: string;
    key: string | null;
    settlement: LeaseSettlement;
  }): Promise<LeaseRecord>;
  cancel(input: { leaseId: string; key: string | null }): Promise<LeaseRecord | undefined>;
  release(input: { leaseId: string }): Promise<void>;
}

const MAX_DESCENDANTS = 64;
function nodeOf(lease: LeaseRecord, key: string | null) {
  if (key === null) return lease;
  const child = lease.children.find((entry) => entry.key === key);
  if (!child) throw Error("Missing retained child node");
  return child;
}
function descendantsOf(lease: LeaseRecord, key: string | null): LeaseChild[] {
  if (key === null) return lease.children;
  const result: LeaseChild[] = [];
  for (const child of lease.children) {
    let parent = child.parentKey;
    while (parent !== null) {
      if (parent === key) {
        result.push(child);
        break;
      }
      parent = lease.children.find((entry) => entry.key === parent)?.parentKey ?? null;
    }
  }
  return result;
}
function settledKnown(node: { state: string; settlement?: LeaseSettlement }): boolean {
  return node.state === "settled" && knownSettlement(node.settlement);
}

/** The lease rules, applied under the store lock by every writer. */
export const leaseRules = {
  acquire(leases: LeaseRecord[], input: Parameters<LeaseBackend["acquire"]>[0], now: number) {
    const existing = leases.find((lease) => sameExecution(lease.owner, input.owner));
    if (existing) {
      if (
        existing.ownerKind !== input.ownerKind ||
        canonicalJson(existing.targets) !== canonicalJson([...input.targets].sort())
      )
        throw Error("Execution already acquired a different root lease");
      return existing;
    }
    if (now >= input.owner.deadlineAt) throw Error("Target closure or execution deadline mismatch");
    return admitLease(leases, { ...input, now });
  },
  delegate(leases: LeaseRecord[], input: Parameters<LeaseBackend["delegate"]>[0], now: number) {
    const lease = leases.find((value) => value.leaseId === input.leaseId);
    if (!lease) throw Error("Target lease is not held");
    const existing = lease.children.find((child) => child.key === input.child.key);
    if (existing) {
      if (!sameExecution(existing.execution, input.child.execution))
        throw Error("Attempted child cannot be replayed");
      return lease;
    }
    if (
      !leaseNodeForward(lease, input.child.parentKey, now) ||
      now >= input.child.execution.deadlineAt
    )
      throw Error("Lease does not permit forward delegation");
    if (lease.children.length >= MAX_DESCENDANTS) throw Error("Child intent capacity exhausted");
    if (
      lease.children.some(
        (child) => child.execution.operationKey === input.child.execution.operationKey,
      )
    )
      throw Error("Attempted child cannot be replayed");
    const parent =
      input.child.parentKey === null ? undefined : nodeOf(lease, input.child.parentKey);
    const scope = parent && "targets" in parent ? parent.targets : lease.targets;
    if (input.child.targets.some((id) => !scope.includes(id))) throw Error("Widened target subset");
    if (
      parent &&
      "permittedFurtherEdges" in parent &&
      (!parent.permittedFurtherEdges.includes(input.child.phase) || parent.depth >= 2)
    )
      throw Error("Unauthorized descendant edge");
    lease.children.push({ ...input.child, adopted: false, state: "held" });
    return lease;
  },
  adopt(leases: LeaseRecord[], input: Parameters<LeaseBackend["adopt"]>[0], now: number) {
    const lease = leases.find((value) => value.leaseId === input.leaseId);
    const child = lease?.children.find((value) => value.key === input.key);
    if (!lease || !child || !sameExecution(child.execution, input.execution))
      throw Error("Wrong peer principal, kind, key, fingerprint, or subset");
    if (!child.adopted) {
      if (!leaseNodeForward(lease, child.parentKey, now) || now >= child.execution.deadlineAt)
        throw Error("Stale or canceled delegation");
      child.adopted = true;
    }
    return lease;
  },
  settle(leases: LeaseRecord[], input: Parameters<LeaseBackend["settle"]>[0]) {
    const lease = leases.find((value) => value.leaseId === input.leaseId);
    if (!lease) throw Error("Target lease is not held");
    const node = nodeOf(lease, input.key);
    if (
      !sameExecution(input.settlement.identity, "execution" in node ? node.execution : lease.owner)
    )
      throw Error("Foreign settlement identity");
    for (const child of leaseChildrenOf(lease, input.key))
      if (!settledKnown(child)) throw Error("Unsettled attempted child retains target fence");
    if (node.state === "settled") {
      if (canonicalJson(node.settlement) !== canonicalJson(input.settlement))
        throw Error("Original settlement changed");
      return lease;
    }
    node.settlement = input.settlement;
    node.state = knownSettlement(input.settlement) ? "settled" : "recovery_required";
    return lease;
  },
  cancel(leases: LeaseRecord[], input: Parameters<LeaseBackend["cancel"]>[0]) {
    const lease = leases.find((value) => value.leaseId === input.leaseId);
    if (!lease) return undefined;
    const node = nodeOf(lease, input.key);
    if (node.state === "held") node.state = "cancel_pending";
    return lease;
  },
  release(leases: LeaseRecord[], input: Parameters<LeaseBackend["release"]>[0]) {
    const index = leases.findIndex((value) => value.leaseId === input.leaseId);
    const lease = leases[index];
    if (!lease) return;
    if (!settledKnown(lease)) throw Error("Durable own-effect settlement is required");
    if (lease.children.some((child) => !settledKnown(child)))
      throw Error("Every attempted descendant must settle");
    leases.splice(index, 1);
  },
};

/** The agent's own lease backend over its store. */
export function localLeaseBackend(store: LeaseStore, now: () => number = Date.now): LeaseBackend {
  const get = (leaseId: string) => store.get(leaseId);
  return {
    acquire: (input) => store.update((leases) => leaseRules.acquire(leases, input, now())),
    read: async (leaseId) => get(leaseId),
    readSync: get,
    listSync: () => store.list(),
    list: async () => store.list(),
    delegate: (input) => store.update((leases) => leaseRules.delegate(leases, input, now())),
    adopt: (input) => store.update((leases) => leaseRules.adopt(leases, input, now())),
    settle: (input) => store.update((leases) => leaseRules.settle(leases, input)),
    cancel: (input) => store.update((leases) => leaseRules.cancel(leases, input)),
    release: (input) => store.update((leases) => leaseRules.release(leases, input)),
  };
}

interface State {
  backend: LeaseBackend;
  installation: InstallationState;
  leaseId: string;
  node: string | null;
  owner: ExecutionRef;
  execution: ExecutionRef;
  serviceIds: readonly string[];
  authority?: VerifiedExecutionAuthority;
  settlementOnly?: boolean;
  /** A remote lease is only read when asked; this remembers what was last seen. */
  seen?: LeaseRecord;
  canceled?: boolean;
}
const handles = new WeakMap<object, State>();
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
  if (s.backend.readSync) {
    const record = s.backend.readSync(s.leaseId);
    s.seen = record;
    return record;
  }
  return s.seen;
}
async function fresh(s: State): Promise<LeaseRecord | undefined> {
  s.seen = await s.backend.read(s.leaseId);
  return s.seen;
}
function remember(s: State, record: LeaseRecord | undefined) {
  s.seen = record;
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

export async function acquireArtifactTargetLease(options: {
  serviceIds: readonly string[];
  owner: VerifiedExecutionAuthority;
  signal?: AbortSignal;
}): Promise<ArtifactTargetLease> {
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
  const name = `${authority.execution.operationKey}.json`;
  try {
    readPrivateRecord(authority.installation, "execution-leases", name);
    throw Error("Execution already acquired a root lease; reconcile its original identity");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // A holder that is finishing gets five seconds to release, within the deadline.
  const until = Math.min(Date.now() + 5000, authority.execution.deadlineAt);
  let record: LeaseRecord;
  for (;;) {
    try {
      record = await authority.installation.leases.acquire({
        owner: authority.execution,
        ownerKind: authority.kind,
        targets: serviceIds,
      });
      break;
    } catch (error) {
      if (!(error instanceof TargetBusyError) || Date.now() >= until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
      options.signal?.throwIfAborted();
    }
  }
  // The lease is recorded before this owner's private reference to it, so an
  // owner that dies in between leaves a held lease that is still visible.
  writePrivateRecord(
    authority.installation,
    "execution-leases",
    name,
    { leaseId: record.leaseId },
    true,
  );
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
    childPublicKey: string;
    evidence?: Record<string, unknown>;
  },
): Promise<ArtifactDelegationAssertion> {
  const s = stateOf(lease);
  if (s.settlementOnly) throw Error("Recovered lease permits settlement only");
  const authority = s.authority;
  if (!authority) throw Error("A durable local execution must own child grant publication");
  const owner = executionAuthorityState(authority);
  const record = await fresh(s);
  if (!record) throw Error("Target lease is not held");
  if (!leaseNodeForward(record, s.node, Date.now()) || Date.now() >= s.execution.deadlineAt)
    throw Error("Lease does not permit forward delegation");
  let plan = resolveControlChildPlan(authority, child);
  if (plan && canonicalJson(plan.serviceIds) !== canonicalJson(child.serviceIds))
    throw Error("Reserved child target subset changed");
  const parent = s.node === null ? undefined : record.children.find((c) => c.key === s.node);
  if (!plan && parent) {
    const kinds = childPhaseKinds[child.phase];
    if (
      parent.permittedFurtherEdges.includes(child.phase) &&
      kinds.length === 1 &&
      child.execution.operationKey ===
        controlChildOperationKey(s.execution.operationKey, child.phase, 0)
    )
      plan = { ...child, kind: kinds[0] as string, ordinal: 0 };
  }
  if (!plan) throw Error("Child is absent from immutable admitted plan");
  if (child.serviceIds.some((id) => !lease.serviceIds.includes(id)))
    throw Error("Widened target subset");
  if (parent && (!parent.permittedFurtherEdges.includes(child.phase) || parent.depth >= 2))
    throw Error("Unauthorized descendant edge");
  const edges = verifyFiniteControlEdge(
    parent?.recipient ?? owner.installation.installation.role,
    owner.kind,
    child.phase,
    child.recipient,
  );
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
  const delegationId =
    child.recipient === "fixed-cli" || child.recipient === "configuration-helper"
      ? fixedControlChildId(owner.installation, child.childPublicKey, s.execution)
      : randomUUID();
  const row = {
    key: delegationId,
    parentKey: s.node,
    parent: s.execution,
    execution: child.execution,
    kind: plan.kind,
    phase: child.phase,
    recipient: child.recipient,
    targets: [...child.serviceIds],
    permittedFurtherEdges: edges,
    depth: (parent?.depth ?? 0) + 1,
  };
  // What the child acts on stays in the store row, out of the header; a
  // recipient that needs it reads the store.
  const grantDigest = controlDigest(row);
  const assertion = encodeControlAssertion({
    installationId: owner.installation.installation.installationId,
    leaseId: s.leaseId,
    delegationId,
    owner: s.owner,
    origin: owner.origin,
    grant: row,
  });
  // The private outbox is written before the store row: a child is attempted
  // only once both say so, and recovery reads the outbox first.
  withControlDelegationPublication(authority, child.phase, () => {
    prepareControlChildPublication(authority, plan, {
      delegationId,
      grantDigest,
      leaseId: s.leaseId,
    });
    recordLeaseControlAttempt(authority, {
      child: child.execution,
      leaseId: s.leaseId,
      delegationId,
      grantDigest,
    });
    writePrivateRecord(
      owner.installation,
      "attempts",
      `${delegationId}.json`,
      { grant: row, assertion },
      true,
    );
  });
  remember(
    s,
    await s.backend.delegate({
      leaseId: s.leaseId,
      child: { ...row, ...(child.evidence ? { evidence: child.evidence } : {}) },
    }),
  );
  return assertion;
}

/** Verification-only preview for receivers that can read the store. No adoption or effect authority. */
export function inspectArtifactDelegation(options: {
  assertion: string;
  installation: import("./control-authority").ControlInstallation;
}) {
  const parsed = parseControlAssertion(options.assertion);
  const local = installationState(options.installation);
  if (!local.leases.readSync) throw Error("This role cannot read delegations");
  const lease = local.leases.readSync(parsed.leaseId),
    grant = lease?.children.find((child) => child.key === parsed.delegationId);
  if (!lease || !grant) throw Error("Unanchored delegation");
  const {
    state: _state,
    adopted: _adopted,
    settlement: _settlement,
    evidence: _evidence,
    ...row
  } = grant;
  if (controlDigest(row) !== parsed.grantDigest) throw Error("Grant digest mismatch");
  return Object.freeze({
    leaseId: parsed.leaseId,
    owner: lease.owner,
    parent: grant.parent,
    execution: grant.execution,
    kind: grant.kind,
    serviceIds: Object.freeze([...grant.targets]),
    recipient: grant.recipient,
    phase: grant.phase,
    delegationId: grant.key,
    retained: grant.adopted,
  });
}

/** The parent that issued a delegation, for a recipient that reads the store. */
export function verifiedParentForArtifactDelegation(
  installation: import("./control-authority").ControlInstallation,
  assertion: string,
  execution: ExecutionRef,
): VerifiedParentExecution {
  const inspected = inspectArtifactDelegation({ assertion, installation });
  if (!sameExecution(inspected.execution, execution)) throw Error("Wrong delegated execution");
  const parent = Object.freeze(retainedControlParent(inspected.parent)) as VerifiedParentExecution;
  verifiedParents.add(parent);
  verifiedParentOrigins.set(parent, parseControlAssertion(assertion).origin);
  return parent;
}
export async function adoptArtifactTargetLease(options: {
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
  const inspected = inspectArtifactDelegation({
    assertion: options.assertion,
    installation: peer.installation.installation,
  });
  const lease = peer.installation.leases.readSync?.(assertion.leaseId);
  if (!lease) throw Error("Unanchored delegation");
  if (
    !sameExecution(inspected.execution, options.execution) ||
    inspected.kind !== peer.kind ||
    inspected.recipient !== peer.recipient ||
    canonicalJson(inspected.serviceIds) !== canonicalJson(targetSchema.parse(options.serviceIds))
  )
    throw Error("Wrong peer principal, kind, key, fingerprint, or subset");
  const parent = lease.children.find((child) => child.key === inspected.delegationId)?.parentKey;
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
  const name = `${inspected.delegationId}.json`;
  const pending = {
    version: 2,
    grantDigest: assertion.grantDigest,
    execution: inspected.execution,
    state: "pending-adoption",
    assertion: options.assertion,
  };
  let local: unknown;
  try {
    local = readPrivateRecord(peer.installation, "adoptions", name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (local) {
    const old = z.object({ grantDigest: z.string(), execution: executionRefSchema }).parse(local);
    if (
      old.grantDigest !== assertion.grantDigest ||
      !sameExecution(old.execution, inspected.execution)
    )
      throw Error("Durable duplicate admission conflict");
  } else writePrivateRecord(peer.installation, "adoptions", name, pending, true);
  const adopted = await peer.installation.leases.adopt({
    leaseId: assertion.leaseId,
    key: inspected.delegationId,
    execution: inspected.execution,
  });
  writePrivateRecord(peer.installation, "adoptions", name, { ...pending, state: "ready" }, false);
  return handleFor({
    backend: peer.installation.leases,
    installation: peer.installation,
    leaseId: assertion.leaseId,
    node: inspected.delegationId,
    owner: adopted.owner,
    execution: inspected.execution,
    serviceIds: inspected.serviceIds,
    seen: adopted,
  }) as BorrowedArtifactTargetLease;
}

/** A fixed receiver supplies its own durable execution authority only after adoption. */
export function bindBorrowedControlExecution(
  lease: BorrowedArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
): void {
  const s = stateOf(lease),
    a = executionAuthorityState(authority);
  if (!sameExecution(a.execution, lease.execution))
    throw Error("Borrower execution authority mismatch");
  s.authority = authority;
}

export async function settleArtifactTargetLeaseChild(
  lease: TargetLeaseAuthority,
  evidence: VerifiedChildSettlement,
): Promise<void> {
  const s = stateOf(lease);
  const proof = childSettlementState(evidence);
  if (!sameExecution(proof.evidence.identity, s.execution))
    throw Error("Foreign settlement identity");
  if (s.node === null && s.authority) {
    const owner = executionAuthorityState(s.authority);
    if (owner.kind === "configurationMaintenance.prepare")
      assertConfigurationMaintenanceRootClosure(s.authority, await observeClosure(s, s.authority));
  }
  remember(
    s,
    await s.backend.settle({ leaseId: s.leaseId, key: s.node, settlement: proof.evidence }),
  );
}

export async function releaseArtifactTargetLease(lease: ArtifactTargetLease): Promise<void> {
  const s = stateOf(lease);
  if (s.node !== null) throw Error("Borrower cannot release root");
  if (
    s.authority &&
    executionAuthorityState(s.authority).kind === "configurationMaintenance.prepare"
  )
    assertConfigurationMaintenanceRootClosure(s.authority, await observeClosure(s, s.authority));
  await s.backend.release({ leaseId: s.leaseId });
  remember(s, undefined);
  if (s.authority) rootReleasedAt(s.authority);
}

export async function cancelArtifactTargetLease(
  lease: TargetLeaseAuthority,
): Promise<readonly ExecutionRef[]> {
  const s = stateOf(lease);
  s.canceled = true;
  const record = await s.backend.cancel({ leaseId: s.leaseId, key: s.node });
  remember(s, record);
  // These immutable attempted identities are the adapter's cancellation outbox.
  return Object.freeze(
    (record ? descendantsOf(record, s.node) : []).map((child) =>
      Object.freeze({ ...child.execution }),
    ),
  );
}

/** Observation/adoption of an old identity is not permission to start another forward effect. */
export function assertArtifactTargetLeaseForward(lease: TargetLeaseAuthority): void {
  const s = stateOf(lease);
  if (s.settlementOnly || s.canceled) throw Error("Recovered lease permits settlement only");
  if (s.authority) assertControlExecutionForward(s.authority);
  const record = current(s);
  if (
    !record ||
    !leaseNodeForward(record, s.node, Date.now()) ||
    Date.now() >= s.execution.deadlineAt
  )
    throw Error("Target lease permits observation/settlement only");
}
export function assertArtifactTargetLeaseExecution(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
): void {
  if (!sameExecution(stateOf(lease).execution, execution))
    throw Error("Lifecycle lease execution mismatch");
  assertArtifactTargetLeaseForward(lease);
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
  if (!handles.delete(lease)) throw Error("Unverified target lease handle");
}

const executionLeaseSchema = z.strictObject({
  leaseId: uuid,
  releasedAt: z.number().int().positive().safe().optional(),
});
function executionLease(authority: VerifiedExecutionAuthority) {
  const a = executionAuthorityState(authority);
  return executionLeaseSchema.parse(
    readPrivateRecord(a.installation, "execution-leases", `${a.execution.operationKey}.json`),
  );
}
function executionLeaseId(authority: VerifiedExecutionAuthority): string {
  return executionLease(authority).leaseId;
}
/** The time the owner first saw its root released, recorded once in its own state. */
function rootReleasedAt(authority: VerifiedExecutionAuthority): number {
  const a = executionAuthorityState(authority),
    saved = executionLease(authority);
  if (saved.releasedAt) return saved.releasedAt;
  const releasedAt = Date.now();
  writePrivateRecord(
    a.installation,
    "execution-leases",
    `${a.execution.operationKey}.json`,
    { leaseId: saved.leaseId, releasedAt },
    false,
  );
  return releasedAt;
}
/** Reopen the original owned lease for cancellation and settlement only. */
export function restoreArtifactTargetLeaseForSettlement(
  authority: VerifiedExecutionAuthority,
): ArtifactTargetLease {
  const a = executionAuthorityState(authority);
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
/** Whether the execution's own root lease is gone from the store, after its own effect settled. */
export async function verifyRetainedArtifactTargetRootRelease(
  authority: VerifiedExecutionAuthority,
): Promise<Readonly<{ releasedAt: number }>> {
  const a = executionAuthorityState(authority);
  const leaseId = executionLeaseId(authority);
  childSettlementState(verifyControlEffectSettlement(a.installation.installation, a.execution));
  if (await a.installation.leases.read(leaseId)) throw Error("Original root release is not proved");
  return Object.freeze({ releasedAt: rootReleasedAt(authority) });
}
/**
 * The same without waiting: from the release this owner recorded after the
 * store dropped its lease, or from the store for a role that reads it.
 */
export function verifyLocalArtifactTargetRootRelease(
  authority: VerifiedExecutionAuthority,
): Readonly<{ releasedAt: number }> {
  const a = executionAuthorityState(authority);
  const leaseId = executionLeaseId(authority);
  childSettlementState(verifyControlEffectSettlement(a.installation.installation, a.execution));
  const recorded = executionLease(authority).releasedAt;
  if (recorded) return Object.freeze({ releasedAt: recorded });
  if (!a.installation.leases.readSync) throw Error("This role cannot read the lease store");
  if (a.installation.leases.readSync(leaseId)) throw Error("Original root release is not proved");
  return Object.freeze({ releasedAt: rootReleasedAt(authority) });
}

/** Settles the owner from recovery evidence and releases it when every child is known. */
export async function reconcileArtifactTargetLease(options: {
  leaseId: string;
  authority: VerifiedRecoveryAuthority;
}): Promise<"released" | "fenced"> {
  const recovery = recoveryAuthorityState(options.authority);
  const backend = recovery.authority.installation.leases;
  const lease = await backend.read(options.leaseId);
  if (!lease) return "released";
  if (!sameExecution(lease.owner, recovery.authority.execution))
    throw Error("Foreign recovery execution");
  if (!knownSettlement(recovery.evidence) || lease.children.some((child) => !settledKnown(child)))
    return "fenced";
  if (recovery.authority.kind === "configurationMaintenance.prepare") {
    const verified = restoreAdmittedControlExecution(
      recovery.authority.installation.installation,
      recovery.authority.execution,
    );
    assertConfigurationMaintenanceRootClosure(verified, closureFromRecord(lease, verified));
  }
  if (lease.state !== "settled")
    await backend.settle({ leaseId: lease.leaseId, key: null, settlement: recovery.evidence });
  await backend.release({ leaseId: lease.leaseId });
  rootReleasedAt(
    restoreAdmittedControlExecution(
      recovery.authority.installation.installation,
      recovery.authority.execution,
    ),
  );
  return "released";
}
/** Finish only this original unused root. No acquisition, forward authority, new clock or caller ID. */
export async function reconcileConfigurationPreEffectRoot(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  inspectConfigurationPreEffectRefusal(authority);
  const state = executionAuthorityState(authority);
  let leaseId: string;
  try {
    leaseId = executionLeaseId(authority);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && state.kind === "service.pull") return;
    throw error;
  }
  if (state.kind === "service.pull")
    throw Error("Normal coordinator pull cannot own a target lease");
  if (
    (await reconcileArtifactTargetLease({
      leaseId,
      authority: verifyControlRecoveryAuthority(authority),
    })) !== "released"
  )
    throw Error("Original pre-effect root remains fenced");
}

/** Image pulls hold no lease, but never run while their target is held. */
export function assertCoordinatorPullLeaseCompatibility(
  authority: VerifiedExecutionAuthority,
): void {
  assertImagePullTargetFree(authority, "service.pull");
}
export function assertImageStageLeaseCompatibility(authority: VerifiedExecutionAuthority): void {
  assertImagePullTargetFree(authority, "service.image.stage");
}
function assertImagePullTargetFree(
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
      "openmapx-control-execution-v2",
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
    state.installation.fixedChildId ||
    state.kind !== kind ||
    controlDigest(raw) !== state.receiptDigest ||
    !sameExecution(admitted.execution, state.execution) ||
    admitted.operation.kind !== kind ||
    !("serviceId" in admitted.operation) ||
    (admitted.operation.kind === "service.pull" &&
      (admitted.operation.serviceId !== "data-manager" || !admitted.operation.candidateId)) ||
    opsOperationFingerprint(admitted.operation) !== state.execution.operationFingerprint
  )
    throw Error("Actual normal coordinator pull required");
  const target = admitted.operation.serviceId;
  if (!state.installation.registeredTargets.has(target))
    throw Error("Registered image target required");
  const list = state.installation.leases.listSync;
  if (!list) throw Error("Image pulls run in the agent");
  for (const lease of list())
    if (lease.targets.includes(target)) throw Error("Coordinator target is held");
}

/** Complete only the original terminal handoff preparer after its helper has committed and settled. */
export async function settlePreparedConfigurationHandoff(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configurationHandoff.prepare" ||
    owner.installation.fixedChildId ||
    owner.installation.installation.role !== "ops-agent"
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
  );
  const lease = await owner.installation.leases.read(source.intent.leaseId);
  if (!lease) throw Error("Original prepared helper tree changed");
  const parent = lease.children.filter((child) => sameExecution(child.execution, owner.execution)),
    helper = lease.children.find((child) => child.key === source.intent.delegationId);
  if (
    parent.length !== 1 ||
    !sameExecution(source.intent.preparer, owner.execution) ||
    canonicalJson(source.intent.operation) !== canonicalJson(operation) ||
    source.intent.preparerAdmissionDigest !== owner.receiptDigest ||
    !sameExecution(source.intent.ownerPrepare, lease.owner) ||
    helper?.parentKey !== parent[0]!.key ||
    helper.recipient !== "configuration-helper" ||
    helper.phase !== "configuration-handoff" ||
    helper.kind !== "configuration-helper" ||
    !sameExecution(helper.execution, source.intent.helper) ||
    helper.state !== "settled" ||
    canonicalJson(helper.settlement) !== canonicalJson(source.settlement)
  )
    throw Error("Original prepared helper tree changed");
  verifyControlPreparedTerminal(owner.installation, owner.execution);
  const proof = childSettlementState(
    verifyControlEffectSettlement(owner.installation.installation, owner.execution),
  ).evidence;
  if (proof.outcome !== "committed" || proof.publication !== "committed")
    throw Error("Original prepared handoff effect required");
  const prior = parent[0]!;
  if (prior.state === "settled") {
    if (canonicalJson(prior.settlement) !== canonicalJson(proof))
      throw Error("Original handoff settlement changed");
    return;
  }
  await owner.installation.leases.settle({
    leaseId: lease.leaseId,
    key: prior.key,
    settlement: proof,
  });
}
/** Receipt-only settlement of the original completed helper. */
export async function settleRetainedConfigurationHandoffHelper(
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "configuration-helper" || !owner.installation.fixedChildId)
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
    adoption = z
      .object({
        state: z.literal("ready"),
        execution: executionRefSchema,
        assertion: z.string(),
        grantDigest: z.string(),
      })
      .parse(
        readPrivateRecord(
          owner.installation,
          "adoptions",
          `${source.intent.delegationId}.json`,
          8192,
        ),
      ),
    assertion = parseControlAssertion(adoption.assertion);
  if (
    !sameExecution(source.intent.helper, owner.execution) ||
    source.intent.delegationId !== owner.installation.fixedChildId ||
    adoption.assertion !== source.intent.assertion ||
    !sameExecution(adoption.execution, owner.execution) ||
    assertion.leaseId !== source.intent.leaseId ||
    assertion.delegationId !== source.intent.delegationId
  )
    throw Error("Original helper ready adoption changed");
  const lease = await owner.installation.leases.read(source.intent.leaseId),
    child = lease?.children.find((value) => value.key === source.intent.delegationId);
  if (
    !lease ||
    !child ||
    child.recipient !== "configuration-helper" ||
    child.kind !== "configuration-helper" ||
    !sameExecution(child.execution, owner.execution)
  )
    throw Error("Original retained helper tree changed");
  if (child.state === "settled") {
    if (canonicalJson(child.settlement) !== canonicalJson(source.settlement))
      throw Error("Original helper settlement changed");
    return;
  }
  verifyControlPreparedTerminal(owner.installation, source.intent.preparer);
  await owner.installation.leases.settle({
    leaseId: lease.leaseId,
    key: child.key,
    settlement: childSettlementState(
      verifyControlEffectSettlement(owner.installation.installation, owner.execution),
    ).evidence,
  });
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
  if (entries.length !== 1) throw Error("Exact retained child grant required");
  const child = entries[0]!;
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
  if (!s.backend.readSync) throw Error("This role cannot read the lease store");
  return childSettlementOf(current(s), s.node, execution);
}
/**
 * Settles the data-manager child `execution` of this lease node from the
 * terminal status data-manager reported to this role over its authenticated
 * route. Only a terminal status with a known publication settles it.
 */
export async function settleDataManagerLeaseChild(
  lease: TargetLeaseAuthority,
  execution: ExecutionRef,
  status: import("../services/data-manager/contracts/executions").DataExecutionStatus,
): Promise<ChildSettlement | null> {
  const s = stateOf(lease);
  const record = await fresh(s);
  const child = record
    ? leaseChildrenOf(record, s.node).find((value) => sameExecution(value.execution, execution))
    : undefined;
  if (!record || !child) throw Error("Exact retained child grant required");
  if (settledKnown(child)) return child.settlement as ChildSettlement;
  if (
    !["ok", "partial", "error", "canceled", "interrupted"].includes(status.status) ||
    status.publication === "unknown"
  )
    return null;
  const observed = recordDataControlTerminalObservation(
    s.installation.installation,
    execution,
    status,
  );
  return settleIssuedLeaseChild(lease, execution, {
    outcome:
      status.publication === "not_started"
        ? "failed_without_effect"
        : status.status === "ok"
          ? "committed"
          : "contained",
    publication: status.publication,
    terminalReceiptDigest: observed.terminalDigest,
  });
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
  remember(s, await s.backend.settle({ leaseId: s.leaseId, key: child.key, settlement }));
  return settlement;
}
/** The settlement of an original owned child, read through the owner's lease reference. */
export async function inspectRetainedOwnedArtifactTargetChildSettlement(
  authority: VerifiedExecutionAuthority,
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
  authority: VerifiedExecutionAuthority,
): Promise<void> {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "catalog.activate" || owner.installation.installation.role !== "data-manager")
    throw Error("Original catalog activation owner required");
  const lease = await owner.installation.leases.read(executionLeaseId(authority));
  if (lease && lease.children.some((child) => !settledKnown(child)))
    throw Error("Catalog child tree remains unsettled");
}

/** Holder of MOTIS for catalog pins: the agent or the standalone host CLI. */
export function catalogPinTargetOwner(lease: TargetLeaseAuthority) {
  assertArtifactTargetLeaseForward(lease);
  const s = stateOf(lease);
  if (!s.serviceIds.includes("motis"))
    throw Error("MOTIS target authority required for catalog pins");
  if (!["ops-agent", "host-cli"].includes(s.installation.installation.role))
    throw Error("Catalog pins are owned by the agent or standalone host CLI");
  return {
    installation: s.installation.installation,
    execution: s.execution,
    origin: s.authority ? executionAuthorityState(s.authority).origin : undefined,
  };
}

/** A helper can adopt before its preparer exits, but may not drain before terminal preparation. */
export function verifyConfigurationHelperReady(lease: BorrowedArtifactTargetLease): void {
  const s = stateOf(lease);
  const record = current(s);
  const grant = record?.children.find((child) => child.key === s.node);
  if (
    !record ||
    grant?.recipient !== "configuration-helper" ||
    grant.phase !== "configuration-handoff" ||
    !leaseNodeForward(record, s.node, Date.now())
  )
    throw Error("Configuration helper cannot enter drain");
  verifyControlPreparedTerminal(s.installation, grant.parent);
}
/** The delegation's root lease is still held by its owner. Observation only. */
export function assertArtifactDelegationRootHeld(
  installation: import("./control-authority").ControlInstallation,
  assertion: string,
): void {
  const local = installationState(installation),
    parsed = parseControlAssertion(assertion),
    lease = local.leases.readSync?.(parsed.leaseId);
  if (!lease || lease.state === "settled") throw Error("Original owner lease is no longer held");
}
/** Read-only terminal evidence of a borrowed child after the agent restarted. */
export function verifyRetainedArtifactTargetSettlement(
  installation: import("./control-authority").ControlInstallation,
  adoption: import("./control-authority").ControlAdoption,
  execution: ExecutionRef,
): void {
  const local = installationState(installation);
  const lease = local.leases.readSync?.(adoption.leaseId);
  const child = lease?.children.find((value) => value.key === adoption.delegationId);
  const proof = childSettlementState(verifyControlEffectSettlement(installation, execution));
  if (
    lease &&
    (!child ||
      !settledKnown(child) ||
      !sameExecution(child.execution, execution) ||
      canonicalJson(child.settlement) !== canonicalJson(proof.evidence))
  )
    throw Error("Terminal child settlement is not proved");
}

declare const maintenanceClosureBrand: unique symbol;
export type ConfigurationMaintenanceClosureObservation = Readonly<{
  [maintenanceClosureBrand]: true;
}>;
const maintenanceClosureObservations = new WeakMap<
  ConfigurationMaintenanceClosureObservation,
  {
    authority: VerifiedExecutionAuthority;
    leaseId: string;
    children: Array<{ execution: ExecutionRef; settlement: ChildSettlement }>;
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
function closureFromRecord(
  lease: LeaseRecord,
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceClosureObservation {
  const children = lease.children.map((child) => {
    if (!settledKnown(child))
      throw Error("Every original maintenance descendant must be contained");
    return { execution: child.execution, settlement: child.settlement as ChildSettlement };
  });
  const observation = Object.freeze({}) as ConfigurationMaintenanceClosureObservation;
  maintenanceClosureObservations.set(observation, {
    authority,
    leaseId: lease.leaseId,
    children,
  });
  return observation;
}
async function observeClosure(s: State, authority: VerifiedExecutionAuthority) {
  const record = await fresh(s);
  if (!record) throw Error("Original maintenance root is not held");
  return closureFromRecord(record, authority);
}
function maintenanceLease(authority: VerifiedExecutionAuthority): LeaseRecord {
  const owner = executionAuthorityState(authority);
  if (
    owner.kind !== "configurationMaintenance.prepare" ||
    owner.installation.installation.role !== "ops-agent" ||
    owner.installation.fixedChildId
  )
    throw Error("Original maintenance runtime tree required");
  const lease = owner.installation.leases.readSync?.(executionLeaseId(authority));
  if (!lease || !sameExecution(lease.owner, owner.execution))
    throw Error("Original maintenance root is not held");
  return lease;
}
/** Read-only observation of the original maintenance tree; it creates no lease or proof. */
export function observeConfigurationMaintenanceRuntimeTree(
  authority: VerifiedExecutionAuthority,
): ConfigurationMaintenanceClosureObservation {
  return closureFromRecord(maintenanceLease(authority), authority);
}
export function verifyConfigurationMaintenanceRootClosure(
  authority: VerifiedExecutionAuthority,
): void {
  // The store releases a maintenance root only after this check passed, and the
  // owner records the release; the released tree is no longer kept.
  const state = executionAuthorityState(authority);
  if (
    !state.installation.leases.readSync?.(executionLeaseId(authority)) &&
    executionLease(authority).releasedAt
  )
    return;
  const observation = observeConfigurationMaintenanceRuntimeTree(authority);
  try {
    assertConfigurationMaintenanceRootClosure(authority, observation);
  } finally {
    maintenanceClosureObservations.delete(observation);
  }
}
/** Source-only observation of the original held maintenance root. */
export function configurationMaintenanceTargetOwner(lease: ArtifactTargetLease) {
  const s = stateOf(lease);
  const record = current(s);
  const owner = s.authority && executionAuthorityState(s.authority);
  if (
    s.node !== null ||
    !record ||
    !owner ||
    s.installation.installation.role !== "ops-agent" ||
    owner.kind !== "configurationMaintenance.prepare" ||
    record.state === "settled"
  )
    throw Error("Held original maintenance target owner required");
  return Object.freeze({
    installation: s.installation.installation,
    execution: s.execution,
    origin: owner.origin,
    admissionDigest: owner.receiptDigest,
    leaseId: s.leaseId,
    serviceIds: record.targets,
  });
}
function maintenanceOwnerScope(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  message: string,
) {
  const s = stateOf(lease),
    owner = executionAuthorityState(authority);
  if (
    s.node !== null ||
    owner.kind !== "configurationMaintenance.prepare" ||
    !sameExecution(owner.execution, s.execution)
  )
    throw Error(message);
  return { s, owner };
}
export function withConfigurationMaintenanceOwnerInitialization<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const { s, owner } = maintenanceOwnerScope(
    lease,
    authority,
    "Original live maintenance initialization required",
  );
  if (s.authority !== authority || s.settlementOnly)
    throw Error("Original live maintenance initialization required");
  return withControlMaintenanceInitialization(authority, () => withPrivateEffectWriter(owner, run));
}
/** Publication of already proved guard observations remains possible after cancellation. */
export function withConfigurationMaintenanceOwnerObservation<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const { s, owner } = maintenanceOwnerScope(
    lease,
    authority,
    "Original configuration maintenance recovery owner required",
  );
  const record = current(s);
  if (!record || record.state === "settled")
    throw Error("Maintenance observation owner already released");
  return withPrivateEffectWriter(owner, run);
}
export function withConfigurationMaintenanceDecisionPublication<T>(
  lease: ArtifactTargetLease,
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const { s, owner } = maintenanceOwnerScope(
    lease,
    authority,
    "Original maintenance decision owner required",
  );
  if (current(s)?.state !== "held") throw Error("Original prepared maintenance root is fenced");
  return withControlMaintenanceDecisionPublication(authority, () =>
    withPrivateEffectWriter(owner, run),
  );
}
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
  const { s, owner } = maintenanceOwnerScope(
    lease,
    authority,
    "Original frozen maintenance issuer required",
  );
  if (s.settlementOnly || s.authority !== authority)
    throw Error("Original frozen maintenance issuer required");
  return withControlDelegationPublication(authority, phase, () => {
    if (current(s)?.state !== "held") throw Error("Original maintenance phase is fenced");
    return withPrivateEffectWriter(owner, run);
  });
}
export function withConfigurationMaintenanceReservationPublication<T>(
  authority: VerifiedExecutionAuthority,
  run: () => T,
): T {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "configurationMaintenance.prepare")
    throw Error("Original maintenance reservation owner required");
  if (maintenanceLease(authority).state !== "held")
    throw Error("Original pre-effect maintenance root required");
  return withControlDelegationPublication(authority, "configuration-fence", () =>
    withPrivateEffectWriter(owner, run),
  );
}
/** Reopen the prepared owner's already-authorized frozen phase issuer. */
export function restoreConfigurationMaintenancePhaseIssuer(
  authority: VerifiedExecutionAuthority,
  phase:
    | "configuration-commit"
    | "maintenance-hardlinks"
    | "maintenance-recreate"
    | "maintenance-handoff",
): ArtifactTargetLease {
  const owner = executionAuthorityState(authority);
  if (owner.kind !== "configurationMaintenance.prepare")
    throw Error("Original authorized maintenance phase issuer required");
  const lease = restoreArtifactTargetLeaseForSettlement(authority),
    s = stateOf(lease);
  try {
    withControlDelegationPublication(authority, phase, () => {
      if (
        current(s)?.state !== "held" ||
        !owner.reservations.some((value) => value.phase === phase)
      )
        throw Error("Original frozen maintenance root is fenced");
      s.settlementOnly = false;
    });
    return lease;
  } catch (error) {
    closeArtifactTargetLeaseHandle(lease);
    throw error;
  }
}

// Fixed closure and original children consume this module's one tree observation.
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
    tree.leaseId !== owner.leaseId ||
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
      physical = tree.children.find((value) => sameExecution(value.execution, actual.execution));
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
      const terminal = readDataControlTerminalObservation(
          state.installation.installation,
          binding.child.execution,
        ),
        physical = tree.children.find((value) =>
          sameExecution(value.execution, binding.child.execution),
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
          terminalAt: terminal.observedAt,
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
        physical = tree.children.find((value) =>
          sameExecution(value.execution, helper.intent.helper),
        );
      if (
        canonicalJson(helper.intent.operation) !== canonicalJson(step.operation) ||
        !sameExecution(helper.intent.preparer, actual.execution) ||
        helper.intent.leaseId !== owner.leaseId ||
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
/** The original owner's own final and inspection, after the data-manager confirmed the settle. */
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
      owner.leaseId === tree.leaseId &&
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
/** The maintenance root may release once every descendant is contained and either
 * its fence is settled after a final, or no fence was ever prepared. */
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
      owner.leaseId === tree.leaseId &&
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
