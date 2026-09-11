import type { StreamEvidence } from "@openmapx/core/coverage";
import { describe, expect, it } from "vitest";
import { CoverageSnapshotStore } from "../../src/coverage/snapshot-store.js";
import type { DataManagerCoverageSnapshot } from "../../src/coverage/types.js";

const BASE = "2026-09-10T12:00:00.000Z";

function evidence(key: string): StreamEvidence {
  return {
    key,
    owner: { kind: "service", id: "fixture" },
    sourceId: key,
    stream: "static",
    domain: "pois",
    observedAt: BASE,
    evidenceVersion: 1,
    presence: "present",
    region: { keys: ["country:DE"], basis: "published-region", relation: "exact" },
    publication: { version: key, publishedAt: BASE, active: true },
    attempt: { at: BASE, outcome: "succeeded" },
    lastSuccessfulCheckAt: BASE,
    lastSuccessfullyCheckedVersion: key,
    upstreamAsOf: BASE,
    expiresAt: null,
    policy: {
      basis: "fixture",
      staleAt: "2026-09-11T12:00:00.000Z",
      expiresAt: null,
      version: "fixture-1",
      provenance: "fixture",
    },
    freshness: "current",
    reasons: [],
  };
}

function snapshot(count: number): DataManagerCoverageSnapshot {
  return {
    schemaVersion: 1,
    snapshotId: "",
    generatedAt: BASE,
    collectionStatus: "complete",
    authorities: [{ authority: "data-manager", status: "available", observedAt: BASE }],
    warnings: [],
    regions: [{ key: "country:DE", label: "Germany", kind: "country" }],
    streams: Array.from({ length: count }, (_, index) =>
      evidence(`stream-${String(index).padStart(4, "0")}`),
    ),
    totalStreams: count,
    truncated: false,
    unassignedSourceCount: 0,
  };
}

describe("CoverageSnapshotStore", () => {
  it("coalesces collection, returns stable pages, and expires revisions", async () => {
    let now = Date.parse(BASE);
    let collections = 0;
    const store = new CoverageSnapshotStore({
      now: () => now,
      collect: async () => {
        collections += 1;
        return snapshot(3);
      },
      ttlMs: 30_000,
    });

    const [first, second] = await Promise.all([store.latest(), store.latest()]);
    expect(first.snapshotId).toBe(second.snapshotId);
    expect(collections).toBe(1);
    expect(store.page(first, { offset: 1, limit: 1 })).toMatchObject({
      evidence: [{ key: "stream-0001" }],
      total: 3,
      retainedTotal: 3,
      pagination: { hasMore: true, snapshotId: first.snapshotId },
    });

    now += 30_001;
    expect(store.get(first.snapshotId)).toBeNull();
    const refreshed = await store.latest();
    expect(refreshed.snapshotId).not.toBe(first.snapshotId);
    expect(collections).toBe(2);
  });

  it("marks a size-ceiling result partial and preserves the original total", async () => {
    const store = new CoverageSnapshotStore({
      collect: async () => snapshot(40),
      maxBytes: 6_000,
    });
    const result = await store.latest();
    expect(result.truncated).toBe(true);
    expect(result.collectionStatus).toBe("partial");
    expect(result.totalStreams).toBe(40);
    expect(result.streams.length).toBeLessThan(40);
    expect(result.warnings).toContain("evidence_truncated");
    expect(store.page(result).pagination.total).toBe(40);
  });

  it("rejects unbounded pagination", async () => {
    const store = new CoverageSnapshotStore({ collect: async () => snapshot(1) });
    const result = await store.latest();
    expect(() => store.page(result, { limit: 101 })).toThrow(/limit/);
    expect(() => store.page(result, { offset: -1 })).toThrow(/offset/);
  });
});
