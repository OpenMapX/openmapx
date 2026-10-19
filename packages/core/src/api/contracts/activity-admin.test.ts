import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network");
  }),
);
afterEach(() => vi.unstubAllGlobals());

import {
  activityAdminOperations,
  adminActivityJobDetailSchema,
  adminActivityJobStreamQuerySchema,
  adminActivityJobsQuerySchema,
  adminActivityJobsResponseSchema,
  adminJobStreamEventSchemas,
} from "./activity-admin";

const at = "2026-10-19T12:00:00.000Z";
const base = {
  id: "job/1",
  type: "sync",
  status: "running",
  payload: { nested: [null, true, { arbitrary: 2 }] },
  error: null,
  progress: null,
  createdBy: null,
  actorLabel: "System",
  createdAt: at,
  startedAt: at,
  finishedAt: null,
  cancelable: false,
};
describe("activity administration wire contracts", () => {
  it("covers all five producer operations including metrics and streams", () => {
    expect(
      Object.entries(activityAdminOperations).map(([id, op]) => [id, op.method, op.path]),
    ).toEqual([
      ["listAdminActivityJobs", "GET", "/api/admin/jobs"],
      ["getAdminActivityJob", "GET", "/api/admin/jobs/:id"],
      ["cancelAdminActivityJob", "POST", "/api/admin/jobs/:id/cancel"],
      ["getAdminActivityJobStreamMetrics", "GET", "/api/admin/jobs/stream-metrics"],
      ["streamAdminActivityJobEvents", "GET", "/api/admin/jobs/:id/events"],
    ]);
  });
  it("retains serialized nested JSON, complete actors, log and stage rows and source statuses", () => {
    const list = {
      jobs: [
        {
          ...base,
          source: "data-manager",
          status: "interrupted",
          actor: { id: "user", name: "A", email: "a@example.test" },
        },
      ],
      total: 1,
    };
    expect(adminActivityJobsResponseSchema.parse(list)).toEqual(list);
    const app = {
      ...base,
      source: "application",
      cancelable: true,
      result: [1, { untouched: [false, null] }],
      logs: [{ id: "log", jobId: base.id, seq: 1, stream: "stderr", line: "line", createdAt: at }],
      stages: [],
    };
    expect(adminActivityJobDetailSchema.parse(app)).toEqual(app);
    const stage = {
      id: "stage",
      jobId: base.id,
      stage: "fetch",
      status: "partial",
      startedAt: at,
      finishedAt: at,
      durationMs: 100,
      message: "partial",
      error: { nested: ["reason"] },
      artifacts: [{ extra: { unrecognized: true } }],
    };
    const dm = {
      ...base,
      source: "data-manager",
      status: "partial",
      result: null,
      logs: [],
      stages: [stage],
    };
    expect(adminActivityJobDetailSchema.parse(dm)).toEqual(dm);
    expect(adminActivityJobDetailSchema.safeParse({ ...app, result: new Date() }).success).toBe(
      false,
    );
    expect(adminActivityJobDetailSchema.safeParse({ ...app, createdAt: "yesterday" }).success).toBe(
      false,
    );
  });
  it("rejects reserved JSON own keys instead of silently dropping root or nested data", () => {
    for (const raw of ['{"__proto__":{"secret":"value"}}', '{"nested":[{"__proto__":null}]}']) {
      const result = JSON.parse(raw);
      const app = { ...base, source: "application", result, logs: [], stages: [] };
      const parsed = adminActivityJobDetailSchema.safeParse(app);
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(JSON.stringify(parsed.error.issues)).not.toContain("secret");
    }
  });
  it("parses bounded numeric queries and defaults while rejecting coercible malformed inputs", () => {
    expect(adminActivityJobsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
    expect(adminActivityJobsQuerySchema.parse({ limit: "200", offset: "5" })).toEqual({
      limit: 200,
      offset: 5,
    });
    expect(adminActivityJobStreamQuerySchema.parse({ cursor: "2" })).toEqual({ cursor: 2 });
    for (const value of [
      null,
      "",
      " ",
      [],
      ["1"],
      true,
      "1x",
      "1.5",
      "-1",
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(adminActivityJobsQuerySchema.safeParse({ offset: value }).success).toBe(false);
      expect(adminActivityJobStreamQuerySchema.safeParse({ cursor: value }).success).toBe(false);
    }
    for (const limit of [0, 201])
      expect(adminActivityJobsQuerySchema.safeParse({ limit }).success).toBe(false);
  });
  it("validates each named SSE payload independently without accepting cross-event shapes", () => {
    expect(
      adminJobStreamEventSchemas.progress.safeParse({ type: "status", status: "success" }).success,
    ).toBe(false);
    expect(
      adminJobStreamEventSchemas.status.parse({
        type: "status",
        status: "success",
        result: [null, { nested: true }],
        finishedAt: at,
      }),
    ).toEqual({
      type: "status",
      status: "success",
      result: [null, { nested: true }],
      finishedAt: at,
    });
    expect(adminJobStreamEventSchemas.end.safeParse({ status: "running" }).success).toBe(false);
    expect(adminJobStreamEventSchemas.overflow.parse({ reason: "slow consumer" })).toEqual({
      reason: "slow consumer",
    });
  });
});
