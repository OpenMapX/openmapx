import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CanonicalOfflinePackageRequest, OfflineMapPackageManifest } from "@openmapx/core";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PostgresOfflinePackageAccountingStore } from "../src/offline-packages/postgres-accounting.js";
import type { OfflinePackageJobRecord } from "../src/offline-packages/types.js";

const principal = "a".repeat(64);
const integration = describe.runIf(process.env.OPENMAPX_POSTGRES_TESTS === "1");
let container: StartedPostgreSqlContainer;
let sql: Sql;

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
    await storeA.admit(principal, first);
    expect(await storeA.claim(first.jobId, "worker-a", 1, 60_000)).toBe(true);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        (index % 2 === 0 ? storeA : storeB).admit(principal, record(index + 2)),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect((await storeB.getOwnedJob(principal, first.jobId))?.jobId).toBe(first.jobId);
    expect((await storeB.loadRunnable()).map((job) => job.jobId)).toHaveLength(3);
  });

  it("keeps shared physical bytes referenced while charging each opaque principal", async () => {
    const store = new PostgresOfflinePackageAccountingStore(sql);
    const shared = record(1);
    await store.admit(principal, shared);
    await store.admit("b".repeat(64), { ...shared, jobId: record(2).jobId });
    await store.claim(shared.jobId, "worker", 1, 60_000);
    await store.complete(shared.jobId, "worker", packageManifest(shared));

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
    await store.admit(principal, shared);
    await store.claim(shared.jobId, "worker", 1, 60_000);

    const whilePreparing = await store.admitReady(
      "b".repeat(64),
      { ...shared, jobId: record(2).jobId, status: "ready-to-download" },
      packageManifest(shared),
    );
    expect(whilePreparing.record.status).toBe("preparing");
    await store.complete(shared.jobId, "worker", packageManifest(shared));

    const afterCompletion = await store.admit("c".repeat(64), {
      ...shared,
      jobId: record(3).jobId,
    });
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
});
