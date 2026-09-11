import type { AuthorityObservation, CoverageRegion, StreamEvidence } from "@openmapx/core/coverage";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ||= "coverage-route-test-secret";
});

import type { CoverageCollection } from "../../services/coverage/collect.js";
import { CoverageCollectionUnavailableError } from "../../services/coverage/collect.js";
import { createCoverageService } from "../../services/coverage/service.js";
import { createAdminTestApp, installAdminRouteMocks } from "./admin-test-helpers.js";

const { requireAdmin, session } = installAdminRouteMocks();

const NOW = new Date("2026-09-10T12:00:00.000Z");
const REGION: CoverageRegion = {
  key: "extract:europe/germany",
  label: "Germany extract",
  kind: "extract",
};

function stream(): StreamEvidence {
  return {
    key: "service:data-manager:test:search",
    owner: { kind: "service", id: "data-manager" },
    sourceId: "test-search",
    stream: "search-index",
    domain: "pois",
    observedAt: NOW.toISOString(),
    evidenceVersion: 1,
    presence: "present",
    region: {
      keys: [REGION.key],
      basis: "published-region",
      relation: "unknown",
    },
    publication: {
      version: "epoch-1",
      publishedAt: NOW.toISOString(),
      active: true,
    },
    attempt: { at: NOW.toISOString(), outcome: "succeeded" },
    lastSuccessfulCheckAt: NOW.toISOString(),
    lastSuccessfullyCheckedVersion: "epoch-1",
    upstreamAsOf: NOW.toISOString(),
    expiresAt: null,
    policy: {
      basis: "test",
      staleAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
      expiresAt: null,
      version: "test-1",
      provenance: "test fixture",
    },
    freshness: "current",
    reasons: [],
  };
}

function collection(): CoverageCollection {
  const authorities: AuthorityObservation[] = [
    { authority: "data-manager", status: "available", observedAt: NOW.toISOString() },
  ];
  return {
    generatedAt: NOW.toISOString(),
    collectionStatus: "complete",
    authorities,
    warnings: [],
    regions: [REGION],
    streams: [stream()],
    catalog: { integrations: [], providers: [], rights: [] },
    integrationHealth: { updatedAt: NOW.getTime(), results: [] },
    providerHealth: new Map(),
    bindings: new Map(),
    policy: null,
    unassignedSourceCount: 0,
    dataManagerSnapshotId: "dm-snapshot-1",
  };
}

function serviceFor(value: CoverageCollection = collection()) {
  return createCoverageService({
    now: () => NOW,
    collector: vi.fn().mockResolvedValue(value),
  });
}

let app: FastifyInstance;

beforeAll(async () => {
  const { adminCoverageRoute } = await import("../admin-coverage.js");
  app = await createAdminTestApp(adminCoverageRoute, { coverageService: serviceFor() });
});

afterAll(() => app.close());
beforeEach(() => requireAdmin.mockResolvedValue(session));

describe("admin coverage routes", () => {
  it("returns a private region matrix and pins a report revision", async () => {
    const regions = await app.inject({ method: "GET", url: "/admin/coverage/regions" });
    expect(regions.statusCode).toBe(200);
    expect(regions.headers["cache-control"]).toBe("private, no-store");
    expect(regions.json()).toMatchObject({
      schemaVersion: 1,
      collectionStatus: "complete",
      regions: [{ region: { key: REGION.key } }],
    });

    const report = await app.inject({
      method: "GET",
      url: `/admin/coverage?regionId=${encodeURIComponent(REGION.key)}&limit=1`,
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({
      schemaVersion: 1,
      region: { key: REGION.key },
      sourcePagination: { limit: 1, snapshotId: expect.any(String) },
    });
  });

  it("serves source details from the report revision", async () => {
    const report = await app.inject({
      method: "GET",
      url: `/admin/coverage?regionId=${encodeURIComponent(REGION.key)}`,
    });
    const snapshotId = report.json().snapshotId as string;
    const detail = await app.inject({
      method: "GET",
      url: `/admin/coverage/source?key=${encodeURIComponent(stream().key)}&regionId=${encodeURIComponent(REGION.key)}&snapshotId=${snapshotId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      snapshotId,
      source: { key: stream().key },
      evidence: { publication: { version: "epoch-1" } },
    });
  });

  it("distinguishes malformed input from unknown resources", async () => {
    const malformed = await app.inject({
      method: "GET",
      url: "/admin/coverage?regionId=../secret",
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({ error: "regionId_invalid" });

    const missing = await app.inject({ method: "GET", url: "/admin/coverage?regionId=country:XX" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "region_not_found" });

    const overLimit = await app.inject({
      method: "GET",
      url: "/admin/coverage?regionId=country:XX&limit=101",
    });
    expect(overLimit.statusCode).toBe(400);
  });

  it("returns 409 when a pinned revision has expired", async () => {
    const expired = await app.inject({
      method: "GET",
      url: `/admin/coverage?regionId=${encodeURIComponent(REGION.key)}&snapshotId=${"a".repeat(32)}`,
    });
    expect(expired.statusCode).toBe(409);
    expect(expired.json()).toEqual({ error: "snapshot_expired" });
  });

  it("maps total evidence loss to 503", async () => {
    const { adminCoverageRoute } = await import("../admin-coverage.js");
    const unavailable = createCoverageService({
      now: () => NOW,
      collector: async () => {
        throw new CoverageCollectionUnavailableError("data-manager unavailable");
      },
    });
    const isolated = await createAdminTestApp(adminCoverageRoute, { coverageService: unavailable });
    const response = await isolated.inject({
      method: "GET",
      url: `/admin/coverage?regionId=${encodeURIComponent(REGION.key)}`,
    });
    await isolated.close();
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "coverage_unavailable" });
  });

  it("honours the full-admin guard", async () => {
    requireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Authentication required"), { statusCode: 401 }),
    );
    const unauthenticated = await app.inject({ method: "GET", url: "/admin/coverage/regions" });
    expect(unauthenticated.statusCode).toBe(401);

    requireAdmin.mockRejectedValueOnce(
      Object.assign(new Error("Admin access required"), { statusCode: 403 }),
    );
    const forbidden = await app.inject({ method: "GET", url: "/admin/coverage/regions" });
    expect(forbidden.statusCode).toBe(403);
  });
});
