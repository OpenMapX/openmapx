import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalJson } from "../ops/canonical-json";
import { opsBusyHolderMessage } from "../ops/contract";
import type { ExecutionRef } from "../ops/execution-ref";
import {
  type LeaseChild,
  type LeaseRecord,
  type LeaseSettlement,
  leaseRecordSchema,
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
