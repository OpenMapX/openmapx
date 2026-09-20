import type { OfflineMapPackageManifest } from "@openmapx/core";
import type { OfflinePackageJobRecord } from "./types.js";

export const OFFLINE_PACKAGE_PRINCIPAL_PATTERN = /^[a-f0-9]{64}$/;
export const DEFAULT_PRINCIPAL_MAX_RUNNING = 1;
export const DEFAULT_PRINCIPAL_MAX_QUEUED = 2;
export const DEFAULT_PRINCIPAL_MAX_REFERENCES = 5;
export const DEFAULT_PRINCIPAL_MAX_LOGICAL_BYTES = 5 * 1024 ** 3;

export class OfflinePackageCapacityError extends Error {
  readonly errorCode = "capacity" as const;

  constructor(message: string) {
    super(`offline package capacity: ${message}`);
    this.name = "OfflinePackageCapacityError";
  }
}

export class OfflinePackagePrincipalQuotaError extends Error {
  readonly errorCode = "principal-quota" as const;

  constructor(message: string) {
    super(`offline package principal quota: ${message}`);
    this.name = "OfflinePackagePrincipalQuotaError";
  }
}

export interface OfflinePackageCompletion {
  unreferencedPackageIds: string[];
}

export interface OfflinePackageAdmission extends OfflinePackageCompletion {
  record: OfflinePackageJobRecord;
  createdJob: boolean;
  createdOwner: boolean;
}

export interface OfflinePackageAdmissionOptions {
  /** Called under the accounting lock; only bounded local metadata I/O is allowed. */
  readManifest(packageId: string): Promise<OfflineMapPackageManifest | undefined>;
  allowNewPreparingJob?: boolean;
}

export interface OfflinePackageArtifactAccess {
  readManifest(packageId: string): Promise<OfflineMapPackageManifest | undefined>;
  remove(packageId: string): Promise<boolean>;
}

export type OfflinePackageRemoval =
  | { status: "removed" | "absent" | "retained" }
  | { status: "failed"; message: string };

/** The caller holds its accounting lock until deletion and reconciliation finish. */
export async function removeOfflineArtifact(
  packageId: string,
  storage: OfflinePackageArtifactAccess,
  invalidate: () => void | Promise<void>,
): Promise<OfflinePackageRemoval> {
  let removed: boolean;
  try {
    removed = await storage.remove(packageId);
  } catch (error) {
    // Deletion can throw after unlinking. Do not roll back confirmed invalidation
    // merely because filesystem cleanup failed; admission also repairs crash gaps.
    let absent = false;
    try {
      absent = !(await storage.readManifest(packageId));
    } catch {
      // An inspection error is not evidence that the artifact is absent.
    }
    if (absent) await invalidate();
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  if (removed) {
    await invalidate();
    return { status: "removed" };
  }
  try {
    if (await storage.readManifest(packageId)) return { status: "retained" };
  } catch (error) {
    return { status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
  await invalidate();
  return { status: "absent" };
}

export function assertOfflineArtifactIdentity(
  candidate: OfflinePackageJobRecord,
  manifest: OfflineMapPackageManifest,
): void {
  if (
    manifest.packageId !== candidate.packageId ||
    manifest.requestKey !== candidate.request.requestKey
  ) {
    throw new Error("Offline package artifact does not match the canonical request");
  }
}

export interface OfflinePackageAccountingStore {
  admit(
    principal: string,
    candidate: OfflinePackageJobRecord,
    options: OfflinePackageAdmissionOptions,
  ): Promise<OfflinePackageAdmission>;
  removeUnreferencedArtifact(
    packageId: string,
    storage: OfflinePackageArtifactAccess,
  ): Promise<OfflinePackageRemoval>;
  getOwnedJob(principal: string, jobId: string): Promise<OfflinePackageJobRecord | undefined>;
  loadRunnable(): Promise<OfflinePackageJobRecord[]>;
  claim(jobId: string, workerId: string, maxRunning: number, leaseMs: number): Promise<boolean>;
  renew(jobId: string, workerId: string, leaseMs: number): Promise<boolean>;
  complete(
    jobId: string,
    workerId: string,
    manifest: OfflineMapPackageManifest,
  ): Promise<OfflinePackageCompletion>;
  fail(
    jobId: string,
    workerId: string | undefined,
    errorCode: OfflinePackageJobRecord["errorCode"],
    errorMessage: string,
    updatedAtMs: number,
  ): Promise<void>;
  expire(jobId: string, updatedAtMs: number): Promise<void>;
  removeTerminal(jobId: string): Promise<void>;
  retainedUsage(principal: string): Promise<{ references: number; logicalBytes: number }>;
  hasArtifactReference(packageId: string): Promise<boolean>;
}

interface StoredJob {
  record: OfflinePackageJobRecord;
  owners: Set<string>;
  leaseOwner?: string;
  leaseExpiresAtMs?: number;
}

interface ArtifactReference {
  packageId: string;
  byteLength: number;
  retainedAtMs: number;
}

export interface MemoryOfflinePackageAccountingOptions {
  clock?: () => number;
  maxRunning?: number;
  maxQueued?: number;
  maxRetainedReferences?: number;
  maxLogicalBytes?: number;
}

function cloneRecord(record: OfflinePackageJobRecord): OfflinePackageJobRecord {
  return structuredClone(record);
}

function assertPrincipal(principal: string): void {
  if (!OFFLINE_PACKAGE_PRINCIPAL_PATTERN.test(principal)) {
    throw new Error("Invalid offline package principal");
  }
}

/**
 * Deterministic in-memory implementation used by focused generator tests. It
 * uses the same serialized state transitions and quota semantics as the
 * PostgreSQL implementation; production passes the durable store explicitly.
 */
export class MemoryOfflinePackageAccountingStore implements OfflinePackageAccountingStore {
  private readonly jobs = new Map<string, StoredJob>();
  private readonly references = new Map<string, Map<string, ArtifactReference>>();
  private readonly clock: () => number;
  private readonly maxRunning: number;
  private readonly maxQueued: number;
  private readonly maxRetainedReferences: number;
  private readonly maxLogicalBytes: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryOfflinePackageAccountingOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.maxRunning = options.maxRunning ?? DEFAULT_PRINCIPAL_MAX_RUNNING;
    this.maxQueued = options.maxQueued ?? DEFAULT_PRINCIPAL_MAX_QUEUED;
    this.maxRetainedReferences = options.maxRetainedReferences ?? DEFAULT_PRINCIPAL_MAX_REFERENCES;
    this.maxLogicalBytes = options.maxLogicalBytes ?? DEFAULT_PRINCIPAL_MAX_LOGICAL_BYTES;
  }

  private async atomic<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: (() => void) | undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private isBeingPrepared(packageId: string): boolean {
    for (const stored of this.jobs.values()) {
      if (stored.record.status === "preparing" && stored.record.packageId === packageId)
        return true;
    }
    return false;
  }

  /**
   * Frees room for one new reference of `byteLength`, evicting the principal's
   * oldest references first. An artifact that a preparing job still targets is
   * skipped: a reader may be streaming those bytes right now. Mirrors the
   * `protected` guard the PostgreSQL store applies to the same decision.
   */
  private evictForNewReference(
    refs: Map<string, ArtifactReference>,
    byteLength: number,
    removed: Set<string>,
  ): void {
    const overBudget = () =>
      refs.size >= this.maxRetainedReferences ||
      [...refs.values()].reduce((sum, ref) => sum + ref.byteLength, 0) + byteLength >
        this.maxLogicalBytes;
    const candidates = [...refs.values()].sort(
      (left, right) =>
        left.retainedAtMs - right.retainedAtMs || left.packageId.localeCompare(right.packageId),
    );
    for (const candidate of candidates) {
      if (!overBudget()) return;
      if (this.isBeingPrepared(candidate.packageId)) continue;
      refs.delete(candidate.packageId);
      removed.add(candidate.packageId);
    }
    if (overBudget()) {
      throw new OfflinePackagePrincipalQuotaError("retained artifact budget is full");
    }
  }

  private invalidateArtifact(packageId: string): void {
    for (const stored of this.jobs.values()) {
      if (stored.record.packageId !== packageId || stored.record.status !== "ready-to-download")
        continue;
      stored.record = {
        ...stored.record,
        status: "expired",
        manifest: undefined,
        errorCode: "expired",
        errorMessage: "offline package artifact unavailable; prepare the area again",
        updatedAtMs: this.clock(),
      };
      stored.leaseOwner = undefined;
      stored.leaseExpiresAtMs = undefined;
    }
    for (const refs of this.references.values()) refs.delete(packageId);
  }

  async admit(
    principal: string,
    candidate: OfflinePackageJobRecord,
    options: OfflinePackageAdmissionOptions,
  ): Promise<OfflinePackageAdmission> {
    assertPrincipal(principal);
    return await this.atomic(async () => {
      const now = this.clock();
      const shared = [...this.jobs.values()].find(
        (stored) =>
          stored.record.request.requestKey === candidate.request.requestKey &&
          (stored.record.status === "preparing" || stored.record.status === "ready-to-download"),
      );
      let running = 0;
      let queued = 0;
      for (const stored of this.jobs.values()) {
        if (!stored.owners.has(principal) || stored.record.status !== "preparing") continue;
        if ((stored.leaseExpiresAtMs ?? 0) > now) running++;
        else queued++;
      }
      if (shared?.record.status === "preparing") {
        const owned = shared.owners.has(principal);
        const live = (shared.leaseExpiresAtMs ?? 0) > now;
        if (!owned && (live ? running >= this.maxRunning : queued >= this.maxQueued)) {
          throw new OfflinePackagePrincipalQuotaError(
            live ? `running limit is ${this.maxRunning}` : `queued limit is ${this.maxQueued}`,
          );
        }
        shared.owners.add(principal);
        return {
          record: cloneRecord(shared.record),
          createdJob: false,
          createdOwner: !owned,
          unreferencedPackageIds: [],
        };
      }
      const packageId = candidate.packageId;
      const manifest =
        candidate.status !== "failed" && packageId
          ? await options.readManifest(packageId)
          : undefined;
      if (manifest) {
        assertOfflineArtifactIdentity(candidate, manifest);
        if (manifest.archive.byteLength > this.maxLogicalBytes) {
          throw new OfflinePackagePrincipalQuotaError(
            `artifact exceeds ${this.maxLogicalBytes} logical bytes`,
          );
        }
        // Stage all quota effects. atomic() is a mutex, not rollback support.
        const refs = new Map(this.references.get(principal) ?? []);
        const removed = new Set<string>();
        if (!refs.has(manifest.packageId)) {
          this.evictForNewReference(refs, manifest.archive.byteLength, removed);
          refs.set(manifest.packageId, {
            packageId: manifest.packageId,
            byteLength: manifest.archive.byteLength,
            retainedAtMs: candidate.createdAtMs,
          });
        }
        const stored = shared ?? { record: cloneRecord(candidate), owners: new Set<string>() };
        const owned = stored.owners.has(principal);
        stored.record = {
          ...stored.record,
          status: "ready-to-download",
          manifest: structuredClone(manifest),
        };
        stored.owners.add(principal);
        this.references.set(principal, refs);
        this.jobs.set(stored.record.jobId, stored);
        return {
          record: cloneRecord(stored.record),
          createdJob: !shared,
          createdOwner: !owned,
          unreferencedPackageIds: [...removed].filter(
            (id) => ![...this.references.values()].some((items) => items.has(id)),
          ),
        };
      }
      if (candidate.status !== "failed") {
        if (options.allowNewPreparingJob === false)
          throw new OfflinePackageCapacityError("preparation queue is full");
        if (queued >= this.maxQueued)
          throw new OfflinePackagePrincipalQuotaError(`queued limit is ${this.maxQueued}`);
      }
      // Invalidate only after all admission checks have passed.
      if (packageId && candidate.status !== "failed") this.invalidateArtifact(packageId);
      const record = {
        ...cloneRecord(candidate),
        status: candidate.status === "failed" ? ("failed" as const) : ("preparing" as const),
        manifest: undefined,
      };
      this.jobs.set(record.jobId, { record, owners: new Set([principal]) });
      return {
        record: cloneRecord(record),
        createdJob: true,
        createdOwner: true,
        unreferencedPackageIds: [],
      };
    });
  }

  async removeUnreferencedArtifact(
    packageId: string,
    storage: OfflinePackageArtifactAccess,
  ): Promise<OfflinePackageRemoval> {
    return await this.atomic(async () => {
      if (
        this.isBeingPrepared(packageId) ||
        [...this.references.values()].some((refs) => refs.has(packageId))
      )
        return { status: "retained" };
      return await removeOfflineArtifact(packageId, storage, () =>
        this.invalidateArtifact(packageId),
      );
    });
  }

  async getOwnedJob(
    principal: string,
    jobId: string,
  ): Promise<OfflinePackageJobRecord | undefined> {
    assertPrincipal(principal);
    return await this.atomic(() => {
      const stored = this.jobs.get(jobId);
      return stored?.owners.has(principal) ? cloneRecord(stored.record) : undefined;
    });
  }

  async loadRunnable(): Promise<OfflinePackageJobRecord[]> {
    return await this.atomic(() =>
      [...this.jobs.values()]
        .filter((stored) => stored.record.status === "preparing")
        .sort(
          (left, right) =>
            left.record.createdAtMs - right.record.createdAtMs ||
            left.record.jobId.localeCompare(right.record.jobId),
        )
        .map((stored) => cloneRecord(stored.record)),
    );
  }

  async claim(
    jobId: string,
    workerId: string,
    maxRunning: number,
    leaseMs: number,
  ): Promise<boolean> {
    return await this.atomic(() => {
      const now = this.clock();
      const stored = this.jobs.get(jobId);
      if (stored?.record.status !== "preparing") return false;
      if (stored.leaseOwner === workerId && (stored.leaseExpiresAtMs ?? 0) > now) return true;
      const liveLeases = [...this.jobs.values()].filter(
        (item) => item.record.status === "preparing" && (item.leaseExpiresAtMs ?? 0) > now,
      ).length;
      if (liveLeases >= maxRunning) return false;
      for (const principal of stored.owners) {
        const ownerRunning = [...this.jobs.values()].filter(
          (item) =>
            item.owners.has(principal) &&
            item.record.status === "preparing" &&
            (item.leaseExpiresAtMs ?? 0) > now,
        ).length;
        if (ownerRunning >= this.maxRunning) return false;
      }
      stored.leaseOwner = workerId;
      stored.leaseExpiresAtMs = now + leaseMs;
      return true;
    });
  }

  async renew(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    return await this.atomic(() => {
      const stored = this.jobs.get(jobId);
      if (stored?.record.status !== "preparing" || stored.leaseOwner !== workerId) {
        return false;
      }
      stored.leaseExpiresAtMs = this.clock() + leaseMs;
      return true;
    });
  }

  async complete(
    jobId: string,
    workerId: string,
    manifest: OfflineMapPackageManifest,
  ): Promise<OfflinePackageCompletion> {
    return await this.atomic(() => {
      const stored = this.jobs.get(jobId);
      if (stored?.record.status !== "preparing" || stored.leaseOwner !== workerId) {
        throw new Error("Offline package completion does not own the durable lease");
      }
      if (manifest.archive.byteLength > this.maxLogicalBytes) {
        throw new OfflinePackagePrincipalQuotaError(
          `artifact exceeds ${this.maxLogicalBytes} logical bytes`,
        );
      }

      const planned = new Map<string, Map<string, ArtifactReference>>();
      const removed = new Set<string>();
      for (const principal of stored.owners) {
        const refs = new Map(this.references.get(principal) ?? []);
        if (!refs.has(manifest.packageId)) {
          this.evictForNewReference(refs, manifest.archive.byteLength, removed);
          refs.set(manifest.packageId, {
            packageId: manifest.packageId,
            byteLength: manifest.archive.byteLength,
            retainedAtMs: stored.record.createdAtMs,
          });
        }
        planned.set(principal, refs);
      }
      for (const [principal, refs] of planned) this.references.set(principal, refs);
      stored.record = {
        ...stored.record,
        status: "ready-to-download",
        manifest: structuredClone(manifest),
        packageId: manifest.packageId,
        updatedAtMs: this.clock(),
      };
      stored.leaseOwner = undefined;
      stored.leaseExpiresAtMs = undefined;
      const unreferencedPackageIds = [...removed].filter(
        (packageId) =>
          ![...this.references.values()].some((references) => references.has(packageId)),
      );
      return { unreferencedPackageIds };
    });
  }

  async fail(
    jobId: string,
    workerId: string | undefined,
    errorCode: OfflinePackageJobRecord["errorCode"],
    errorMessage: string,
    updatedAtMs: number,
  ): Promise<void> {
    await this.atomic(() => {
      const stored = this.jobs.get(jobId);
      if (stored?.record.status !== "preparing") return;
      if (workerId && stored.leaseOwner !== workerId) return;
      stored.record = {
        ...stored.record,
        status: "failed",
        errorCode,
        errorMessage,
        updatedAtMs,
      };
      stored.leaseOwner = undefined;
      stored.leaseExpiresAtMs = undefined;
    });
  }

  async expire(jobId: string, updatedAtMs: number): Promise<void> {
    await this.fail(
      jobId,
      undefined,
      "expired",
      "offline package preparation expired",
      updatedAtMs,
    );
  }

  async removeTerminal(jobId: string): Promise<void> {
    await this.atomic(() => {
      const stored = this.jobs.get(jobId);
      if (stored && stored.record.status !== "preparing") this.jobs.delete(jobId);
    });
  }

  async retainedUsage(principal: string): Promise<{ references: number; logicalBytes: number }> {
    assertPrincipal(principal);
    return await this.atomic(() => {
      const refs = [...(this.references.get(principal)?.values() ?? [])];
      return {
        references: refs.length,
        logicalBytes: refs.reduce((sum, ref) => sum + ref.byteLength, 0),
      };
    });
  }

  async hasArtifactReference(packageId: string): Promise<boolean> {
    return await this.atomic(() =>
      [...this.references.values()].some((references) => references.has(packageId)),
    );
  }
}

export function assertOfflinePackagePrincipal(principal: string): string {
  assertPrincipal(principal);
  return principal;
}
