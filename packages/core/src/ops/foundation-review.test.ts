import { describe, expect, it } from "vitest";
import {
  authorizeOpsResources,
  OPS_KIND_POLICIES,
  OPS_OPERATION_KINDS,
  type OpsOperation,
  type OpsResourcePolicy,
  parseBoundedOpsResult,
  parseOpsEventBatch,
  parseOpsJobStatus,
  parseOpsJobStatusForKind,
  parseOpsResult,
} from "./contract";

const requiredKinds = [
  "service.logs.follow",
  "service.update",
  "service.build",
  "services.buildAll",
  "data.downloadOsm",
  "data.downloadFonts",
  "data.update",
  "data.convertOverpass",
  "data.link",
  "data.clean",
  "data.generateApiKeys",
  "data.overtureSync",
  "data.overtureConflate",
  "data.searchIndexBuild",
  "system.update",
  "serviceRepository.inspect",
  "serviceRepository.publish",
  "serviceRepository.settle",
  "serviceRepository.remove",
  "communityServices.inspect",
  "serviceSelection.apply",
  "serviceConfig.apply",
  "integrationConfig.apply",
  "vault.apply",
] as const;

describe("reviewed ops foundation contract", () => {
  it("covers every discovered API authority effect with an owner and execution budget", () => {
    for (const kind of requiredKinds) expect(OPS_OPERATION_KINDS).toContain(kind);
    expect(Object.keys(OPS_KIND_POLICIES).sort()).toEqual([...OPS_OPERATION_KINDS].sort());
    // Exact existing long-running owners, plus the approved ownership-only
    // maintenance hour. Every other kind retains the original 30 minute cap.
    const extendedBudgets: Record<string, number> = {
      "configurationMaintenance.prepare": 3600_000,
      "service.build": 12 * 3600_000,
      "services.buildAll": 24 * 3600_000,
      "system.update": 48 * 3600_000,
      "data.downloadOsm": 24 * 3600_000,
      "data.downloadFonts": 24 * 3600_000,
      "data.update": 24 * 3600_000,
      "data.convertOverpass": 24 * 3600_000,
      "data.overtureSync": 24 * 3600_000,
      "data.overtureConflate": 24 * 3600_000,
      "data.searchIndexBuild": 24 * 3600_000,
      "data.notablePlacesBuild": 24 * 3600_000,
    };
    for (const [kind, timeoutMs] of Object.entries(extendedBudgets))
      expect(OPS_KIND_POLICIES[kind as keyof typeof OPS_KIND_POLICIES].timeoutMs).toBe(timeoutMs);
    for (const [kind, policy] of Object.entries(OPS_KIND_POLICIES)) {
      expect(policy.role === "api" || policy.role === "data-manager").toBe(true);
      expect(policy.execution === "sync" || policy.execution === "async").toBe(true);
      expect(policy.timeoutMs).toBeGreaterThan(0);
      expect(policy.timeoutMs).toBeLessThanOrEqual(extendedBudgets[kind] ?? 30 * 60_000);
      expect(policy.maxResultBytes).toBeGreaterThan(0);
      expect(policy.maxResultBytes).toBeLessThanOrEqual(1024 * 1024);
    }
    expect(OPS_KIND_POLICIES["configurationMaintenance.prepare"]).toMatchObject({
      role: "api",
      execution: "async",
      timeoutMs: 60 * 60_000,
    });
    for (const kind of [
      "service.logs.follow",
      "service.pull",
      "service.restart",
      "release.pull",
      "release.apply",
      "appApi.replace",
      "agent.update",
      "system.update",
      "serviceRepository.inspect",
      "serviceRepository.publish",
    ] as const) {
      expect(OPS_KIND_POLICIES[kind].execution).toBe("async");
    }
  });

  it("strictly validates the exact result schema for the requested kind", () => {
    expect(parseOpsResult("docker.status", { reachable: true, version: "29.0.0" })).toEqual({
      reachable: true,
      version: "29.0.0",
    });
    expect(() => parseOpsResult("docker.status", { output: "raw", secret: "x" })).toThrow();
    expect(parseOpsResult("service.restart", { changed: true })).toEqual({ changed: true });
    expect(() => parseOpsResult("service.restart", { changed: true, output: "raw" })).toThrow();
    const bounded = { lines: ["é"], truncated: false };
    const exactBytes = Buffer.byteLength(JSON.stringify(bounded), "utf8");
    expect(parseBoundedOpsResult("service.logs", bounded, exactBytes)).toEqual(bounded);
    expect(() => parseBoundedOpsResult("service.logs", bounded, exactBytes - 1)).toThrow();
  });

  it("defines bounded typed async status and event batches", () => {
    expect(
      parseOpsJobStatus({
        version: 1,
        operationId: "job1_0123456789abcdef",
        operationKey: "opk1_0123456789abcdef",
        kind: "service.pull",
        resourceId: "motis",
        state: "running",
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
      }),
    ).toMatchObject({ state: "running", kind: "service.pull" });
    expect(
      parseOpsEventBatch({
        version: 1,
        operationId: "job1_0123456789abcdef",
        nextCursor: 2,
        terminal: false,
        truncated: false,
        events: [
          { cursor: 1, type: "state", state: "running" },
          { cursor: 2, type: "log", stream: "stdout", message: "pulling" },
        ],
      }),
    ).toMatchObject({ nextCursor: 2, terminal: false });
    expect(() =>
      parseOpsEventBatch({
        version: 1,
        operationId: "job1_0123456789abcdef",
        nextCursor: 1,
        terminal: false,
        truncated: false,
        events: [{ cursor: 1, type: "log", stream: "stdout", message: "x".repeat(4097) }],
      }),
    ).toThrow();
    expect(() =>
      parseOpsEventBatch({
        version: 1,
        operationId: "job1_0123456789abcdef",
        nextCursor: 1,
        terminal: false,
        truncated: false,
        events: [{ cursor: 1, type: "log", stream: "stdout", message: "😀".repeat(1_025) }],
      }),
    ).toThrow();
    expect(() =>
      parseOpsEventBatch({
        version: 1,
        operationId: "job1_0123456789abcdef",
        nextCursor: 0,
        terminal: false,
        events: [],
      }),
    ).toThrow();
    expect(
      parseOpsJobStatusForKind("service.pull", {
        version: 1,
        operationId: "job1_0123456789abcdef",
        operationKey: "opk1_0123456789abcdef",
        kind: "service.pull",
        resourceId: "motis",
        state: "succeeded",
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
        result: { changed: true },
      }).result,
    ).toEqual({ changed: true });
    expect(() =>
      parseOpsJobStatus({
        version: 1,
        operationId: "job1_0123456789abcdef",
        operationKey: "opk1_0123456789abcdef",
        kind: "service.pull",
        resourceId: "motis",
        state: "running",
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
        errorClass: "runtime",
      }),
    ).toThrow();
    expect(() =>
      parseOpsJobStatus({
        version: 1,
        operationId: "job1_0123456789abcdef",
        operationKey: "opk1_0123456789abcdef",
        kind: "service.pull",
        resourceId: "motis",
        state: "failed",
        submittedAt: "2026-08-23T18:00:00.000Z",
        updatedAt: "2026-08-23T18:00:01.000Z",
      }),
    ).toThrow();
  });

  it("uses operation-specific resource predicates and fails closed by default", async () => {
    await expect(authorizeOpsResources({ kind: "docker.status" })).resolves.toBe(false);
    await expect(
      authorizeOpsResources({ kind: "docker.status" }, { allowGlobal: () => true }),
    ).resolves.toBe(true);
    const operation: OpsOperation = { kind: "service.restart", serviceId: "motis" };
    await expect(authorizeOpsResources(operation)).resolves.toBe(false);
    const policy: OpsResourcePolicy = {
      allowService: (kind, serviceId) => kind === "service.restart" && serviceId === "motis",
    };
    await expect(authorizeOpsResources(operation, policy)).resolves.toBe(true);
    await expect(
      authorizeOpsResources({ kind: "service.restart", serviceId: "ops-agent" }, policy),
    ).resolves.toBe(false);
    await expect(
      authorizeOpsResources({ kind: "motis.primary.promote", preparedRunId: "run_20260823" }, {}),
    ).resolves.toBe(false);
  });
});
