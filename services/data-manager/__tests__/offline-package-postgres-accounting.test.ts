import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalOfflinePackageRequest, OfflineMapPackageManifest } from "@openmapx/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgresOfflinePackageAccountingStore } from "../src/offline-packages/postgres-accounting.js";
import type { OfflinePackageJobRecord } from "../src/offline-packages/types.js";

const principal = "a".repeat(64);
const integration = describe.runIf(process.env.OPENMAPX_POSTGRES_TESTS === "1");
let container: StartedPostgreSqlContainer;
let sql: Sql;

const artifacts = new Map<string, OfflineMapPackageManifest>();
const artifactOptions = { readManifest: async (id: string) => artifacts.get(id) };
beforeEach(() => {
  artifacts.clear();
});
async function publish(
  store: PostgresOfflinePackageAccountingStore,
  jobId: string,
  workerId: string,
  manifest: OfflineMapPackageManifest,
) {
  artifacts.set(manifest.packageId, manifest);
  return await store.complete(jobId, workerId, manifest);
}

function record(index: number): OfflinePackageJobRecord {
  const request = {
    request: {
      bbox: { west: index, south: 1, east: index + 0.5, north: 2 },
      minZoom: 1,
      maxZoom: 12,
      provider: "openmapx",
    },
    effective: {
      bbox: { west: index, south: 1, east: index + 0.5, north: 2 },
      minZoom: 1,
      maxZoom: 12,
    },
    source: {
      datasetId: "openmapx",
      datasetVersion: "dataset-v1",
      sourceMaxZoom: 12,
      sourceBounds: { west: 0, south: 0, east: 100, north: 100 },
      tileSchema: "openmaptiles",
      glyphsVersion: "glyphs-v1",
      packageAlgorithmVersion: "pmtiles-area-v1",
      attribution: ["fixture"],
    },
    requestKey: `request-${index}`,
  } satisfies CanonicalOfflinePackageRequest;
  return {
    jobId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    request,
    status: "preparing",
    packageId: `omp2-${index.toString(16).padStart(64, "0")}`,
    createdAtMs: index,
    updatedAtMs: index,
  };
}

function packageManifest(
  job: OfflinePackageJobRecord,
  byteLength = 1024,
): OfflineMapPackageManifest {
  return {
    schemaVersion: 2,
    packageId: job.packageId as string,
    requestKey: job.request.requestKey,
    dataset: {
      id: "openmapx",
      version: "dataset-v1",
      generatedAt: new Date(job.createdAtMs).toISOString(),
      sourceMaxZoom: 12,
      tileSchema: "openmaptiles",
    },
    coverage: job.request.effective,
    archive: {
      url: `/api/offline/packages/${job.packageId}/archive`,
      contentType: "application/vnd.pmtiles",
      byteLength,
      sha256: "f".repeat(64),
      etag: `sha256-${"f".repeat(64)}`,
    },
    glyphs: {
      version: "glyphs-v1",
      urlTemplate: "/api/offline/packages/glyphs/glyphs-v1/{fontstack}/{range}.pbf",
    },
    attribution: ["fixture"],
  };
}

async function seedUnreferenced(
  store: PostgresOfflinePackageAccountingStore,
): Promise<OfflinePackageJobRecord> {
  for (const index of [1, 2]) {
    const item = record(index);
    await store.admit(principal, item, artifactOptions);
    await store.claim(item.jobId, "worker", 1, 60_000);
    await publish(store, item.jobId, "worker", packageManifest(item, 1024));
  }
  return record(1);
}

integration("PostgreSQL offline-package accounting", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 12 });
    await sql`CREATE SCHEMA data_manager`;
    const migration = readFileSync(
      join(
        import.meta.dirname,
        "..",
        "..",
        "..",
        "apps",
        "api",
        "src",
        "db",
        "migrations",
        "0014_offline_package_accounting.sql",
      ),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "");
    await sql.unsafe(migration);
  }, 120_000);

  afterEach(async () => {
    await sql`
      TRUNCATE data_manager.offline_package_artifact_references,
        data_manager.offline_package_job_owners,
        data_manager.offline_package_jobs CASCADE
    `;
  });

  afterAll(async () => {
    await sql?.end();
    await container?.stop();
  });

  it("serializes 50 process-level contenders and restores ownership/runnable state", async () => {
    const storeA = new PostgresOfflinePackageAccountingStore(sql);
    const storeB = new PostgresOfflinePackageAccountingStore(sql);
    const first = record(1);
    await storeA.admit(principal, first, artifactOptions);
    expect(await storeA.claim(first.jobId, "worker-a", 1, 60_000)).toBe(true);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        (index % 2 === 0 ? storeA : storeB).admit(principal, record(index + 2), artifactOptions),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect((await storeB.getOwnedJob(principal, first.jobId))?.jobId).toBe(first.jobId);
    expect((await storeB.loadRunnable()).map((job) => job.jobId)).toHaveLength(3);
  });

  it("keeps shared physical bytes referenced while charging each opaque principal", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql);
    const shared = record(1);
    await store.admit(principal, shared, artifactOptions);
    await store.admit("b".repeat(64), { ...shared, jobId: record(2).jobId }, artifactOptions);
    await store.claim(shared.jobId, "worker", 1, 60_000);
    await publish(store, shared.jobId, "worker", packageManifest(shared));

    expect(await store.retainedUsage(principal)).toEqual({ references: 1, logicalBytes: 1024 });
    expect(await store.retainedUsage("b".repeat(64))).toEqual({
      references: 1,
      logicalBytes: 1024,
    });
    expect(await store.hasArtifactReference(shared.packageId as string)).toBe(true);
  });

  it("serializes ownership across the publish-to-completion transition", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql);
    const shared = record(1);
    await store.admit(principal, shared, artifactOptions);
    await store.claim(shared.jobId, "worker", 1, 60_000);

    artifacts.set(shared.packageId as string, packageManifest(shared));
    const whilePreparing = await store.admit(
      "b".repeat(64),
      { ...shared, jobId: record(2).jobId, status: "ready-to-download" },
      artifactOptions,
    );
    expect(whilePreparing.record.status).toBe("preparing");
    await publish(store, shared.jobId, "worker", packageManifest(shared));

    const afterCompletion = await store.admit(
      "c".repeat(64),
      {
        ...shared,
        jobId: record(3).jobId,
      },
      artifactOptions,
    );
    expect(afterCompletion.record.jobId).toBe(shared.jobId);
    expect(afterCompletion.record.status).toBe("ready-to-download");
    expect(await store.retainedUsage("b".repeat(64))).toEqual({
      references: 1,
      logicalBytes: 1024,
    });
    expect(await store.retainedUsage("c".repeat(64))).toEqual({
      references: 1,
      logicalBytes: 1024,
    });
  });
  it.each([principal, "b".repeat(64)])(
    "reconciles missing ready bytes across store recovery for %s",
    async (owner) => {
      const store = new PostgresOfflinePackageAccountingStore(sql);
      const item = record(1);
      await store.admit(principal, item, artifactOptions);
      await store.claim(item.jobId, "worker", 1, 60_000);
      await publish(store, item.jobId, "worker", packageManifest(item, 1024));
      artifacts.delete(item.packageId as string);
      const recovered = new PostgresOfflinePackageAccountingStore(sql);
      const admission = await recovered.admit(
        owner,
        { ...item, jobId: record(90).jobId },
        artifactOptions,
      );
      expect(admission.record.status).toBe("preparing");
      expect(admission.createdJob).toBe(true);
      expect(admission.record.jobId).not.toBe(item.jobId);
      expect((await recovered.getOwnedJob(principal, item.jobId))?.status).toBe("expired");
      expect(await recovered.hasArtifactReference(item.packageId as string)).toBe(false);
    },
  );

  it("restores an existing owner's evicted reference while shared bytes remain", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
    const first = record(1);
    await store.admit(principal, first, artifactOptions);
    await store.admit("b".repeat(64), { ...first, jobId: record(91).jobId }, artifactOptions);
    await store.claim(first.jobId, "worker", 1, 60_000);
    await publish(store, first.jobId, "worker", packageManifest(first, 1024));
    const second = record(2);
    await store.admit(principal, second, artifactOptions);
    await store.claim(second.jobId, "worker", 1, 60_000);
    await publish(store, second.jobId, "worker", packageManifest(second, 1024));
    expect(
      (
        await store.removeUnreferencedArtifact(first.packageId as string, {
          ...artifactOptions,
          remove: async (id) => artifacts.delete(id),
        })
      ).status,
    ).toBe("retained");
    const restored = await store.admit(
      principal,
      { ...first, jobId: record(90).jobId },
      artifactOptions,
    );
    expect(restored.record.jobId).toBe(first.jobId);
    expect(restored.createdOwner).toBe(false);
    expect(restored.unreferencedPackageIds).toEqual([second.packageId]);
    expect(await store.retainedUsage(principal)).toEqual({ references: 1, logicalBytes: 1024 });
    expect(await store.retainedUsage("b".repeat(64))).toEqual({
      references: 1,
      logicalBytes: 1024,
    });
    expect(
      (
        await store.removeUnreferencedArtifact(first.packageId as string, {
          ...artifactOptions,
          remove: async (id) => artifacts.delete(id),
        })
      ).status,
    ).toBe("retained");
  });

  it("does not partially admit a ready artifact when retained quota fails", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql, { maxLogicalBytes: 1024 });
    const item = record(1);
    artifacts.set(item.packageId as string, packageManifest(item, 1025));
    await expect(store.admit(principal, item, artifactOptions)).rejects.toThrow("logical bytes");
    expect(await store.getOwnedJob(principal, item.jobId)).toBeUndefined();
    expect(await store.retainedUsage(principal)).toEqual({ references: 0, logicalBytes: 0 });
    expect(await store.loadRunnable()).toEqual([]);
  });

  it("rejects identity-corrupt manifests without returning ready or mutating ownership", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql);
    const item = record(1);
    artifacts.set(item.packageId as string, {
      ...packageManifest(item, 1024),
      requestKey: "wrong-request",
    });
    await expect(store.admit(principal, item, artifactOptions)).rejects.toThrow(
      "canonical request",
    );
    expect(await store.getOwnedJob(principal, item.jobId)).toBeUndefined();
    expect(await store.retainedUsage(principal)).toEqual({ references: 0, logicalBytes: 0 });
  });

  it.each([
    ["refused", "retained", "ready-to-download"],
    ["absent", "absent", "expired"],
    ["throw-before", "failed", "ready-to-download"],
    ["throw-after", "failed", "expired"],
  ] as const)("reconciles %s removal without losing recovery", async (mode, expected, status) => {
    const store = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
    const oldest = await seedUnreferenced(store);
    const id = oldest.packageId as string;
    if (mode === "absent") artifacts.delete(id);
    const outcome = await store.removeUnreferencedArtifact(id, {
      ...artifactOptions,
      remove: async (key) => {
        if (mode === "throw-after") artifacts.delete(key);
        if (mode.startsWith("throw")) throw new Error("disk cleanup failed");
        return false;
      },
    });
    expect(outcome.status).toBe(expected);
    expect((await store.getOwnedJob(principal, oldest.jobId))?.status).toBe(status);
    expect(artifacts.has(id)).toBe(status === "ready-to-download");
    const retry = await store.admit(
      "b".repeat(64),
      { ...oldest, jobId: record(90).jobId },
      artifactOptions,
    );
    expect(retry.record.status).toBe(status === "expired" ? "preparing" : "ready-to-download");
  });

  it("protects a preparing lease during the publish-to-complete gap", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql);
    const first = record(1);
    await store.admit(principal, first, artifactOptions);
    await store.claim(first.jobId, "worker", 1, 60_000);
    artifacts.set(first.packageId as string, packageManifest(first, 1024));
    expect(
      (
        await store.removeUnreferencedArtifact(first.packageId as string, {
          ...artifactOptions,
          remove: async (id) => artifacts.delete(id),
        })
      ).status,
    ).toBe("retained");
    expect(await store.renew(first.jobId, "worker", 60_000)).toBe(true);
    const admission = await store.admit(
      "b".repeat(64),
      { ...first, jobId: record(90).jobId },
      artifactOptions,
    );
    expect(admission.record.status).toBe("preparing");
    expect(artifacts.has(first.packageId as string)).toBe(true);
  });

  it("serializes fresh admission behind deletion", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
    const other = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
    const oldest = await seedUnreferenced(store);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const removal = store.removeUnreferencedArtifact(oldest.packageId as string, {
      ...artifactOptions,
      remove: async (id) => {
        entered();
        await gate;
        return artifacts.delete(id);
      },
    });
    await started;
    const readManifest = vi.fn(artifactOptions.readManifest);
    const admission = other.admit(
      "b".repeat(64),
      { ...oldest, jobId: record(90).jobId },
      { readManifest },
    );
    try {
      await vi.waitFor(async () => {
        const rows = await sql<
          { waiting: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 606 AND NOT granted) AS waiting`;
        expect(rows[0]?.waiting).toBe(true);
      });
      expect(readManifest).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.allSettled([removal, admission]);
    }
    expect((await removal).status).toBe("removed");
    expect((await admission).record.status).toBe("preparing");
    expect(artifacts.has(oldest.packageId as string)).toBe(false);
  });

  it("preserves a fresh owner admitted before deletion", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
    const other = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
    const oldest = await seedUnreferenced(store);
    let release = () => {};
    let entered = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const admission = store.admit(
      "b".repeat(64),
      { ...oldest, jobId: record(90).jobId },
      {
        readManifest: async (id) => {
          entered();
          await gate;
          return artifacts.get(id);
        },
      },
    );
    await started;
    const remove = vi.fn(async (id: string) => artifacts.delete(id));
    const removal = other.removeUnreferencedArtifact(oldest.packageId as string, {
      ...artifactOptions,
      remove,
    });
    try {
      await vi.waitFor(async () => {
        const rows = await sql<
          { waiting: boolean }[]
        >`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 606 AND NOT granted) AS waiting`;
        expect(rows[0]?.waiting).toBe(true);
      });
      expect(remove).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.allSettled([admission, removal]);
    }
    expect((await admission).record.status).toBe("ready-to-download");
    expect((await removal).status).toBe("retained");
    expect(artifacts.has(oldest.packageId as string)).toBe(true);
    expect(await store.retainedUsage("b".repeat(64))).toEqual({
      references: 1,
      logicalBytes: 1024,
    });
  });
  it("leaves existing ready ownership intact when missing-file admission is rejected", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql);
    const item = record(1);
    await store.admit(principal, item, artifactOptions);
    await store.claim(item.jobId, "worker", 1, 60_000);
    await publish(store, item.jobId, "worker", packageManifest(item, 1024));
    artifacts.delete(item.packageId as string);
    await expect(
      store.admit(
        principal,
        { ...item, jobId: record(90).jobId },
        {
          ...artifactOptions,
          allowNewPreparingJob: false,
        },
      ),
    ).rejects.toThrow("preparation queue is full");
    expect((await store.getOwnedJob(principal, item.jobId))?.status).toBe("ready-to-download");
    expect(await store.hasArtifactReference(item.packageId as string)).toBe(true);
    expect(await store.getOwnedJob(principal, record(90).jobId)).toBeUndefined();
    const retry = await store.admit(
      principal,
      { ...item, jobId: record(90).jobId },
      artifactOptions,
    );
    expect(retry.record.status).toBe("preparing");
  });

  it.each([false, true])(
    "preserves ready metadata when cleanup inspection fails (removal throws: %s)",
    async (throws) => {
      const store = new PostgresOfflinePackageAccountingStore(sql, { maxRetainedReferences: 1 });
      const oldest = await seedUnreferenced(store);
      const removed = await store.removeUnreferencedArtifact(oldest.packageId as string, {
        readManifest: async () => {
          throw new Error("metadata unavailable");
        },
        remove: async () => {
          if (throws) throw new Error("removal failed");
          return false;
        },
      });
      expect(removed.status).toBe("failed");
      expect((await store.getOwnedJob(principal, oldest.jobId))?.status).toBe("ready-to-download");
      expect(artifacts.has(oldest.packageId as string)).toBe(true);
    },
  );
});
