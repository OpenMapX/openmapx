import { createApiClient } from "@openmapx/core";
import { getAdminActivityJob, listAdminActivityJobs } from "@openmapx/core/api-admin-sdk";
import { adminJobStreamEventSchemas } from "@openmapx/core/api-contracts";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import Fastify from "fastify";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { adminJob } from "../../db/schema";
import { installAdminRouteMocks } from "./admin-test-helpers";
import { administrationSdkFetch } from "./helpers/administration-sdk-fetch";

const authSecret = vi.hoisted(() => {
  const previous = process.env.BETTER_AUTH_SECRET;
  process.env.BETTER_AUTH_SECRET ??= "cancel-pending-unit-only-secret";
  return { previous };
});
afterAll(() => {
  if (authSecret.previous === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = authSecret.previous;
});
installAdminRouteMocks();
const cancelOperations = vi.fn();
vi.mock("../../services/admin-job-ops", () => ({
  cancelAdminJobOperations: (...args: unknown[]) => cancelOperations(...args),
}));

afterEach(() => vi.unstubAllGlobals());

it("keeps the real runner's durable pending outcome observable through Fastify and the generated SDK", async () => {
  const at = "2026-10-19 10:00:00"; // PostgreSQL timestamp-without-time-zone driver value.
  const row = {
    id: "pending-job",
    type: "data.operation",
    status: "running",
    payload: { operation: "link" },
    result: {
      opsProjection: { version: 1, eventTotal: 0, byteTotal: 0, truncated: false, operations: {} },
    },
    error: null,
    progress: 10,
    createdBy: null,
    createdAt: at,
    startedAt: at,
    finishedAt: null,
  };
  // Only the persistence boundary is replaced. Real Drizzle queries, projections,
  // runner, event bus, routes, serializers and generated SDK all execute.
  const database = drizzle(async (sql, params) => {
    if (sql.startsWith('update "admin_job"')) {
      if (params[0] === "canceled") return { rows: [] }; // The row is running, not queued.
      if (params[0] !== "cancel_pending") throw new Error(`Unexpected update: ${sql}`);
      row.status = "cancel_pending";
      return {
        rows: [Object.keys(getTableColumns(adminJob)).map((key) => row[key as keyof typeof row])],
      };
    }
    if (sql.startsWith('select "status", "result"')) return { rows: [[row.status, row.result]] };
    if (sql.includes("union all")) {
      const included = !sql.includes('"admin_job"."status" in') || params.includes(row.status);
      return {
        rows: included
          ? [
              [
                "application",
                row.id,
                row.type,
                row.status,
                row.payload,
                row.error,
                row.progress,
                row.createdBy,
                null,
                row.createdAt,
                row.startedAt,
                row.finishedAt,
                true,
              ],
            ]
          : [],
      };
    }
    if (sql.startsWith("select count(*)")) {
      const included =
        sql.includes('from "admin_job"') && (!params.length || params.includes(row.status));
      return { rows: [[included ? 1 : 0]] };
    }
    if (sql.includes('from "admin_job_log"')) return { rows: [] };
    if (sql.includes('from "admin_job"')) {
      return {
        rows: [Object.keys(getTableColumns(adminJob)).map((key) => row[key as keyof typeof row])],
      };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  vi.doMock("../../db", () => ({ db: database }));
  const { jobRunner } = await import("../../services/job-runner");
  const { jobEventBus } = await import("../../services/job-events");
  const { adminActivityRoute } = await import("../admin-activity");
  const app = Fastify();
  await app.register(adminActivityRoute, { prefix: "/api" });
  vi.stubGlobal("fetch", administrationSdkFetch(app));
  const client = createApiClient({ baseUrl: "https://app.test", credentials: "include" });
  const events: unknown[] = [];
  const unsubscribe = jobEventBus.subscribe(row.id, (stored) => events.push(stored.event));
  try {
    cancelOperations.mockResolvedValue("pending");
    await expect(jobRunner.cancel(row.id)).resolves.toBe(false);
    expect(row.status).toBe("cancel_pending");
    expect(events).toEqual([{ type: "status", status: "cancel_pending" }]);
    expect.soft(adminJobStreamEventSchemas.status.safeParse(events[0]).success).toBe(true);
    expect(adminJobStreamEventSchemas.end.safeParse({ status: row.status }).success).toBe(false);
    for (const params of [undefined, { status: "active" as const }]) {
      expect.soft(await listAdminActivityJobs(params, { client })).toMatchObject({
        status: 200,
        data: { total: 1, jobs: [{ id: row.id, status: "cancel_pending" }] },
      });
    }
    expect
      .soft(await getAdminActivityJob(row.id, { source: "application" }, { client }))
      .toMatchObject({
        status: 200,
        data: {
          ...row,
          result: {}, // Internal operation/authority state is never public Activity data.
          createdAt: "2026-10-19T10:00:00.000Z",
          startedAt: "2026-10-19T10:00:00.000Z",
          source: "application",
          cancelable: false,
          logs: [],
          stages: [],
        },
      });
  } finally {
    unsubscribe();
    await app.close();
    vi.doUnmock("../../db");
  }
});
