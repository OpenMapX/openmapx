import type { CanonicalOfflinePackageRequest, OfflineMapPackageManifest } from "@openmapx/core";
import type postgres from "postgres";
import {
  assertOfflinePackagePrincipal,
  DEFAULT_PRINCIPAL_MAX_LOGICAL_BYTES,
  DEFAULT_PRINCIPAL_MAX_QUEUED,
  DEFAULT_PRINCIPAL_MAX_REFERENCES,
  DEFAULT_PRINCIPAL_MAX_RUNNING,
  type OfflinePackageAccountingStore,
  type OfflinePackageAdmission,
  type OfflinePackageCompletion,
  OfflinePackagePrincipalQuotaError,
} from "./accounting.js";
import type { OfflinePackageJobRecord } from "./types.js";

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

interface JobRow {
  id: string;
  request_key: string;
  package_id: string;
  request: CanonicalOfflinePackageRequest;
  status: OfflinePackageJobRecord["status"];
  manifest: OfflineMapPackageManifest | null;
  error_code: OfflinePackageJobRecord["errorCode"] | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  lease_owner: string | null;
  lease_expires_at: Date | null;
}

interface ReferenceRow {
  package_id: string;
  byte_length: string | number;
  retained_at: Date;
  protected: boolean;
}

export interface PostgresOfflinePackageAccountingOptions {
  maxRunningPerPrincipal?: number;
  maxQueuedPerPrincipal?: number;
  maxRetainedReferences?: number;
  maxLogicalBytes?: number;
  maxGlobalQueued?: number;
  maxTrackedJobs?: number;
  terminalRetentionMs?: number;
}

function recordFromRow(row: JobRow): OfflinePackageJobRecord {
  return {
    jobId: row.id,
    request: row.request,
    status: row.status,
    ...(row.package_id.startsWith("omp2-") ? { packageId: row.package_id } : {}),
    ...(row.manifest ? { manifest: row.manifest } : {}),
    ...(row.error_code ? { errorCode: row.error_code } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAtMs: row.created_at.getTime(),
    updatedAtMs: row.updated_at.getTime(),
  };
}

const JOB_COLUMN_NAMES = [
  "id",
  "request_key",
  "package_id",
  "request",
  "status",
  "manifest",
  "error_code",
  "error_message",
  "created_at",
  "updated_at",
  "lease_owner",
  "lease_expires_at",
] as const;

// The owners table carries its own `created_at`, so an unqualified column list
// becomes ambiguous the moment a query joins it. Every job query therefore
// selects the jobs table through the `j` alias and reads these qualified names.
const JOB_COLUMNS = JOB_COLUMN_NAMES.map((name) => `j.${name}`).join(", ");

/**
 * PostgreSQL is the production authority for offline-package ownership,
 * per-principal accounting, and worker leases. Every transition takes the
 * global/principal/request advisory locks in that order so multiple
 * data-manager processes cannot over-admit, deadlock, or double-run work.
 */
export class PostgresOfflinePackageAccountingStore implements OfflinePackageAccountingStore {
  private readonly maxRunningPerPrincipal: number;
  private readonly maxQueuedPerPrincipal: number;
  private readonly maxRetainedReferences: number;
  private readonly maxLogicalBytes: number;
  private readonly maxGlobalQueued: number;
  private readonly maxTrackedJobs: number;
  private readonly terminalRetentionMs: number;

  constructor(
    private readonly sql: postgres.Sql,
    options: PostgresOfflinePackageAccountingOptions = {},
  ) {
    this.maxRunningPerPrincipal = options.maxRunningPerPrincipal ?? DEFAULT_PRINCIPAL_MAX_RUNNING;
    this.maxQueuedPerPrincipal = options.maxQueuedPerPrincipal ?? DEFAULT_PRINCIPAL_MAX_QUEUED;
    this.maxRetainedReferences = options.maxRetainedReferences ?? DEFAULT_PRINCIPAL_MAX_REFERENCES;
    this.maxLogicalBytes = options.maxLogicalBytes ?? DEFAULT_PRINCIPAL_MAX_LOGICAL_BYTES;
    this.maxGlobalQueued =
      options.maxGlobalQueued ?? envPositiveInt("OFFLINE_PACKAGE_MAX_QUEUED_JOBS", 64);
    this.maxTrackedJobs =
      options.maxTrackedJobs ?? envPositiveInt("OFFLINE_PACKAGE_MAX_TRACKED_JOBS", 1_024);
    this.terminalRetentionMs =
      options.terminalRetentionMs ??
      envPositiveInt("OFFLINE_PACKAGE_JOB_RETENTION_MS", 24 * 60 * 60 * 1_000);
  }

  private async lockPrincipal(tx: postgres.TransactionSql, principal: string): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${principal}, 604))`;
  }

  private async lockGlobal(tx: postgres.TransactionSql): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(606)`;
  }

  private async lockRequest(tx: postgres.TransactionSql, requestKey: string): Promise<void> {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey}, 605))`;
  }

  private async principalActiveCounts(
    tx: postgres.TransactionSql,
    principal: string,
  ): Promise<{ running: number; queued: number }> {
    const [row] = await tx<{ running: string; queued: string }[]>`
      SELECT
        count(*) FILTER (
          WHERE j.status = 'preparing' AND j.lease_expires_at > clock_timestamp()
        )::text AS running,
        count(*) FILTER (
          WHERE j.status = 'preparing'
            AND (j.lease_expires_at IS NULL OR j.lease_expires_at <= clock_timestamp())
        )::text AS queued
      FROM data_manager.offline_package_jobs j
      JOIN data_manager.offline_package_job_owners o ON o.job_id = j.id
      WHERE o.principal = ${principal}
    `;
    return { running: Number(row?.running ?? 0), queued: Number(row?.queued ?? 0) };
  }

  private async pruneAndCheckGlobalCapacity(tx: postgres.TransactionSql): Promise<void> {
    await tx`
      DELETE FROM data_manager.offline_package_jobs
      WHERE status <> 'preparing'
        AND updated_at < clock_timestamp() - (${this.terminalRetentionMs}::bigint * interval '1 millisecond')
    `;
    let [counts] = await tx<{ tracked: string; queued: string }[]>`
      SELECT
        count(*)::text AS tracked,
        count(*) FILTER (
          WHERE status = 'preparing'
            AND (lease_expires_at IS NULL OR lease_expires_at <= clock_timestamp())
        )::text AS queued
      FROM data_manager.offline_package_jobs
    `;
    if (Number(counts?.queued ?? 0) >= this.maxGlobalQueued) {
      throw new Error(
        `offline package capacity: preparation queue is full (${this.maxGlobalQueued} waiting jobs)`,
      );
    }
    if (Number(counts?.tracked ?? 0) >= this.maxTrackedJobs) {
      await tx`
        DELETE FROM data_manager.offline_package_jobs
        WHERE id = (
          SELECT id
          FROM data_manager.offline_package_jobs
          WHERE status <> 'preparing'
          ORDER BY updated_at ASC, created_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
      `;
      [counts] = await tx<{ tracked: string; queued: string }[]>`
        SELECT count(*)::text AS tracked, '0'::text AS queued
        FROM data_manager.offline_package_jobs
      `;
    }
    if (Number(counts?.tracked ?? 0) >= this.maxTrackedJobs) {
      throw new Error(
        `offline package capacity: job metadata limit is full (${this.maxTrackedJobs} jobs)`,
      );
    }
  }

  async admit(
    principal: string,
    candidate: OfflinePackageJobRecord,
  ): Promise<OfflinePackageAdmission> {
    assertOfflinePackagePrincipal(principal);
    return await this.sql.begin(async (tx) => {
      await this.lockGlobal(tx);
      await this.lockPrincipal(tx, principal);
      await this.lockRequest(tx, candidate.request.requestKey);
      const owned = await tx<JobRow[]>`
        SELECT ${tx.unsafe(JOB_COLUMNS)}
        FROM data_manager.offline_package_jobs j
        JOIN data_manager.offline_package_job_owners o ON o.job_id = j.id
        WHERE o.principal = ${principal}
          AND j.request_key = ${candidate.request.requestKey}
          AND j.status NOT IN ('failed', 'expired')
        ORDER BY j.created_at ASC, j.id ASC
        LIMIT 1
      `;
      if (owned[0]) {
        return {
          record: recordFromRow(owned[0]),
          createdJob: false,
          createdOwner: false,
          unreferencedPackageIds: [],
        };
      }

      const counts = await this.principalActiveCounts(tx, principal);
      const shared = await tx<JobRow[]>`
        SELECT ${tx.unsafe(JOB_COLUMNS)}
        FROM data_manager.offline_package_jobs j
        WHERE j.request_key = ${candidate.request.requestKey}
          AND j.status IN ('preparing', 'ready-to-download')
        ORDER BY j.created_at ASC, j.id ASC
        LIMIT 1
        FOR UPDATE
      `;
      if (shared[0]) {
        const unreferencedPackageIds: string[] = [];
        if (shared[0].status === "preparing") {
          const [lease] = await tx<{ running: boolean }[]>`
            SELECT lease_expires_at > clock_timestamp() AS running
            FROM data_manager.offline_package_jobs
            WHERE id = ${shared[0].id}
          `;
          const running = lease?.running === true;
          if (
            (running && counts.running >= this.maxRunningPerPrincipal) ||
            (!running && counts.queued >= this.maxQueuedPerPrincipal)
          ) {
            throw new OfflinePackagePrincipalQuotaError(
              running
                ? `running limit is ${this.maxRunningPerPrincipal}`
                : `queued limit is ${this.maxQueuedPerPrincipal}`,
            );
          }
        } else {
          const manifest = shared[0].manifest;
          if (!manifest) throw new Error("Ready offline package is missing its manifest");
          unreferencedPackageIds.push(
            ...(await this.retainReference(
              tx,
              principal,
              manifest.packageId,
              manifest.archive.byteLength,
              shared[0].created_at,
            )),
          );
        }
        await tx`
          INSERT INTO data_manager.offline_package_job_owners (job_id, principal, created_at)
          VALUES (${shared[0].id}, ${principal}, clock_timestamp())
        `;
        return {
          record: recordFromRow(shared[0]),
          createdJob: false,
          createdOwner: true,
          unreferencedPackageIds: await this.unreferenced(tx, unreferencedPackageIds),
        };
      }
      if (counts.queued >= this.maxQueuedPerPrincipal) {
        throw new OfflinePackagePrincipalQuotaError(
          `queued limit is ${this.maxQueuedPerPrincipal}`,
        );
      }
      await this.pruneAndCheckGlobalCapacity(tx);
      await tx`
        INSERT INTO data_manager.offline_package_jobs (
          id, request_key, package_id, request, status, manifest, error_code,
          error_message, created_at, updated_at
        ) VALUES (
          ${candidate.jobId}, ${candidate.request.requestKey}, ${candidate.packageId ?? `invalid-${candidate.jobId}`},
          ${tx.json(candidate.request as never)}, ${candidate.status}, ${candidate.manifest ? tx.json(candidate.manifest as never) : null},
          ${candidate.errorCode ?? null}, ${candidate.errorMessage ?? null},
          ${new Date(candidate.createdAtMs)}, ${new Date(candidate.updatedAtMs)}
        )
      `;
      await tx`
        INSERT INTO data_manager.offline_package_job_owners (job_id, principal, created_at)
        VALUES (${candidate.jobId}, ${principal}, clock_timestamp())
      `;
      return {
        record: structuredClone(candidate),
        createdJob: true,
        createdOwner: true,
        unreferencedPackageIds: [],
      };
    });
  }

  private async retainReference(
    tx: postgres.TransactionSql,
    principal: string,
    packageId: string,
    byteLength: number,
    retainedAt: Date,
  ): Promise<string[]> {
    if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.maxLogicalBytes) {
      throw new OfflinePackagePrincipalQuotaError(
        `artifact exceeds ${this.maxLogicalBytes} logical bytes`,
      );
    }
    const existing = await tx`
      SELECT 1 FROM data_manager.offline_package_artifact_references
      WHERE principal = ${principal} AND package_id = ${packageId}
    `;
    if (existing.length > 0) return [];
    const refs = await tx<ReferenceRow[]>`
      SELECT r.package_id, r.byte_length::text, r.retained_at,
        EXISTS (
          SELECT 1 FROM data_manager.offline_package_jobs active
          WHERE active.package_id = r.package_id AND active.status = 'preparing'
        ) AS protected
      FROM data_manager.offline_package_artifact_references r
      WHERE r.principal = ${principal}
      ORDER BY r.retained_at ASC, r.package_id ASC
      FOR UPDATE
    `;
    let referenceCount = refs.length;
    let logicalBytes = refs.reduce((sum, ref) => sum + Number(ref.byte_length), 0);
    const evicted: string[] = [];
    for (const ref of refs) {
      if (
        referenceCount < this.maxRetainedReferences &&
        logicalBytes + byteLength <= this.maxLogicalBytes
      ) {
        break;
      }
      if (ref.protected) continue;
      await tx`
        DELETE FROM data_manager.offline_package_artifact_references
        WHERE principal = ${principal} AND package_id = ${ref.package_id}
      `;
      referenceCount -= 1;
      logicalBytes -= Number(ref.byte_length);
      evicted.push(ref.package_id);
    }
    if (
      referenceCount >= this.maxRetainedReferences ||
      logicalBytes + byteLength > this.maxLogicalBytes
    ) {
      throw new OfflinePackagePrincipalQuotaError("retained artifact budget is full");
    }
    await tx`
      INSERT INTO data_manager.offline_package_artifact_references (
        principal, package_id, byte_length, retained_at
      ) VALUES (${principal}, ${packageId}, ${byteLength}, ${retainedAt})
    `;
    return evicted;
  }

  private async unreferenced(tx: postgres.TransactionSql, packageIds: string[]): Promise<string[]> {
    const result: string[] = [];
    for (const packageId of new Set(packageIds)) {
      const [row] = await tx<{ referenced: boolean; active: boolean }[]>`
        SELECT
          EXISTS (
            SELECT 1 FROM data_manager.offline_package_artifact_references
            WHERE package_id = ${packageId}
          ) AS referenced,
          EXISTS (
            SELECT 1 FROM data_manager.offline_package_jobs
            WHERE package_id = ${packageId} AND status = 'preparing'
          ) AS active
      `;
      if (row && !row.referenced && !row.active) result.push(packageId);
    }
    return result;
  }

  async admitReady(
    principal: string,
    candidate: OfflinePackageJobRecord,
    manifest: OfflineMapPackageManifest,
  ): Promise<OfflinePackageAdmission & OfflinePackageCompletion> {
    assertOfflinePackagePrincipal(principal);
    return await this.sql.begin(async (tx) => {
      await this.lockGlobal(tx);
      await this.lockPrincipal(tx, principal);
      await this.lockRequest(tx, candidate.request.requestKey);
      let [row] = await tx<JobRow[]>`
        SELECT ${tx.unsafe(JOB_COLUMNS)}
        FROM data_manager.offline_package_jobs j
        WHERE j.request_key = ${candidate.request.requestKey}
          AND j.status IN ('preparing', 'ready-to-download')
        ORDER BY j.created_at ASC, j.id ASC LIMIT 1 FOR UPDATE
      `;
      const createdJob = !row;
      if (!row) {
        await this.pruneAndCheckGlobalCapacity(tx);
        await tx`
          INSERT INTO data_manager.offline_package_jobs (
            id, request_key, package_id, request, status, manifest,
            created_at, updated_at
          ) VALUES (
            ${candidate.jobId}, ${candidate.request.requestKey}, ${manifest.packageId},
            ${tx.json(candidate.request as never)}, 'ready-to-download', ${tx.json(manifest as never)},
            ${new Date(candidate.createdAtMs)}, ${new Date(candidate.updatedAtMs)}
          )
        `;
        [row] = await tx<JobRow[]>`
          SELECT ${tx.unsafe(JOB_COLUMNS)} FROM data_manager.offline_package_jobs j
          WHERE j.id = ${candidate.jobId}
        `;
      }
      if (!row) throw new Error("Offline package ready admission was not persisted");
      const owned = await tx`
        SELECT 1 FROM data_manager.offline_package_job_owners
        WHERE job_id = ${row.id} AND principal = ${principal}
      `;
      if (owned.length > 0) {
        return {
          record: recordFromRow(row),
          createdJob: false,
          createdOwner: false,
          unreferencedPackageIds: [],
        };
      }
      if (row.status === "preparing") {
        const counts = await this.principalActiveCounts(tx, principal);
        const [lease] = await tx<{ running: boolean }[]>`
          SELECT lease_expires_at > clock_timestamp() AS running
          FROM data_manager.offline_package_jobs
          WHERE id = ${row.id}
        `;
        const running = lease?.running === true;
        if (
          (running && counts.running >= this.maxRunningPerPrincipal) ||
          (!running && counts.queued >= this.maxQueuedPerPrincipal)
        ) {
          throw new OfflinePackagePrincipalQuotaError(
            running
              ? `running limit is ${this.maxRunningPerPrincipal}`
              : `queued limit is ${this.maxQueuedPerPrincipal}`,
          );
        }
        await tx`
          INSERT INTO data_manager.offline_package_job_owners (job_id, principal, created_at)
          VALUES (${row.id}, ${principal}, clock_timestamp())
        `;
        return {
          record: recordFromRow(row),
          createdJob: false,
          createdOwner: true,
          unreferencedPackageIds: [],
        };
      }
      const evicted = await this.retainReference(
        tx,
        principal,
        manifest.packageId,
        manifest.archive.byteLength,
        new Date(candidate.createdAtMs),
      );
      await tx`
        INSERT INTO data_manager.offline_package_job_owners (job_id, principal, created_at)
        VALUES (${row.id}, ${principal}, clock_timestamp())
      `;
      return {
        record: recordFromRow(row),
        createdJob,
        createdOwner: true,
        unreferencedPackageIds: await this.unreferenced(tx, evicted),
      };
    });
  }

  async getOwnedJob(
    principal: string,
    jobId: string,
  ): Promise<OfflinePackageJobRecord | undefined> {
    assertOfflinePackagePrincipal(principal);
    const [row] = await this.sql<JobRow[]>`
      SELECT ${this.sql.unsafe(JOB_COLUMNS)}
      FROM data_manager.offline_package_jobs j
      JOIN data_manager.offline_package_job_owners o ON o.job_id = j.id
      WHERE j.id = ${jobId} AND o.principal = ${principal}
      LIMIT 1
    `;
    return row ? recordFromRow(row) : undefined;
  }

  async loadRunnable(): Promise<OfflinePackageJobRecord[]> {
    const rows = await this.sql<JobRow[]>`
      SELECT ${this.sql.unsafe(JOB_COLUMNS)}
      FROM data_manager.offline_package_jobs j
      WHERE j.status = 'preparing'
      ORDER BY j.created_at ASC, j.id ASC
    `;
    return rows.map(recordFromRow);
  }

  async claim(
    jobId: string,
    workerId: string,
    maxRunning: number,
    leaseMs: number,
  ): Promise<boolean> {
    return await this.sql.begin(async (tx) => {
      await this.lockGlobal(tx);
      const [job] = await tx<JobRow[]>`
        SELECT ${tx.unsafe(JOB_COLUMNS)} FROM data_manager.offline_package_jobs j
        WHERE j.id = ${jobId} FOR UPDATE
      `;
      if (!job || job.status !== "preparing") return false;
      const [lease] = await tx<{ live: boolean }[]>`
        SELECT lease_expires_at > clock_timestamp() AS live
        FROM data_manager.offline_package_jobs
        WHERE id = ${jobId}
      `;
      if (job.lease_owner === workerId && lease?.live === true) {
        return true;
      }
      const [global] = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM data_manager.offline_package_jobs
        WHERE status = 'preparing' AND lease_expires_at > clock_timestamp()
      `;
      if (Number(global?.count ?? 0) >= maxRunning) return false;
      const owners = await tx<{ principal: string }[]>`
        SELECT principal FROM data_manager.offline_package_job_owners WHERE job_id = ${jobId}
        ORDER BY principal ASC
      `;
      for (const owner of owners) {
        await this.lockPrincipal(tx, owner.principal);
        const counts = await this.principalActiveCounts(tx, owner.principal);
        if (counts.running >= this.maxRunningPerPrincipal) return false;
      }
      await tx`
        UPDATE data_manager.offline_package_jobs
        SET lease_owner = ${workerId},
            lease_expires_at = clock_timestamp() + (${leaseMs}::bigint * interval '1 millisecond'),
            updated_at = clock_timestamp()
        WHERE id = ${jobId}
      `;
      return true;
    });
  }

  async renew(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const rows = await this.sql`
      UPDATE data_manager.offline_package_jobs
      SET lease_expires_at = clock_timestamp() + (${leaseMs}::bigint * interval '1 millisecond')
      WHERE id = ${jobId} AND status = 'preparing' AND lease_owner = ${workerId}
      RETURNING id
    `;
    return rows.length === 1;
  }

  async complete(
    jobId: string,
    workerId: string,
    manifest: OfflineMapPackageManifest,
  ): Promise<OfflinePackageCompletion> {
    return await this.sql.begin(async (tx) => {
      await this.lockGlobal(tx);
      const [job] = await tx<JobRow[]>`
        SELECT ${tx.unsafe(JOB_COLUMNS)} FROM data_manager.offline_package_jobs j
        WHERE j.id = ${jobId} FOR UPDATE
      `;
      if (!job || job.status !== "preparing" || job.lease_owner !== workerId) {
        throw new Error("Offline package completion does not own the durable lease");
      }
      const owners = await tx<{ principal: string }[]>`
        SELECT principal FROM data_manager.offline_package_job_owners
        WHERE job_id = ${jobId} ORDER BY principal ASC
      `;
      const evicted: string[] = [];
      for (const owner of owners) {
        await this.lockPrincipal(tx, owner.principal);
        evicted.push(
          ...(await this.retainReference(
            tx,
            owner.principal,
            manifest.packageId,
            manifest.archive.byteLength,
            job.created_at,
          )),
        );
      }
      await tx`
        UPDATE data_manager.offline_package_jobs
        SET status = 'ready-to-download', manifest = ${tx.json(manifest as never)},
            package_id = ${manifest.packageId}, updated_at = clock_timestamp(),
            lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ${jobId} AND lease_owner = ${workerId}
      `;
      return { unreferencedPackageIds: await this.unreferenced(tx, evicted) };
    });
  }

  async fail(
    jobId: string,
    workerId: string | undefined,
    errorCode: OfflinePackageJobRecord["errorCode"],
    errorMessage: string,
    updatedAtMs: number,
  ): Promise<void> {
    if (workerId) {
      await this.sql`
        UPDATE data_manager.offline_package_jobs
        SET status = 'failed', error_code = ${errorCode ?? null}, error_message = ${errorMessage},
            updated_at = ${new Date(updatedAtMs)}, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ${jobId} AND status = 'preparing' AND lease_owner = ${workerId}
      `;
    } else {
      await this.sql`
        UPDATE data_manager.offline_package_jobs
        SET status = 'failed', error_code = ${errorCode ?? null}, error_message = ${errorMessage},
            updated_at = ${new Date(updatedAtMs)}, lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ${jobId} AND status = 'preparing'
      `;
    }
  }

  async expire(jobId: string, updatedAtMs: number): Promise<void> {
    await this.sql`
      UPDATE data_manager.offline_package_jobs
      SET status = 'expired', error_code = 'expired',
          error_message = 'offline package preparation expired',
          updated_at = ${new Date(updatedAtMs)}, lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${jobId} AND status = 'preparing'
    `;
  }

  async removeTerminal(jobId: string): Promise<void> {
    await this.sql`
      DELETE FROM data_manager.offline_package_jobs
      WHERE id = ${jobId} AND status <> 'preparing'
    `;
  }

  async retainedUsage(principal: string): Promise<{ references: number; logicalBytes: number }> {
    assertOfflinePackagePrincipal(principal);
    const [row] = await this.sql<{ references: string; logical_bytes: string }[]>`
      SELECT count(*)::text AS references, coalesce(sum(byte_length), 0)::text AS logical_bytes
      FROM data_manager.offline_package_artifact_references WHERE principal = ${principal}
    `;
    return {
      references: Number(row?.references ?? 0),
      logicalBytes: Number(row?.logical_bytes ?? 0),
    };
  }

  async hasArtifactReference(packageId: string): Promise<boolean> {
    const [row] = await this.sql<{ referenced: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM data_manager.offline_package_artifact_references
        WHERE package_id = ${packageId}
      ) AS referenced
    `;
    return row?.referenced === true;
  }
}
