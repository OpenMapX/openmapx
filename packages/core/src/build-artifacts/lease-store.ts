import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { opsBusyHolderMessage } from "../ops/contract";
import { type ExecutionRef, executionRefSchema } from "../ops/execution-ref";
import {
  type LeaseChild,
  type LeaseRecord,
  type LeaseSettlement,
  leaseRecordSchema,
  leaseTargetsSchema,
} from "../ops/lease-records";
import { atomicWrite } from "../release-files";
import { assertOwnDirectory } from "../services/configuration-ownership";
import { type ContainerRunning, withRecoverableLock } from "../services/recoverable-lock";

/**
 * Target leases, in the operations agent's own state directory, which no other
 * service mounts. Every writer that changes containers claims its targets here
 * first: the agent for its own operations and on behalf of data-manager, the
 * configuration helper while the agent is replaced, the agent's fixed CLI
 * children, and the host CLI, which writes the file itself.
 *
 * The file is replaced atomically under a recoverable lock, held only for the
 * read and write, never across a Docker effect. A lease names its owner and
 * the children recorded under it before they start. It is released only when
 * the owner and every child have a known outcome; an unknown outcome keeps it
 * until an operator resolves it with `openmapx control`.
 */
export const LEASE_STORE_FILE = "leases.json";
export const LEASE_STORE_LOCK = "leases.lock";
const MAX_LEASES = 256;

export type { LeaseChild, LeaseRecord, LeaseSettlement };

const storeSchema = z.strictObject({
  version: z.literal(1),
  leases: z.array(leaseRecordSchema).max(MAX_LEASES),
});

export class TargetBusyError extends Error {
  constructor(
    readonly target: string,
    readonly holder: Pick<LeaseRecord, "leaseId" | "owner" | "ownerKind" | "state">,
  ) {
    super(
      opsBusyHolderMessage({
        target,
        executor: holder.owner.executor,
        operationKey: holder.owner.operationKey,
        ownerKind: holder.ownerKind,
        state: holder.state,
      }),
    );
  }
}

export function knownSettlement(settlement: LeaseSettlement | undefined): boolean {
  return (
    !!settlement &&
    settlement.outcome !== "unknown" &&
    settlement.publication !== "unknown" &&
    !(settlement.outcome === "failed_without_effect" && settlement.publication !== "not_started")
  );
}

export function sameExecution(a: ExecutionRef, b: ExecutionRef): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export interface LeaseStore {
  readonly directory: string;
  /** Runs `change` on the current leases under the store lock and saves the result. */
  update<T>(change: (leases: LeaseRecord[]) => T): Promise<T>;
  list(): LeaseRecord[];
  get(leaseId: string): LeaseRecord | undefined;
}

function readStore(path: string): LeaseRecord[] {
  let text: string;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw new Error("Unsafe lease store file");
    text = readFileSync(fd, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    if (code === "ELOOP") throw new Error("Unsafe lease store file");
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return storeSchema.parse(JSON.parse(text)).leases;
}

export function openLeaseStore(options: {
  /** The agent's state directory, `infra/docker/state/ops-agent`. */
  directory: string;
  purpose: string;
  containerRunning?: ContainerRunning;
}): LeaseStore {
  const file = join(options.directory, LEASE_STORE_FILE);
  const lock = join(options.directory, LEASE_STORE_LOCK);
  let queue: Promise<unknown> = Promise.resolve();
  return {
    directory: options.directory,
    update<T>(change: (leases: LeaseRecord[]) => T): Promise<T> {
      const run = queue.then(() => {
        mkdirSync(options.directory, { recursive: true, mode: 0o700 });
        // Another user, such as a CLI run with sudo, would leave a store the agent cannot read.
        assertOwnDirectory(options.directory);
        return withRecoverableLock(
          lock,
          { purpose: options.purpose, containerRunning: options.containerRunning },
          () => {
            const leases = readStore(file);
            const before = canonicalJson(leases);
            const result = change(leases);
            if (leases.length > MAX_LEASES) throw new Error("Lease store is full");
            if (canonicalJson(leases) !== before)
              atomicWrite(
                file,
                `${JSON.stringify(storeSchema.parse({ version: 1, leases }), null, 2)}\n`,
              );
            return result;
          },
        );
      });
      queue = run.catch(() => undefined);
      return run;
    },
    list: () => readStore(file),
    get: (leaseId) => readStore(file).find((lease) => lease.leaseId === leaseId),
  };
}

export function leaseStoreDirectory(infraDir: string): string {
  return join(infraDir, "state", "ops-agent");
}

/**
 * Drops a lease whose owner never recorded its attempt, so nothing ran under
 * it. A lease that already has children is left for its owner.
 */
export async function abandonUnstartedLease(
  store: LeaseStore,
  leaseId: string,
  owner: ExecutionRef,
): Promise<void> {
  await store.update((leases) => {
    const index = leases.findIndex((lease) => lease.leaseId === leaseId);
    const lease = leases[index];
    if (lease && sameExecution(lease.owner, owner) && lease.children.length === 0)
      leases.splice(index, 1);
  });
}

/** Whether the owner, or the child `key`, and every ancestor may still begin effects. */
export function leaseNodeForward(lease: LeaseRecord, key: string | null, now: number): boolean {
  if (lease.state !== "held" || now >= lease.owner.deadlineAt) return false;
  while (key !== null) {
    const child = lease.children.find((entry) => entry.key === key);
    if (!child || child.state !== "held" || now >= child.execution.deadlineAt) return false;
    key = child.parentKey;
  }
  return true;
}

/** Children issued directly by the owner (`null`) or by the child `key`. */
export function leaseChildrenOf(lease: LeaseRecord, key: string | null): LeaseChild[] {
  return lease.children.filter((child) => child.parentKey === key);
}

/** The phases a child may run in, the kinds each admits, and the child keys they derive. */
export type ControlRecipient = "fixed-cli" | "data-manager" | "ops-agent" | "configuration-helper";
export type ControlChildPhase =
  | "lifecycle"
  | "build"
  | "data-link"
  | "data-clean"
  | "data-workflow"
  | "data-finalization"
  | "stop-primary"
  | "stop-staging"
  | "restart-staging"
  | "promote-primary"
  | "recover-primary"
  | "proxy-stage"
  | "proxy-commit"
  | "proxy-restore"
  | "paired-pin-commit"
  | "configuration-fence"
  | "configuration-commit"
  | "maintenance-hardlinks"
  | "maintenance-recreate"
  | "maintenance-handoff"
  | "osm"
  | "transit"
  | "fonts"
  | "data-step"
  | "configuration-handoff";
export const childPhaseKinds: Readonly<Record<ControlChildPhase, readonly string[]>> = {
  lifecycle: ["service.start", "service.update"],
  build: ["service.build", "services.buildAll"],
  "data-link": ["data.link", "configuration.hardlinks.apply"],
  "data-clean": ["data.clean"],
  "data-finalization": ["data.update"],
  "data-workflow": [
    "data.update",
    "data.downloadOsm",
    "data.downloadFonts",
    "data.convertOverpass",
    "data.overtureSync",
    "data.overturePull",
    "data.overtureIngest",
    "data.overtureExtract",
    "data.overtureConflate",
    "data.searchIndexBuild",
    "data.notablePlacesBuild",
  ],
  "stop-primary": ["motis.primary.stop"],
  "stop-staging": ["motis.staging.stop"],
  "restart-staging": ["motis.staging.restart"],
  "promote-primary": ["motis.primary.promote"],
  "recover-primary": ["motis.primary.restart"],
  "proxy-stage": ["feedProxy.validateAndReload"],
  "proxy-commit": ["feedProxy.validateAndReload"],
  "proxy-restore": ["feedProxy.validateAndReload"],
  "paired-pin-commit": ["transitousLock.approve"],
  "configuration-fence": ["configuration-maintenance.prepare"],
  "configuration-commit": [
    "stack.render",
    "serviceSelection.apply",
    "serviceConfig.apply",
    "integrationConfig.apply",
    "vault.apply",
  ],
  "maintenance-hardlinks": ["configuration.hardlinks.apply"],
  "maintenance-recreate": ["service.recreate", "service.recreateIsolated"],
  "maintenance-handoff": ["configurationHandoff.prepare"],
  osm: ["download-osm"],
  transit: ["transit-sync"],
  fonts: ["download-fonts"],
  "data-step": [
    "download-osm",
    "download-fonts",
    "convert-overpass",
    "overture-sync",
    "overture-pull",
    "overture-ingest",
    "overture-extract",
    "overture-conflate",
    "search-index-build",
    "notable-places-build",
  ],
  "configuration-handoff": ["configuration-helper"],
};
export function controlChildOperationKey(
  parentKey: string,
  phase: ControlChildPhase,
  ordinal: number,
): string {
  if (
    !/^opk1_[A-Za-z0-9_-]{16,64}$/.test(parentKey) ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    ordinal > 63 ||
    !Object.hasOwn(childPhaseKinds, phase)
  )
    throw Error("Invalid fixed phase key");
  return `opk1_${createHash("sha256").update(`openmapx-control-child-v1\0${parentKey}\0${phase}\0${ordinal}`).digest("base64url").slice(0, 32)}`;
}
export type ControlChildReservation = {
  version: 1;
  phase: ControlChildPhase;
  ordinal: number;
  kind: string;
  recipient: ControlRecipient;
  serviceIds: readonly string[];
  execution: Pick<ExecutionRef, "executor" | "principal" | "executionId" | "operationKey">;
  operationFingerprint: string;
};
const address = z
  .strictObject({
    executor: executionRefSchema.shape.executor,
    principal: executionRefSchema.shape.principal,
    executionId: z.string(),
    operationKey: executionRefSchema.shape.operationKey,
  })
  .refine((v) =>
    v.executor === "ops-agent"
      ? /^job1_[A-Za-z0-9_-]{16,64}$/.test(v.executionId)
      : z.uuid().safeParse(v.executionId).success,
  );
export const controlChildReservationSchema: z.ZodType<ControlChildReservation> = z.lazy(() =>
  z.strictObject({
    version: z.literal(1),
    phase: z.enum(Object.keys(childPhaseKinds) as [ControlChildPhase, ...ControlChildPhase[]]),
    ordinal: z.number().int().min(0).max(63),
    kind: z.string().min(1).max(128),
    recipient: z.enum(["fixed-cli", "data-manager", "ops-agent", "configuration-helper"]),
    serviceIds: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .min(1)
      .max(256)
      .refine((a) => a.every((v, i) => i === 0 || (a[i - 1] ?? v) < v)),
    execution: address,
    operationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
);

/**
 * The lease calls every role makes. The agent, its fixed CLI children, its
 * configuration helper and the host CLI use the store directly; data-manager
 * asks the agent, which applies the same rules on its behalf.
 */
export interface LeaseBackend {
  acquire(input: {
    owner: ExecutionRef;
    ownerKind: string;
    targets: readonly string[];
  }): Promise<LeaseRecord>;
  read(leaseId: string): Promise<LeaseRecord | undefined>;
  delegate(input: {
    leaseId: string;
    child: Omit<LeaseChild, "state" | "adopted" | "settlement">;
  }): Promise<LeaseRecord>;
  settle(input: {
    leaseId: string;
    key: string | null;
    settlement: LeaseSettlement;
  }): Promise<LeaseRecord>;
  cancel(input: { leaseId: string; key: string | null }): Promise<LeaseRecord | undefined>;
  release(input: { leaseId: string }): Promise<void>;
}
/** A role that reads the store itself also reads it without waiting and adopts children. */
export interface LocalLeaseBackend extends LeaseBackend {
  readSync(leaseId: string): LeaseRecord | undefined;
  listSync(): LeaseRecord[];
  adopt(input: { leaseId: string; key: string; execution: ExecutionRef }): Promise<LeaseRecord>;
}
/** The store-reading backend of a local role, or undefined for data-manager. */
export function localLeases(backend: LeaseBackend): LocalLeaseBackend | undefined {
  return "readSync" in backend ? (backend as LocalLeaseBackend) : undefined;
}
export function requireLocalLeases(backend: LeaseBackend): LocalLeaseBackend {
  const local = localLeases(backend);
  if (!local) throw Error("This role cannot read the lease store");
  return local;
}

const MAX_DESCENDANTS = 64;
function nodeOf(lease: LeaseRecord, key: string | null) {
  if (key === null) return lease;
  const child = lease.children.find((entry) => entry.key === key);
  if (!child) throw Error("Missing retained child node");
  return child;
}
export function descendantsOf(lease: LeaseRecord, key: string | null): LeaseChild[] {
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
export function settledKnown(node: { state: string; settlement?: LeaseSettlement }): boolean {
  return node.state === "settled" && knownSettlement(node.settlement);
}

/** Who issues under `parentKey`, and the kind it runs: that child, or the lease's owner. */
function issuerOf(lease: LeaseRecord, parentKey: string | null) {
  if (parentKey === null)
    return { role: lease.owner.executor, kind: lease.ownerKind, parent: undefined };
  const parent = lease.children.find((entry) => entry.key === parentKey);
  if (!parent) throw Error("Missing retained child node");
  return { role: parent.recipient, kind: parent.kind, parent };
}
/** The phase a child may issue under itself, if any; a grandchild issues none. */
export function furtherEdges(lease: LeaseRecord, child: LeaseChild): string[] {
  if (child.parentKey !== null) return [];
  return verifyFiniteControlEdge(
    lease.owner.executor,
    lease.ownerKind,
    child.phase as ControlChildPhase,
    child.recipient,
  );
}

/**
 * The id of the root lease `owner` holds. It is derived from the owner's key,
 * so the owner finds its lease in the store without a record of its own; one
 * key holds at most one root lease.
 */
export function rootLeaseId(owner: Pick<ExecutionRef, "operationKey">): string {
  const d = createHash("sha256")
    .update("openmapx-root-lease\0")
    .update(owner.operationKey)
    .digest("hex");
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-4${d.slice(13, 16)}-8${d.slice(17, 20)}-${d.slice(20, 32)}`;
}

/** The lease rules, applied under the store lock by every writer; the edge grammar is checked here. */
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
    // Another execution with the same key is a conflict, never a second lease.
    if (leases.some((lease) => lease.owner.operationKey === input.owner.operationKey))
      throw Error("Execution already acquired a root lease; reconcile its original identity");
    const targets = leaseTargetsSchema.parse([...new Set(input.targets)].sort());
    for (const target of targets) {
      const holder = leases.find((lease) => lease.targets.includes(target));
      if (holder) throw new TargetBusyError(target, holder);
    }
    const record: LeaseRecord = {
      leaseId: rootLeaseId(input.owner),
      owner: input.owner,
      ownerKind: input.ownerKind,
      targets,
      state: "held",
      children: [],
      createdAt: now,
    };
    leases.push(record);
    return record;
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
    const issuer = issuerOf(lease, input.child.parentKey);
    const scope = issuer.parent?.targets ?? lease.targets;
    if (input.child.targets.some((id) => !scope.includes(id))) throw Error("Widened target subset");
    if (issuer.parent && !furtherEdges(lease, issuer.parent).includes(input.child.phase))
      throw Error("Unauthorized descendant edge");
    verifyFiniteControlEdge(
      issuer.role,
      issuer.kind,
      input.child.phase as ControlChildPhase,
      input.child.recipient,
    );
    lease.children.push({ ...input.child, adopted: false, state: "held" });
    return lease;
  },
  adopt(leases: LeaseRecord[], input: Parameters<LocalLeaseBackend["adopt"]>[0], now: number) {
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
export function localLeaseBackend(
  store: LeaseStore,
  now: () => number = Date.now,
): LocalLeaseBackend {
  const get = (leaseId: string) => store.get(leaseId);
  return {
    acquire: (input) => store.update((leases) => leaseRules.acquire(leases, input, now())),
    read: async (leaseId) => get(leaseId),
    readSync: get,
    listSync: () => store.list(),
    delegate: (input) => store.update((leases) => leaseRules.delegate(leases, input, now())),
    adopt: (input) => store.update((leases) => leaseRules.adopt(leases, input, now())),
    settle: (input) => store.update((leases) => leaseRules.settle(leases, input)),
    cancel: (input) => store.update((leases) => leaseRules.cancel(leases, input)),
    release: (input) => store.update((leases) => leaseRules.release(leases, input)),
  };
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
    return [];
  if (
    role === "ops-agent" &&
    recipient === "configuration-helper" &&
    phase === "configuration-handoff" &&
    kind === "configurationHandoff.prepare"
  )
    return [];
  if (role === "ops-agent" && kind === "configurationMaintenance.prepare") {
    if (recipient === "data-manager" && phase === "configuration-fence") return [];
    if (
      recipient === "ops-agent" &&
      [
        "configuration-commit",
        "maintenance-hardlinks",
        "maintenance-recreate",
        "maintenance-handoff",
      ].includes(phase)
    )
      return phase === "maintenance-handoff" ? ["configuration-handoff"] : [];
  }
  throw Error("Unauthorized finite control edge");
}

/**
 * Acquires the root lease of `owner`, or returns the one it already holds. A
 * holder that is finishing gets five seconds to release, within the deadline;
 * after that a held target refuses with the holder named.
 */
export async function admitRootLease(
  backend: Pick<LeaseBackend, "acquire">,
  input: Parameters<LeaseBackend["acquire"]>[0],
  signal?: AbortSignal,
): Promise<LeaseRecord> {
  const until = Math.min(Date.now() + 5000, input.owner.deadlineAt);
  for (;;) {
    try {
      return await backend.acquire(input);
    } catch (error) {
      if (!(error instanceof TargetBusyError) || Date.now() >= until) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
      signal?.throwIfAborted();
    }
  }
}
