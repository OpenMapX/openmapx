import type { AuthorityObservation, CoverageRegion, StreamEvidence } from "@openmapx/core/coverage";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "coverage-service-test-secret";
});

import type { LoadedIntegration } from "@openmapx/integration-framework";
import { buildCoverageCatalog } from "./catalog.js";
import type { CoverageCollection } from "./collect.js";
import { collectCoverageData, freshenStream, runtimeForProvider } from "./collect.js";
import { createCoverageService } from "./service.js";

const REGION: CoverageRegion = {
  key: "extract:test",
  label: "Test extract",
  kind: "extract",
};

function makeStream(staleAt: string): StreamEvidence {
  return {
    key: "service:data-manager:test",
    owner: { kind: "service", id: "data-manager" },
    sourceId: "test-source",
    stream: "static",
    domain: "pois",
    observedAt: "2026-09-10T12:00:00.000Z",
    evidenceVersion: 1,
    presence: "present",
    region: { keys: [REGION.key], basis: "published-region", relation: "unknown" },
    publication: {
      version: "v1",
      publishedAt: "2026-09-10T12:00:00.000Z",
      active: true,
    },
    attempt: { at: "2026-09-10T12:00:00.000Z", outcome: "succeeded" },
    lastSuccessfulCheckAt: "2026-09-10T12:00:00.000Z",
    lastSuccessfullyCheckedVersion: "v1",
    upstreamAsOf: null,
    expiresAt: null,
    policy: {
      basis: "test",
      staleAt,
      expiresAt: null,
      version: "test-v1",
      provenance: "test fixture",
    },
    freshness: "current",
    reasons: [],
  };
}

function makeCollection(stream: StreamEvidence): CoverageCollection {
  const authorities: AuthorityObservation[] = [
    { authority: "data-manager", status: "available", observedAt: stream.observedAt },
  ];
  return {
    generatedAt: stream.observedAt,
    collectionStatus: "complete",
    authorities,
    warnings: [],
    regions: [REGION],
    streams: [stream],
    catalog: { integrations: [], providers: [], rights: [] },
    integrationHealth: { updatedAt: null, results: [] },
    providerHealth: new Map(),
    bindings: new Map(),
    policy: null,
    unassignedSourceCount: 0,
    dataManagerSnapshotId: "dm-test",
  };
}

describe("CoverageService", () => {
  const integration = (): LoadedIntegration => ({
    id: "parking",
    manifest: {
      id: "parking",
      domains: ["data-source"],
      dataSources: [
        {
          sourceId: "test-source",
          name: "Test",
          url: "https://example.test",
          license: "Recorded",
          providerCountry: "DE",
          providerPrivacyUrl: "https://example.test/privacy",
          commercialUse: "yes",
        },
      ],
    },
    config: {},
    directory: "/fixture",
    isBuiltIn: true,
    enabled: true,
    providers: new Map([["data-source", [{ id: "parking", search: async () => [] }]]]),
    strings: {},
    shutdownHandlers: [],
  });

  it("reads persisted road evidence without invoking event queries or polling jobs", async () => {
    const getEvents = vi.fn(async () => []);
    const getOperationalEvidence = vi.fn(async () => ({
      schemaVersion: 1 as const,
      instanceId: "oc-instance",
      collectedAt: "2026-09-11T12:00:00Z",
      feeds: [],
    }));
    const road = integration();
    road.manifest.domains = ["road-conditions"];
    road.providers = new Map([
      ["road-conditions", [{ id: "oc", getEvents, getOperationalEvidence }]],
    ]);
    const result = await collectCoverageData({
      now: () => new Date("2026-09-11T12:00:00Z"),
      integrations: [road],
      dataManager: {
        read: async () => {
          throw new Error("Unavailable");
        },
      },
      loadBindings: async () => new Map(),
      loadPolicy: async () => ({ allowGreyArea: true, allowNonCommercial: true }),
      providerHealth: null,
      integrationHealth: () => ({ updatedAt: null, results: [] }),
    });
    expect(result.collectionStatus).toBe("partial");
    expect(getOperationalEvidence).toHaveBeenCalledTimes(1);
    expect(getEvents).not.toHaveBeenCalled();
  });

  it("retains API evidence when data-manager is unavailable", async () => {
    const collected = await collectCoverageData({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      integrations: [integration()],
      dataManager: {
        read: async () => {
          throw new Error("secret internal address");
        },
      },
      loadBindings: async () => new Map(),
      loadPolicy: async () => ({ allowGreyArea: true, allowNonCommercial: true }),
      providerHealth: null,
      integrationHealth: () => ({ updatedAt: null, results: [] }),
    });
    expect(collected.collectionStatus).toBe("partial");
    expect(collected.regions).toContainEqual(expect.objectContaining({ key: "unassigned" }));
    expect(collected.streams).toHaveLength(1);
    expect(JSON.stringify(collected)).not.toContain("secret internal address");
  });

  it("uses the aggregate scheduled health check and expires positive evidence", () => {
    const collection = makeCollection(makeStream("2026-09-10T13:00:00.000Z"));
    collection.catalog = buildCoverageCatalog([integration()]);
    collection.integrationHealth = {
      updatedAt: Date.parse(collection.generatedAt),
      results: [
        { id: "parking:child", name: "child", category: "test", url: "", status: "up" },
        { id: "parking", name: "parking", category: "test", url: "", status: "down" },
      ],
    };
    const provider = collection.catalog.providers[0];
    if (!provider) throw new Error("Fixture provider missing");
    expect(runtimeForProvider(provider, collection, new Date(collection.generatedAt)).status).toBe(
      "down",
    );
    const aggregate = collection.integrationHealth.results[1];
    if (!aggregate) throw new Error("Fixture aggregate missing");
    aggregate.status = "up";
    expect(
      runtimeForProvider(provider, collection, new Date("2026-09-10T12:02:00.000Z")).status,
    ).toBe("unknown");
    expect(
      runtimeForProvider(provider, collection, new Date("2026-09-10T11:59:00.000Z")).status,
    ).toBe("unknown");
  });

  it("does not combine fresh data outside the region with stale local data", async () => {
    const local = {
      ...makeStream("2026-09-10T11:59:00.000Z"),
      owner: { kind: "integration" as const, id: "parking" },
      domain: "parking" as const,
      region: {
        keys: [REGION.key],
        bounds: [10, 50, 11, 51] as const,
        basis: "published-region" as const,
        relation: "unknown" as const,
      },
    };
    const remote = {
      ...local,
      key: "remote",
      policy: { ...local.policy, staleAt: "2026-09-10T13:00:00.000Z" },
      region: { ...local.region, keys: ["extract:remote"], bounds: [0, 0, 1, 1] as const },
    };
    const collection = makeCollection(local);
    collection.regions = [{ ...REGION, bounds: [10, 50, 11, 51] }];
    collection.streams = [local, remote];
    collection.catalog = buildCoverageCatalog([integration()]);
    collection.policy = { allowGreyArea: true, allowNonCommercial: true };
    collection.integrationHealth = {
      updatedAt: Date.parse(collection.generatedAt),
      results: [{ id: "parking", name: "parking", category: "test", url: "", status: "up" }],
    };
    const service = createCoverageService({
      now: () => new Date(collection.generatedAt),
      collector: async () => collection,
    });
    const report = await service.report({ regionId: REGION.key });
    const discovery = report.capabilities.find(
      (item) => item.operationId === "parking.facility-discovery",
    );
    expect(discovery).toMatchObject({ status: "limited", evidenceKeys: [local.key] });
    expect(report.summary.find((item) => item.domain === "parking")?.status).not.toBe(
      "operational",
    );
  });

  it("requires pinned continuation pages and permits attention views on a matrix revision", async () => {
    const service = createCoverageService({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      collector: async () => makeCollection(makeStream("2026-09-10T13:00:00.000Z")),
    });
    await expect(service.report({ regionId: REGION.key, offset: 1 })).rejects.toMatchObject({
      code: "snapshot_required",
    });
    const matrix = await service.regions();
    await expect(
      service.report({ regionId: REGION.key, attention: true, snapshotId: matrix.snapshotId }),
    ).resolves.toMatchObject({ snapshotId: matrix.snapshotId });
  });
  it("retains evidence reasons when freshness is recomputed", () => {
    const stream = makeStream("2026-09-10T13:00:00.000Z");
    stream.reasons = ["source_partial"];
    expect(freshenStream(stream, new Date("2026-09-10T12:00:00.000Z")).reasons).toContain(
      "source_partial",
    );
  });

  it("returns the next freshness deadline and rechecks attention membership", async () => {
    let now = new Date("2026-09-10T12:00:00.000Z");
    const service = createCoverageService({
      now: () => now,
      collector: async () => makeCollection(makeStream("2026-09-10T13:00:00.000Z")),
    });

    const report = await service.report({ regionId: REGION.key });
    expect(report.nextDeadlineAt).toBe("2026-09-10T13:00:00.000Z");
    expect(report.sources[0]?.freshnessDeadline).toBe("2026-09-10T13:00:00.000Z");

    const attention = await service.report({ regionId: REGION.key, attention: true });
    expect(attention.sources).toEqual([]);
    now = new Date("2026-09-10T13:00:00.000Z");
    await expect(
      service.report({
        regionId: REGION.key,
        attention: true,
        snapshotId: attention.snapshotId,
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "snapshot_expired",
    });
  });

  it("keeps globally scoped evidence in the unassigned region", async () => {
    const regional = makeStream("2026-09-10T13:00:00.000Z");
    const unassigned = {
      ...makeStream("2026-09-10T13:00:00.000Z"),
      key: "service:data-manager:global",
      sourceId: "global-source",
      region: { keys: [], basis: "unknown" as const, relation: "unknown" as const },
    };
    const collection = {
      ...makeCollection(regional),
      streams: [regional, unassigned],
      unassignedSourceCount: 1,
      regions: [
        REGION,
        { key: "unassigned", label: "Region not specified", kind: "unassigned" as const },
      ],
    };
    const service = createCoverageService({
      now: () => new Date("2026-09-10T12:00:00.000Z"),
      collector: async () => collection,
    });

    const report = await service.report({ regionId: REGION.key });
    expect(report.sources.map((source) => source.key)).toEqual([regional.key]);

    const regions = await service.regions();
    expect(regions.regions.find((entry) => entry.region.key === REGION.key)?.sourceCount).toBe(1);
    expect(regions.regions.find((entry) => entry.region.key === "unassigned")?.sourceCount).toBe(1);
  });
});
