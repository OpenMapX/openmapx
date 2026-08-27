import type { CanonicalOfflinePackageRequest, OfflineMapPackageManifest } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import {
  MemoryOfflinePackageAccountingStore,
  OfflinePackagePrincipalQuotaError,
} from "../src/offline-packages/accounting.js";
import type { OfflinePackageJobRecord } from "../src/offline-packages/types.js";

const principalA = "a".repeat(64);
const principalB = "b".repeat(64);

function job(index: number): OfflinePackageJobRecord {
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

function manifest(record: OfflinePackageJobRecord, byteLength: number): OfflineMapPackageManifest {
  return {
    schemaVersion: 2,
    packageId: record.packageId as string,
    requestKey: record.request.requestKey,
    dataset: {
      id: "openmapx",
      version: "dataset-v1",
      generatedAt: new Date(record.createdAtMs).toISOString(),
      sourceMaxZoom: 12,
      tileSchema: "openmaptiles",
    },
    coverage: { ...record.request.effective },
    archive: {
      url: `/api/offline/packages/${record.packageId}/archive`,
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

describe("offline-package per-principal accounting", () => {
  it("atomically permits one running plus exactly two queued under 50 contenders", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const first = job(1);
    await store.admit(principalA, first);
    expect(await store.claim(first.jobId, "worker-a", 1, 60_000)).toBe(true);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) => store.admit(principalA, job(index + 2))),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(48);
    expect(
      outcomes
        .filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected")
        .every((outcome) => outcome.reason instanceof OfflinePackagePrincipalQuotaError),
    ).toBe(true);
  });

  it("makes same-principal duplicates idempotent while independently accounting shared work", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const shared = job(1);
    const first = await store.admit(principalA, shared);
    const duplicate = await store.admit(principalA, { ...shared, jobId: job(2).jobId });
    const other = await store.admit(principalB, { ...shared, jobId: job(3).jobId });

    expect(duplicate.record.jobId).toBe(first.record.jobId);
    expect(duplicate.createdOwner).toBe(false);
    expect(other.record.jobId).toBe(first.record.jobId);
    expect(other.createdOwner).toBe(true);
    expect(await store.getOwnedJob(principalA, first.record.jobId)).toBeDefined();
    expect(await store.getOwnedJob("c".repeat(64), first.record.jobId)).toBeUndefined();
  });

  it("attaches a new principal to ready work and accounts its artifact reference", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const completed = job(1);
    await store.admit(principalA, completed);
    await store.claim(completed.jobId, "worker", 1, 60_000);
    await store.complete(completed.jobId, "worker", manifest(completed, 1024));

    const admission = await store.admit(principalB, {
      ...completed,
      jobId: job(2).jobId,
    });

    expect(admission.record.jobId).toBe(completed.jobId);
    expect(admission.record.status).toBe("ready-to-download");
    expect(admission.createdJob).toBe(false);
    expect(admission.createdOwner).toBe(true);
    expect(await store.retainedUsage(principalB)).toEqual({ references: 1, logicalBytes: 1024 });
  });

  it("attaches an owner that observes a published artifact before durable completion", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const preparing = job(1);
    await store.admit(principalA, preparing);
    await store.claim(preparing.jobId, "worker", 1, 60_000);

    const admission = await store.admitReady(
      principalB,
      { ...preparing, jobId: job(2).jobId, status: "ready-to-download" },
      manifest(preparing, 1024),
    );
    expect(admission.record.jobId).toBe(preparing.jobId);
    expect(admission.record.status).toBe("preparing");

    await store.complete(preparing.jobId, "worker", manifest(preparing, 1024));
    expect(await store.retainedUsage(principalA)).toEqual({ references: 1, logicalBytes: 1024 });
    expect(await store.retainedUsage(principalB)).toEqual({ references: 1, logicalBytes: 1024 });
  });

  it("charges full logical bytes per owner, evicts deterministic oldest terminal refs, and preserves shared bytes", async () => {
    const store = new MemoryOfflinePackageAccountingStore({
      maxRetainedReferences: 5,
      maxLogicalBytes: 5 * 1024,
    });
    const completed: OfflinePackageJobRecord[] = [];
    for (let index = 1; index <= 6; index += 1) {
      const record = job(index);
      await store.admit(principalA, record);
      if (index === 1) await store.admit(principalB, { ...record, jobId: job(50).jobId });
      expect(await store.claim(record.jobId, "worker", 1, 60_000)).toBe(true);
      await store.complete(record.jobId, "worker", manifest(record, 1024));
      completed.push(record);
    }

    expect(await store.retainedUsage(principalA)).toEqual({
      references: 5,
      logicalBytes: 5 * 1024,
    });
    expect(await store.retainedUsage(principalB)).toEqual({ references: 1, logicalBytes: 1024 });
    expect(await store.hasArtifactReference(completed[0]?.packageId as string)).toBe(true);
    expect(await store.getOwnedJob(principalA, completed[0]?.jobId as string)).toBeDefined();
  });

  it("never evicts a reference whose artifact is still being prepared", async () => {
    const store = new MemoryOfflinePackageAccountingStore({
      maxRetainedReferences: 2,
      maxLogicalBytes: 8 * 1024,
    });

    // The oldest reference is the eviction candidate by age, but a second
    // request for the same artifact is still preparing, so a reader may be
    // streaming those bytes right now.
    const oldest = job(1);
    await store.admit(principalA, oldest);
    expect(await store.claim(oldest.jobId, "worker", 1, 60_000)).toBe(true);
    await store.complete(oldest.jobId, "worker", manifest(oldest, 1024));

    const reprepare = { ...job(1), jobId: job(90).jobId, requestKey: "request-90" };
    await store.admit(principalA, {
      ...reprepare,
      request: { ...reprepare.request, requestKey: "request-90" },
    });

    for (const index of [2, 3]) {
      const record = job(index);
      await store.admit(principalA, record);
      expect(await store.claim(record.jobId, "worker", 1, 60_000)).toBe(true);
      await store.complete(record.jobId, "worker", manifest(record, 1024));
    }

    expect(await store.hasArtifactReference(oldest.packageId as string)).toBe(true);
    const usage = await store.retainedUsage(principalA);
    expect(usage.references).toBeLessThanOrEqual(2);
  });

  it("accepts the exact 5 GiB boundary and rejects a single over-limit artifact without a reference", async () => {
    const limit = 5 * 1024 ** 3;
    const store = new MemoryOfflinePackageAccountingStore({ maxLogicalBytes: limit });
    const exact = job(1);
    await store.admit(principalA, exact);
    await store.claim(exact.jobId, "worker", 1, 60_000);
    await store.complete(exact.jobId, "worker", manifest(exact, limit));
    expect(await store.retainedUsage(principalA)).toEqual({ references: 1, logicalBytes: limit });

    const over = job(2);
    await store.admit(principalB, over);
    await store.claim(over.jobId, "worker", 1, 60_000);
    await expect(store.complete(over.jobId, "worker", manifest(over, limit + 1))).rejects.toThrow(
      OfflinePackagePrincipalQuotaError,
    );
    expect(await store.retainedUsage(principalB)).toEqual({ references: 0, logicalBytes: 0 });
  });
});
