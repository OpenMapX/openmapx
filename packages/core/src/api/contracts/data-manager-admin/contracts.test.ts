import { describe, expect, it } from "vitest";
import z from "zod/v4";
import {
  dataManagerAdminOperations,
  transitCatalogResponseSchema,
  transitFeedsQuerySchema,
  transitJobDetailSchema,
} from "./index";

describe("application data-manager administration contracts", () => {
  it("describes all 35 actual API operations with the real session-only distinctions", () => {
    expect(Object.keys(dataManagerAdminOperations)).toHaveLength(35);
    const operations = Object.values(dataManagerAdminOperations);
    expect(new Set(operations.map(({ method, path }) => `${method} ${path}`)).size).toBe(35);
    expect(operations.filter(({ auth }) => auth === "admin")).toHaveLength(20);
    expect(operations.every(({ path }) => path.startsWith("/api/"))).toBe(true);
    expect(dataManagerAdminOperations.getApiDataManagerTransitState.auth).toBe("service");
    expect(dataManagerAdminOperations.getApiDataManagerOvertureStatus.auth).toBe("admin");
    // Approved parity additions: literal identities remain independent of registry order.
    const additions = [
      ["getAdminTransitCredentials", "GET", "/api/admin/transit/credentials", "admin"],
      ["previewAdminTransitCredentials", "POST", "/api/admin/transit/credentials/preview", "admin"],
      ["applyAdminTransitCredentials", "PATCH", "/api/admin/transit/credentials", "admin"],
      ["getAdminTransitPins", "GET", "/api/admin/transit/pins", "admin"],
      ["proposeAdminTransitPins", "POST", "/api/admin/transit/pins/proposals", "admin"],
      [
        "validateAdminTransitPins",
        "POST",
        "/api/admin/transit/pins/proposals/:proposalId/validate",
        "admin",
      ],
      [
        "activateAdminTransitPins",
        "POST",
        "/api/admin/transit/pins/proposals/:proposalId/activate",
        "admin",
      ],
      [
        "cancelAdminTransitPinExecution",
        "DELETE",
        "/api/admin/transit/pins/executions/:id",
        "admin",
      ],
      ["getAdminTransitPinExecution", "GET", "/api/admin/transit/pins/executions/:id", "admin"],
      [
        "getApiDataManagerRoadConditionsPolicy",
        "GET",
        "/api/data-manager/road-conditions/policy",
        "service",
      ],
    ] as const;
    for (const [id, method, path, auth] of additions)
      expect(dataManagerAdminOperations[id]).toMatchObject({ method, path, auth });
  });
  it("keeps structured JSONB stage errors and nullable job metadata", () => {
    const job = {
      id: "j",
      kind: "transitous-sync",
      status: "failed",
      startedAt: "2026-10-19T00:00:00.000Z",
      finishedAt: null,
      trigger: "cron",
      triggeredByUserId: null,
      idempotencyKey: null,
      metadata: null,
      stages: [
        {
          id: "s",
          stage: "fetch",
          status: "error",
          startedAt: "2026-10-19T00:00:00.000Z",
          finishedAt: "2026-10-19T00:00:01.000Z",
          durationMs: 1000,
          message: null,
          error: { message: "failed", stack: "trace" },
          artifacts: { selected: ["de"] },
        },
      ],
    };
    expect(transitJobDetailSchema.parse(job)).toEqual(job);
  });
  it("rejects malformed pagination before database work and keeps existing ceilings", () => {
    expect(transitFeedsQuerySchema.safeParse({ limit: "no" }).success).toBe(false);
    expect(transitFeedsQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
    expect(transitFeedsQuerySchema.safeParse({ limit: "1.5" }).success).toBe(false);
    expect(transitFeedsQuerySchema.parse({ limit: "900", offset: "2" })).toMatchObject({
      limit: 500,
      offset: 2,
    });
  });
  it("models the merged catalog instead of internal pinned source rows", () => {
    const result = {
      sources: [
        {
          id: "catalog",
          installedSourceId: null,
          discoveryIds: ["catalog"],
          name: "Feed",
          source: "mobilitydb",
          countryCode: "de",
          url: "https://example.test/feed",
          licensing: { version: 1, bindings: [] },
          bbox: [5, 47, 15, 55],
          isOfficial: true,
        },
      ],
      total: 1,
      limit: 50,
      offset: 0,
    };
    expect(transitCatalogResponseSchema.parse(result)).toEqual(result);
    expect(
      transitCatalogResponseSchema.safeParse({
        sources: [{ id: "catalog", region: "de", name: "Feed", format: "gtfs", license: {} }],
        total: 1,
      }).success,
    ).toBe(false);
  });
  it("retains index absence and unsuccessful mutation outcomes in separate statuses", () => {
    expect(
      dataManagerAdminOperations.getApiDataManagerSearchIndexStatus.responses[404].schema.parse({
        error: "osm_search index not built",
      }),
    ).toEqual({ error: "osm_search index not built" });
    expect(
      dataManagerAdminOperations.getApiDataManagerSearchIndexStatus.responses[404].schema.safeParse(
        { ok: false, error: "osm_search index not built" },
      ).success,
    ).toBe(false);
    expect(
      dataManagerAdminOperations.postApiDataManagerTransitSync.responses[409].schema.parse({
        error: "Another data job is running. Try again when it finishes.",
        code: "IN_FLIGHT",
        existingJobId: null,
      }),
    ).toMatchObject({ existingJobId: null });
  });
  it("converts every request and response schema to representable JSON Schema", () => {
    for (const operation of Object.values(dataManagerAdminOperations)) {
      for (const schema of Object.values("request" in operation ? operation.request : {}))
        z.toJSONSchema(schema, { io: "output" });
      for (const { schema } of Object.values(operation.responses))
        z.toJSONSchema(schema, { io: "output" });
    }
  });
});
