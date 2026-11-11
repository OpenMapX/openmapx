import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const policySnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    schemaVersion: 1,
    authoritative: true,
    revision: "p1",
    evaluatedAt: "2026-09-11T12:00:00Z",
    validUntil: "2026-09-11T12:02:30Z",
    disallowedSourceIds: ["denied"],
    allowGreyArea: true,
    allowNonCommercial: false,
  })),
);
vi.mock("../../services/data-use-policy.js", () => ({
  getRoadConditionsPolicySnapshot: policySnapshot,
}));

const fakeDb = vi.hoisted(() => ({
  state: {
    lastJob: null as unknown,
    feedCount: 0,
    byRegion: [] as Array<{ region: string; total: number }>,
    byStatus: [] as Array<{ status: string; total: number }>,
    currentJob: null as unknown,
  },
  /**
   * The route issues five drizzle queries in `/state`. We answer them in
   * the order they fire by tracking a counter; each call returns a
   * builder whose terminal `.limit()` / `.groupBy()` resolves to the
   * appropriate dataset.
   */
  callIndex: 0,
  /** Each select's `where` condition, rendered later through drizzle's dialect. */
  conditions: [] as unknown[],
  orderings: [] as unknown[][],
}));

// The pin is the agent's; /state reads it through the api role's read-only
// operation, as the agent authorizes it: any other kind is refused, as
// transitousLock.inspect is for the api role.
vi.mock("../../services/ops-client.js", async () => {
  const { authorizeOpsOperation } = await import("@openmapx/core/ops");
  const pin = {
    ref: "main@abc123def456",
    submodules: { "transitland-atlas": "deadbeef" },
    lockedAt: "2026-05-01T00:00:00.000Z",
    lockedBy: "tester",
  };
  return {
    createApiOpsClient: vi.fn(() => ({}) as never),
    createDurableOpsKey: vi.fn(() => "opk1_datamanagerstatefixture0000"),
    executeAndWait: vi.fn(async (_client: unknown, operation: { kind: string }) => {
      if (!authorizeOpsOperation("api", operation.kind as never)) {
        throw new Error(`${operation.kind} is not permitted for the api role`);
      }
      if (operation.kind !== "transitousPin.inspect") throw new Error("unexpected operation");
      return { release: { ...pin, ref: "main@release0000000" }, active: pin };
    }),
  };
});

vi.mock("../../auth", () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("../../db/index.js", () => {
  function tailBuilder(resolveTo: () => unknown) {
    // The builder is itself thenable, so awaiting any node in the chain
    // resolves to the same dataset — drizzle uses this trick to support
    // both `.from(table)` (chainable) and `await db.select().from(table)`
    // (no `where`/`orderBy`) call sites.
    const builder = {
      from() {
        return builder;
      },
      where(condition: unknown) {
        fakeDb.conditions.push(condition);
        return builder;
      },
      orderBy(...columns: unknown[]) {
        fakeDb.orderings.push(columns);
        return builder;
      },
      groupBy() {
        return builder;
      },
      limit() {
        return builder;
      },
      offset() {
        return builder;
      },
      // biome-ignore lint/suspicious/noThenProperty: drizzle builders are thenable; the stub must mirror that or `await db.select().from(...)` resolves to the builder object itself.
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(resolveTo()).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return {
    db: {
      select() {
        const idx = fakeDb.callIndex++;
        const s = fakeDb.state;
        return tailBuilder(() => {
          // Order matches the order in `dataManagerRoute`'s /state Promise.all:
          // 0: lastJobRow, 1: feedCountRow, 2: regionRows, 3: statusRows, 4: currentRows
          switch (idx) {
            case 0:
              return s.lastJob ? [s.lastJob] : [];
            case 1:
              return [{ total: s.feedCount }];
            case 2:
              return s.byRegion;
            case 3:
              return s.byStatus;
            case 4:
              return s.currentJob ? [s.currentJob] : [];
            default:
              return [];
          }
        });
      },
    },
    sql: {},
  };
});

let app: FastifyInstance;
let repoRootDir: string;

beforeAll(async () => {
  repoRootDir = mkdtempSync(join(tmpdir(), "openmapx-dm-state-"));
  vi.stubEnv("OPENMAPX_ROOT_DIR", repoRootDir);
  vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "test-token");

  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

afterAll(async () => {
  try {
    await app?.close();
  } finally {
    vi.unstubAllEnvs();
    if (repoRootDir) rmSync(repoRootDir, { recursive: true, force: true });
  }
});

beforeEach(() => {
  fakeDb.callIndex = 0;
  fakeDb.conditions = [];
  fakeDb.orderings = [];
  fakeDb.state = {
    lastJob: null,
    feedCount: 0,
    byRegion: [],
    byStatus: [],
    currentJob: null,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderedConditions(): Array<{ sql: string; params: unknown[] }> {
  const dialect = new PgDialect();
  return fakeDb.conditions.map((condition) => dialect.sqlToQuery(condition as SQL));
}

describe("transit job filters", () => {
  it("reports the latest finished transit-sync run while a newer one is queued", async () => {
    fakeDb.state.lastJob = {
      id: "job-finished",
      kind: "transit-sync",
      status: "partial",
      startedAt: new Date("2026-11-09T03:00:00.000Z"),
      finishedAt: new Date("2026-11-09T03:40:00.000Z"),
      triggeredBy: "cron:data-manager-cron",
      idempotencyKey: null,
      metadata: null,
    };
    fakeDb.state.currentJob = {
      id: "job-queued",
      kind: "transit-sync",
      status: "queued",
      startedAt: new Date("2026-11-10T03:00:00.000Z"),
      finishedAt: null,
      triggeredBy: "cron:data-manager-cron",
      idempotencyKey: null,
      metadata: null,
    };

    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/state",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.json()).toMatchObject({
      lastSyncStatus: "partial",
      lastSyncAt: "2026-11-09T03:40:00.000Z",
      currentJob: { jobId: "job-queued", startedAt: "2026-11-10T03:00:00.000Z" },
    });
    const [last, current] = renderedConditions().filter((query) => query.sql.includes('"kind"'));
    expect(last?.sql).toContain("not in");
    expect(last?.params).toEqual(["transit-sync", "queued", "running", "cancel_pending"]);
    expect(current?.sql).not.toContain("not in");
    expect(current?.params).toEqual(["transit-sync", "queued", "running", "cancel_pending"]);
    const dialect = new PgDialect();
    const lastOrder = dialect.sqlToQuery(fakeDb.orderings[0]?.[0] as SQL).sql;
    expect(lastOrder).toContain('"finished_at" desc nulls last');
  });

  it("lists transit-sync jobs by default", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/jobs",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.statusCode).toBe(200);
    const kinds = renderedConditions().filter((query) => query.sql.includes('"kind"'));
    expect(kinds.map((query) => query.params)).toEqual([["transit-sync"], ["transit-sync"]]);
  });
});

describe("GET /data-manager/transit/state", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/data-manager/transit/state" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the merged lockfile + DB state under bearer token auth", async () => {
    fakeDb.state.lastJob = {
      id: "job-1",
      kind: "transit-sync",
      status: "ok",
      startedAt: new Date("2026-05-20T03:00:00.000Z"),
      finishedAt: new Date("2026-05-20T04:00:00.000Z"),
      triggeredBy: "cron:data-manager-cron",
      idempotencyKey: null,
      metadata: null,
    };
    fakeDb.state.feedCount = 42;
    fakeDb.state.byRegion = [
      { region: "de", total: 5 },
      { region: "ch", total: 3 },
    ];
    fakeDb.state.byStatus = [
      { status: "active", total: 38 },
      { status: "stale", total: 3 },
      { status: "failed", total: 1 },
    ];
    fakeDb.state.currentJob = null;

    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/state",
      headers: { authorization: "Bearer test-token" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.transitousRef).toBe("main@abc123def456");
    expect(body.lastSyncStatus).toBe("ok");
    expect(body.lastSyncAt).toBe("2026-05-20T04:00:00.000Z");
    expect(body.currentJob).toBeNull();
    expect(body.feedCount).toBe(42);
    expect(body.feeds).toEqual({
      byRegion: { de: 5, ch: 3 },
      byStatus: { active: 38, stale: 3, failed: 1 },
    });
  });

  it("surfaces an active running job in `currentJob`", async () => {
    // The last-sync query reads finished runs only; with none, it returns no row.
    fakeDb.state.lastJob = null;
    fakeDb.state.currentJob = {
      id: "job-running",
      kind: "transit-sync",
      status: "running",
      startedAt: new Date("2026-05-21T03:00:00.000Z"),
      finishedAt: null,
      triggeredBy: "api:user:alice",
      idempotencyKey: null,
      metadata: null,
    };

    const res = await app.inject({
      method: "GET",
      url: "/data-manager/transit/state",
      headers: { authorization: "Bearer test-token" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    expect(body.currentJob).toEqual({
      jobId: "job-running",
      startedAt: "2026-05-21T03:00:00.000Z",
    });
    expect(body.lastSyncStatus).toBeNull();
  });
});

describe("GET /data-manager/road-conditions/policy", () => {
  it("requires service authentication before reading the authority", async () => {
    policySnapshot.mockClear();
    const response = await app.inject({
      method: "GET",
      url: "/data-manager/road-conditions/policy",
    });
    expect(response.statusCode).toBe(401);
    expect(policySnapshot).not.toHaveBeenCalled();
  });
  it("returns a bounded authority lease without invoking jobs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/data-manager/road-conditions/policy",
      headers: { authorization: "Bearer test-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      authoritative: true,
      revision: "p1",
      disallowedSourceIds: ["denied"],
      allowGreyArea: true,
      allowNonCommercial: false,
    });
    expect(fakeDb.callIndex).toBe(0);
  });
});
