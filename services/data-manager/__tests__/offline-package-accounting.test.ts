import type { CanonicalOfflinePackageRequest, OfflineMapPackageManifest } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryOfflinePackageAccountingStore,
  OfflinePackagePrincipalQuotaError,
} from "../src/offline-packages/accounting.js";
import type { OfflinePackageJobRecord } from "../src/offline-packages/types.js";

const principalA = "a".repeat(64);
const principalB = "b".repeat(64);

const artifacts = new Map<string, OfflineMapPackageManifest>();
const artifactOptions = { readManifest: async (id: string) => artifacts.get(id) };
beforeEach(() => {
  artifacts.clear();
});
async function publish(
  store: MemoryOfflinePackageAccountingStore,
  jobId: string,
  workerId: string,
  manifest: OfflineMapPackageManifest,
) {
  artifacts.set(manifest.packageId, manifest);
  return await store.complete(jobId, workerId, manifest);
}

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

async function seedUnreferenced(
  store: MemoryOfflinePackageAccountingStore,
): Promise<OfflinePackageJobRecord> {
  for (const index of [1, 2]) {
    const item = job(index);
    await store.admit(principalA, item, artifactOptions);
    await store.claim(item.jobId, "worker", 1, 60_000);
    await publish(store, item.jobId, "worker", manifest(item, 1024));
  }
  return job(1);
}

describe("offline-package per-principal accounting", () => {
  it.each([principalA, principalB])("regenerates an evicted artifact for %s", async (owner) => {
    const store = new MemoryOfflinePackageAccountingStore();
    const artifacts = new Map<string, OfflineMapPackageManifest>();
    const options = { readManifest: async (id: string) => artifacts.get(id) };
    for (let index = 1; index <= 6; index++) {
      const item = job(index);
      await store.admit(principalA, item, options);
      expect(await store.claim(item.jobId, "worker", 1, 60_000)).toBe(true);
      const published = manifest(item, 1024);
      artifacts.set(published.packageId, published);
      const done = await publish(store, item.jobId, "worker", published);
      for (const id of done.unreferencedPackageIds) artifacts.delete(id);
    }
    const oldest = job(1);
    const retried = await store.admit(owner, { ...oldest, jobId: job(90).jobId }, options);
    expect(retried.record.status).toBe("preparing");
    expect(retried.createdJob).toBe(true);
    expect(retried.record.jobId).not.toBe(oldest.jobId);
    expect((await store.getOwnedJob(principalA, oldest.jobId))?.status).toBe("expired");
  });

  it("atomically permits one running plus exactly two queued under 50 contenders", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const first = job(1);
    await store.admit(principalA, first, artifactOptions);
    expect(await store.claim(first.jobId, "worker-a", 1, 60_000)).toBe(true);

    const outcomes = await Promise.allSettled(
      Array.from({ length: 50 }, (_, index) =>
        store.admit(principalA, job(index + 2), artifactOptions),
      ),
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
    const first = await store.admit(principalA, shared, artifactOptions);
    const duplicate = await store.admit(
      principalA,
      { ...shared, jobId: job(2).jobId },
      artifactOptions,
    );
    const other = await store.admit(
      principalB,
      { ...shared, jobId: job(3).jobId },
      artifactOptions,
    );

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
    await store.admit(principalA, completed, artifactOptions);
    await store.claim(completed.jobId, "worker", 1, 60_000);
    await publish(store, completed.jobId, "worker", manifest(completed, 1024));

    const admission = await store.admit(
      principalB,
      {
        ...completed,
        jobId: job(2).jobId,
      },
      artifactOptions,
    );

    expect(admission.record.jobId).toBe(completed.jobId);
    expect(admission.record.status).toBe("ready-to-download");
    expect(admission.createdJob).toBe(false);
    expect(admission.createdOwner).toBe(true);
    expect(await store.retainedUsage(principalB)).toEqual({ references: 1, logicalBytes: 1024 });
  });

  it("attaches an owner that observes a published artifact before durable completion", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const preparing = job(1);
    await store.admit(principalA, preparing, artifactOptions);
    await store.claim(preparing.jobId, "worker", 1, 60_000);

    artifacts.set(preparing.packageId as string, manifest(preparing, 1024));
    const admission = await store.admit(
      principalB,
      { ...preparing, jobId: job(2).jobId, status: "ready-to-download" },
      artifactOptions,
    );
    expect(admission.record.jobId).toBe(preparing.jobId);
    expect(admission.record.status).toBe("preparing");

    await publish(store, preparing.jobId, "worker", manifest(preparing, 1024));
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
      await store.admit(principalA, record, artifactOptions);
      if (index === 1)
        await store.admit(principalB, { ...record, jobId: job(50).jobId }, artifactOptions);
      expect(await store.claim(record.jobId, "worker", 1, 60_000)).toBe(true);
      await publish(store, record.jobId, "worker", manifest(record, 1024));
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

  it("protects published bytes until their preparing worker completes", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const item = job(1);
    await store.admit(principalA, item, artifactOptions);
    await store.claim(item.jobId, "worker", 1, 60_000);
    artifacts.set(item.packageId as string, manifest(item, 1024));
    const removal = await store.removeUnreferencedArtifact(item.packageId as string, {
      ...artifactOptions,
      remove: async (id) => artifacts.delete(id),
    });
    expect(removal.status).toBe("retained");
    expect(artifacts.has(item.packageId as string)).toBe(true);
    expect(await store.renew(item.jobId, "worker", 60_000)).toBe(true);
  });

  it("accepts the exact 5 GiB boundary and rejects a single over-limit artifact without a reference", async () => {
    const limit = 5 * 1024 ** 3;
    const store = new MemoryOfflinePackageAccountingStore({ maxLogicalBytes: limit });
    const exact = job(1);
    await store.admit(principalA, exact, artifactOptions);
    await store.claim(exact.jobId, "worker", 1, 60_000);
    await publish(store, exact.jobId, "worker", manifest(exact, limit));
    expect(await store.retainedUsage(principalA)).toEqual({ references: 1, logicalBytes: limit });

    const over = job(2);
    await store.admit(principalB, over, artifactOptions);
    await store.claim(over.jobId, "worker", 1, 60_000);
    await expect(publish(store, over.jobId, "worker", manifest(over, limit + 1))).rejects.toThrow(
      OfflinePackagePrincipalQuotaError,
    );
    expect(await store.retainedUsage(principalB)).toEqual({ references: 0, logicalBytes: 0 });
  });
  it.each([principalA, "b".repeat(64)])(
    "reconciles missing ready bytes across store recovery for %s",
    async (owner) => {
      const store = new MemoryOfflinePackageAccountingStore();
      const item = job(1);
      await store.admit(principalA, item, artifactOptions);
      await store.claim(item.jobId, "worker", 1, 60_000);
      await publish(store, item.jobId, "worker", manifest(item, 1024));
      artifacts.delete(item.packageId as string);
      const recovered = store;
      const admission = await recovered.admit(
        owner,
        { ...item, jobId: job(90).jobId },
        artifactOptions,
      );
      expect(admission.record.status).toBe("preparing");
      expect(admission.createdJob).toBe(true);
      expect(admission.record.jobId).not.toBe(item.jobId);
      expect((await recovered.getOwnedJob(principalA, item.jobId))?.status).toBe("expired");
      expect(await recovered.hasArtifactReference(item.packageId as string)).toBe(false);
    },
  );

  it("restores an existing owner's evicted reference while shared bytes remain", async () => {
    const store = new MemoryOfflinePackageAccountingStore({ maxRetainedReferences: 1 });
    const first = job(1);
    await store.admit(principalA, first, artifactOptions);
    await store.admit("b".repeat(64), { ...first, jobId: job(91).jobId }, artifactOptions);
    await store.claim(first.jobId, "worker", 1, 60_000);
    await publish(store, first.jobId, "worker", manifest(first, 1024));
    const second = job(2);
    await store.admit(principalA, second, artifactOptions);
    await store.claim(second.jobId, "worker", 1, 60_000);
    await publish(store, second.jobId, "worker", manifest(second, 1024));
    expect(
      (
        await store.removeUnreferencedArtifact(first.packageId as string, {
          ...artifactOptions,
          remove: async (id) => artifacts.delete(id),
        })
      ).status,
    ).toBe("retained");
    const restored = await store.admit(
      principalA,
      { ...first, jobId: job(90).jobId },
      artifactOptions,
    );
    expect(restored.record.jobId).toBe(first.jobId);
    expect(restored.createdOwner).toBe(false);
    expect(restored.unreferencedPackageIds).toEqual([second.packageId]);
    expect(await store.retainedUsage(principalA)).toEqual({ references: 1, logicalBytes: 1024 });
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
    const store = new MemoryOfflinePackageAccountingStore({ maxLogicalBytes: 1024 });
    const item = job(1);
    artifacts.set(item.packageId as string, manifest(item, 1025));
    await expect(store.admit(principalA, item, artifactOptions)).rejects.toThrow("logical bytes");
    expect(await store.getOwnedJob(principalA, item.jobId)).toBeUndefined();
    expect(await store.retainedUsage(principalA)).toEqual({ references: 0, logicalBytes: 0 });
    expect(await store.loadRunnable()).toEqual([]);
  });

  it("rejects identity-corrupt manifests without returning ready or mutating ownership", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const item = job(1);
    artifacts.set(item.packageId as string, {
      ...manifest(item, 1024),
      requestKey: "wrong-request",
    });
    await expect(store.admit(principalA, item, artifactOptions)).rejects.toThrow(
      "canonical request",
    );
    expect(await store.getOwnedJob(principalA, item.jobId)).toBeUndefined();
    expect(await store.retainedUsage(principalA)).toEqual({ references: 0, logicalBytes: 0 });
  });

  it.each([
    ["refused", "retained", "ready-to-download"],
    ["absent", "absent", "expired"],
    ["throw-before", "failed", "ready-to-download"],
    ["throw-after", "failed", "expired"],
  ] as const)("reconciles %s removal without losing recovery", async (mode, expected, status) => {
    const store = new MemoryOfflinePackageAccountingStore({ maxRetainedReferences: 1 });
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
    expect((await store.getOwnedJob(principalA, oldest.jobId))?.status).toBe(status);
    expect(artifacts.has(id)).toBe(status === "ready-to-download");
    const retry = await store.admit(
      "b".repeat(64),
      { ...oldest, jobId: job(90).jobId },
      artifactOptions,
    );
    expect(retry.record.status).toBe(status === "expired" ? "preparing" : "ready-to-download");
  });

  it("protects a preparing lease during the publish-to-complete gap", async () => {
    const store = new MemoryOfflinePackageAccountingStore();
    const first = job(1);
    await store.admit(principalA, first, artifactOptions);
    await store.claim(first.jobId, "worker", 1, 60_000);
    artifacts.set(first.packageId as string, manifest(first, 1024));
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
      { ...first, jobId: job(90).jobId },
      artifactOptions,
    );
    expect(admission.record.status).toBe("preparing");
    expect(artifacts.has(first.packageId as string)).toBe(true);
  });

  it("serializes fresh admission behind deletion", async () => {
    const store = new MemoryOfflinePackageAccountingStore({ maxRetainedReferences: 1 });
    const other = store;
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
      { ...oldest, jobId: job(90).jobId },
      { readManifest },
    );
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
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
    const store = new MemoryOfflinePackageAccountingStore({ maxRetainedReferences: 1 });
    const other = store;
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
      { ...oldest, jobId: job(90).jobId },
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
      await new Promise<void>((resolve) => setImmediate(resolve));
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
    const store = new MemoryOfflinePackageAccountingStore();
    const item = job(1);
    await store.admit(principalA, item, artifactOptions);
    await store.claim(item.jobId, "worker", 1, 60_000);
    await publish(store, item.jobId, "worker", manifest(item, 1024));
    artifacts.delete(item.packageId as string);
    await expect(
      store.admit(
        principalA,
        { ...item, jobId: job(90).jobId },
        {
          ...artifactOptions,
          allowNewPreparingJob: false,
        },
      ),
    ).rejects.toThrow("preparation queue is full");
    expect((await store.getOwnedJob(principalA, item.jobId))?.status).toBe("ready-to-download");
    expect(await store.hasArtifactReference(item.packageId as string)).toBe(true);
    expect(await store.getOwnedJob(principalA, job(90).jobId)).toBeUndefined();
    const retry = await store.admit(principalA, { ...item, jobId: job(90).jobId }, artifactOptions);
    expect(retry.record.status).toBe("preparing");
  });

  it.each([false, true])(
    "preserves ready metadata when cleanup inspection fails (removal throws: %s)",
    async (throws) => {
      const store = new MemoryOfflinePackageAccountingStore({ maxRetainedReferences: 1 });
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
      expect((await store.getOwnedJob(principalA, oldest.jobId))?.status).toBe("ready-to-download");
      expect(artifacts.has(oldest.packageId as string)).toBe(true);
    },
  );
});
