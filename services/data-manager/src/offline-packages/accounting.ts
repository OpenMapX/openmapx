import type { OfflineMapPackageManifest } from "@openmapx/core";
import type { OfflinePackageJobRecord } from "./types.js";

export const OFFLINE_PACKAGE_PRINCIPAL_PATTERN = /^[a-f0-9]{64}$/;
export const DEFAULT_PRINCIPAL_MAX_RUNNING = 1;
export const DEFAULT_PRINCIPAL_MAX_QUEUED = 2;
export const DEFAULT_PRINCIPAL_MAX_REFERENCES = 5;
export const DEFAULT_PRINCIPAL_MAX_LOGICAL_BYTES = 5 * 1024 ** 3;

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

export interface OfflinePackageAccountingStore {
  admit(principal: string, candidate: OfflinePackageJobRecord): Promise<OfflinePackageAdmission>;
  admitReady(
    principal: string,
    candidate: OfflinePackageJobRecord,
    manifest: OfflineMapPackageManifest,
  ): Promise<OfflinePackageAdmission & OfflinePackageCompletion>;
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

  async admit(
    principal: string,
    candidate: OfflinePackageJobRecord,
  ): Promise<OfflinePackageAdmission> {
    assertPrincipal(principal);
    return await this.atomic(() => {
      for (const stored of this.jobs.values()) {
        if (
          stored.owners.has(principal) &&
          stored.record.request.requestKey === candidate.request.requestKey &&
          stored.record.status !== "failed" &&
          stored.record.status !== "expired"
        ) {
          return {
            record: cloneRecord(stored.record),
            createdJob: false,
            createdOwner: false,
            unreferencedPackageIds: [],
          };
        }
      }

      const now = this.clock();
      let running = 0;
      let queued = 0;
      for (const stored of this.jobs.values()) {
        if (!stored.owners.has(principal) || stored.record.status !== "preparing") continue;
        if ((stored.leaseExpiresAtMs ?? 0) > now) running += 1;
        else queued += 1;
      }

      const shared = [...this.jobs.values()].find(
        (stored) =>
          stored.record.request.requestKey === candidate.request.requestKey &&
          stored.record.status !== "failed" &&
          stored.record.status !== "expired",
      );
      if (shared) {
        const sharedRunning =
          shared.record.status === "preparing" && (shared.leaseExpiresAtMs ?? 0) > now;
        if (
          shared.record.status === "preparing" &&
          (sharedRunning ? running >= this.maxRunning : queued >= this.maxQueued)
        ) {
          throw new OfflinePackagePrincipalQuotaError(
            sharedRunning
              ? `running limit is ${this.maxRunning}`
              : `queued limit is ${this.maxQueued}`,
          );
        }
        const removed = new Set<string>();
        if (shared.record.status === "ready-to-download") {
          const manifest = shared.record.manifest;
          if (!manifest) throw new Error("Ready offline package is missing its manifest");
          if (manifest.archive.byteLength > this.maxLogicalBytes) {
            throw new OfflinePackagePrincipalQuotaError(
              `artifact exceeds ${this.maxLogicalBytes} logical bytes`,
            );
          }
          const refs = new Map(this.references.get(principal) ?? []);
          if (!refs.has(manifest.packageId)) {
            this.evictForNewReference(refs, manifest.archive.byteLength, removed);
            refs.set(manifest.packageId, {
              packageId: manifest.packageId,
              byteLength: manifest.archive.byteLength,
              retainedAtMs: shared.record.createdAtMs,
            });
          }
          this.references.set(principal, refs);
        }
        shared.owners.add(principal);
        return {
          record: cloneRecord(shared.record),
          createdJob: false,
          createdOwner: true,
          unreferencedPackageIds: [...removed].filter(
            (packageId) =>
              ![...this.references.values()].some((references) => references.has(packageId)),
          ),
        };
      }

      if (candidate.status === "preparing" && queued >= this.maxQueued) {
        throw new OfflinePackagePrincipalQuotaError(`queued limit is ${this.maxQueued}`);
      }
      this.jobs.set(candidate.jobId, {
        record: cloneRecord(candidate),
        owners: new Set([principal]),
      });
      return {
        record: cloneRecord(candidate),
        createdJob: true,
        createdOwner: true,
        unreferencedPackageIds: [],
      };
    });
  }

  async admitReady(
    principal: string,
    candidate: OfflinePackageJobRecord,
    manifest: OfflineMapPackageManifest,
  ): Promise<OfflinePackageAdmission & OfflinePackageCompletion> {
    assertPrincipal(principal);
    if (manifest.archive.byteLength > this.maxLogicalBytes) {
      throw new OfflinePackagePrincipalQuotaError(
        `artifact exceeds ${this.maxLogicalBytes} logical bytes`,
      );
    }
    return await this.atomic(() => {
      let stored = [...this.jobs.values()].find(
        (item) =>
          item.record.request.requestKey === candidate.request.requestKey &&
          item.record.status !== "failed" &&
          item.record.status !== "expired",
      );
      const createdJob = !stored;
      if (!stored) {
        stored = {
          record: {
            ...cloneRecord(candidate),
            status: "ready-to-download",
            manifest: structuredClone(manifest),
          },
          owners: new Set(),
        };
        this.jobs.set(stored.record.jobId, stored);
      }
      if (stored.owners.has(principal)) {
        return {
          record: cloneRecord(stored.record),
          createdJob: false,
          createdOwner: false,
          unreferencedPackageIds: [],
        };
      }
      if (stored.record.status === "preparing") {
        const now = this.clock();
        let running = 0;
        let queued = 0;
        for (const item of this.jobs.values()) {
          if (!item.owners.has(principal) || item.record.status !== "preparing") continue;
          if ((item.leaseExpiresAtMs ?? 0) > now) running += 1;
          else queued += 1;
        }
        const sharedRunning = (stored.leaseExpiresAtMs ?? 0) > now;
        if (sharedRunning ? running >= this.maxRunning : queued >= this.maxQueued) {
          throw new OfflinePackagePrincipalQuotaError(
            sharedRunning
              ? `running limit is ${this.maxRunning}`
              : `queued limit is ${this.maxQueued}`,
          );
        }
        stored.owners.add(principal);
        return {
          record: cloneRecord(stored.record),
          createdJob: false,
          createdOwner: true,
          unreferencedPackageIds: [],
        };
      }
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
      this.references.set(principal, refs);
      stored.owners.add(principal);
      return {
        record: cloneRecord(stored.record),
        createdJob,
        createdOwner: true,
        unreferencedPackageIds: [...removed].filter(
          (packageId) =>
            ![...this.references.values()].some((references) => references.has(packageId)),
        ),
      };
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
      if (!stored || stored.record.status !== "preparing") return false;
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
      if (!stored || stored.record.status !== "preparing" || stored.leaseOwner !== workerId) {
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
      if (!stored || stored.record.status !== "preparing" || stored.leaseOwner !== workerId) {
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
      if (!stored || stored.record.status !== "preparing") return;
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
