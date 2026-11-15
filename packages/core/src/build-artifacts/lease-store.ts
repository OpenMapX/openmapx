import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import type { ExecutionRef } from "../ops/execution-ref";
import {
  type LeaseChild,
  type LeaseRecord,
  type LeaseSettlement,
  leaseRecordSchema,
  leaseTargetsSchema,
} from "../ops/lease-records";
import { atomicWrite } from "../release-files";
import { type ContainerRunning, withRecoverableLock } from "../services/recoverable-lock";

/**
 * Target leases, in the operations agent's own state directory, which no other
 * service mounts. Every writer that changes containers claims its targets here
 * first: the agent for its own operations and on behalf of data-manager and the
 * host CLI, the configuration helper while the agent is replaced, the agent's
 * fixed CLI children, and the host CLI directly only while the agent is down.
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

/** The store's lock is held by another live writer past the wait. */
export { LockBusyError as LeaseStoreBusyError } from "../services/recoverable-lock";
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
      `Target lease busy: ${target} is held by ${holder.owner.executor} operation ${holder.owner.operationKey} (${holder.ownerKind}, ${holder.state}). See \`openmapx control status\`.`,
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
  try {
    const stats = lstatSync(path);
    if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw new Error("Unsafe lease store file");
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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

/** Every target some lease in the installation's store holds, read without the lock. */
export function heldTargets(infraDir: string): string[] {
  return [
    ...new Set(
      readStore(join(leaseStoreDirectory(infraDir), LEASE_STORE_FILE)).flatMap(
        (lease) => lease.targets,
      ),
    ),
  ].sort();
}

/** Creates a held lease for `owner`, or refuses with the first holder named. */
export function admitLease(
  leases: LeaseRecord[],
  input: { owner: ExecutionRef; ownerKind: string; targets: readonly string[]; now: number },
): LeaseRecord {
  const targets = leaseTargetsSchema.parse([...new Set(input.targets)].sort());
  if (leases.some((lease) => lease.owner.operationKey === input.owner.operationKey))
    throw new Error("Execution already acquired a root lease; reconcile its original identity");
  for (const target of targets) {
    const holder = leases.find((lease) => lease.targets.includes(target));
    if (holder) throw new TargetBusyError(target, holder);
  }
  const record: LeaseRecord = {
    leaseId: randomUUID(),
    owner: input.owner,
    ownerKind: input.ownerKind,
    targets,
    state: "held",
    children: [],
    createdAt: input.now,
  };
  leases.push(record);
  return record;
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
