import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
}));

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
      where() {
        return builder;
      },
      orderBy() {
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
  // Write a fake lockfile so /state can return the ref.
  const infraDir = join(repoRootDir, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(
    join(infraDir, "transitous.lock.json"),
    JSON.stringify({
      ref: "main@abc123def456",
      submodules: { "transitland-atlas": "deadbeef" },
      lockedAt: "2026-05-01T00:00:00.000Z",
      lockedBy: "tester",
    }),
    "utf-8",
  );
  process.env.OPENMAPX_ROOT_DIR = repoRootDir;
  process.env.DATA_MANAGER_AUTH_TOKEN = "test-token";

  const { dataManagerRoute } = await import("../data-manager.js");
  app = Fastify({ logger: false });
  await app.register(dataManagerRoute);
  await app.ready();
});

beforeEach(() => {
  fakeDb.callIndex = 0;
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

describe("GET /data-manager/transit/state", () => {
  it("returns 401 without auth", async () => {
    const res = await app.inject({ method: "GET", url: "/data-manager/transit/state" });
    expect(res.statusCode).toBe(401);
  });

  it("returns the merged lockfile + DB state under bearer token auth", async () => {
    fakeDb.state.lastJob = {
      id: "job-1",
      kind: "transitous-sync",
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
    fakeDb.state.lastJob = {
      id: "job-running",
      kind: "transitous-sync",
      status: "running",
      startedAt: new Date("2026-05-21T03:00:00.000Z"),
      finishedAt: null,
      triggeredBy: "api:user:alice",
      idempotencyKey: null,
      metadata: null,
    };
    fakeDb.state.currentJob = {
      id: "job-running",
      kind: "transitous-sync",
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
