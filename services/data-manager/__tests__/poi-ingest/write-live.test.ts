import type { PoiLiveState, RegisteredPoiSource } from "@openmapx/poi-source-registry";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { buildPoiJobContext } from "../../src/jobs/poi-ingest/pipeline.js";
import { run as runWriteLive } from "../../src/jobs/poi-ingest/stages/write-live.js";

type PipelineCall =
  | { op: "del"; key: string }
  | { op: "hset"; key: string; entries: Record<string, string> }
  | { op: "expire"; key: string; seconds: number };

interface FakeRedis {
  redis: Redis;
  calls: PipelineCall[];
  flushCount(): number;
}

function makeFakeRedis(): FakeRedis {
  const calls: PipelineCall[] = [];
  let flushes = 0;
  const pipeline = {
    del(key: string) {
      calls.push({ op: "del", key });
      return pipeline;
    },
    hset(key: string, entries: Record<string, string>) {
      calls.push({ op: "hset", key, entries });
      return pipeline;
    },
    expire(key: string, seconds: number) {
      calls.push({ op: "expire", key, seconds });
      return pipeline;
    },
    async exec() {
      flushes++;
      return calls.map(() => [null, 1]);
    },
  };
  const redis = {
    multi: () => pipeline,
  } as unknown as Redis;
  return { redis, calls, flushCount: () => flushes };
}

const sqlStub = {
  unsafe: async () => [],
} as unknown as Sql;

function liveSource(ttl?: number): RegisteredPoiSource {
  return {
    id: "demo-live",
    stationIdPrefix: "demo-live:",
    domain: "ev-charging",
    name: "Demo",
    static: {
      cron: "0 4 * * *",
      fetch: { type: "http", url: "x" },
      parse: () => [],
    },
    live: {
      cron: "* * * * *",
      fetch: { type: "http", url: "x" },
      parse: () => new Map<string, PoiLiveState>(),
      ttlSeconds: ttl,
    },
  };
}

describe("write-live stage", () => {
  it.each([
    null,
    [],
    [[new Error("Redis failed"), null]],
    [
      [null, 1],
      [null, 1],
      [null, 0],
    ],
  ])("keeps the active association unknown for an invalid Redis result: %j", async (execution) => {
    const fake = makeFakeRedis();
    const pipeline = fake.redis.multi();
    vi.spyOn(pipeline, "exec").mockResolvedValue(execution as never);
    const unsafe = vi.fn(async (..._args: unknown[]) => []);
    const ctx = buildPoiJobContext({
      source: liveSource(),
      kind: "live",
      sql: { unsafe } as unknown as Sql,
      redis: { multi: () => pipeline } as unknown as Redis,
    });
    ctx.state.liveState = new Map([["station", { asOf: "2026-05-01T00:00:00Z", free: 1 }]]);
    expect((await runWriteLive(ctx)).status).toBe("error");
    expect(unsafe).toHaveBeenCalledTimes(2);
    const params = unsafe.mock.calls[1]?.[1] as unknown as unknown[];
    expect(JSON.parse(String(params[3]))).toMatchObject({
      activeAssociation: "unknown",
      lastAttempt: { outcome: "failed" },
    });
    expect(ctx.state.livePublicationVersion).toBeUndefined();
  });

  it("returns partial when Redis changed but its durable association could not be finalized", async () => {
    const fake = makeFakeRedis();
    const unsafe = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("Postgres lost"));
    const ctx = buildPoiJobContext({
      source: liveSource(),
      kind: "live",
      sql: { unsafe } as unknown as Sql,
      redis: fake.redis,
    });
    ctx.state.liveState = new Map();
    expect((await runWriteLive(ctx)).status).toBe("partial");
    expect(ctx.state.livePublicationVersion).toBeUndefined();
    expect(fake.flushCount()).toBe(1);
  });

  it("bounds freshness by the upstream clock and expires valid empty observations", async () => {
    for (const entries of [[], [["station", { asOf: "2026-05-01T00:00:00Z", free: 1 }]]] as Array<
      Array<[string, PoiLiveState]>
    >) {
      const fake = makeFakeRedis();
      const unsafe = vi.fn(async (..._args: unknown[]) => []);
      const ctx = buildPoiJobContext({
        source: liveSource(120),
        kind: "live",
        sql: { unsafe } as unknown as Sql,
        redis: fake.redis,
        now: () => "2026-05-01T00:01:00.000Z",
      });
      ctx.state.liveState = new Map(entries);
      expect((await runWriteLive(ctx)).status).toBe("ok");
      const params = unsafe.mock.calls[1]?.[1] as unknown[];
      expect(JSON.parse(String(params[3])).expiresAt).toBe(
        entries.length ? "2026-05-01T00:02:00.000Z" : "2026-05-01T00:03:00.000Z",
      );
    }
  });
  it("issues DEL + HSET + EXPIRE for non-empty live snapshots", async () => {
    const fake = makeFakeRedis();
    const ctx = buildPoiJobContext({
      source: liveSource(120),
      kind: "live",
      sql: sqlStub,
      redis: fake.redis,
      now: () => "2026-05-01T00:00:00.000Z",
    });
    ctx.state.liveState = new Map<string, PoiLiveState>([
      ["s1", { asOf: "2026-05-01T00:00:00Z", free: 3 }],
      ["s2", { asOf: "2026-05-01T00:00:00Z", free: 0 }],
    ]);

    const result = await runWriteLive(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts).toEqual({
      fieldCount: 2,
      key: "poi:live:demo-live",
      ttlSeconds: 120,
    });
    expect(fake.flushCount()).toBe(1);
    expect(fake.calls).toEqual([
      { op: "del", key: "poi:live:demo-live" },
      {
        op: "hset",
        key: "poi:live:demo-live",
        entries: {
          s1: JSON.stringify({ asOf: "2026-05-01T00:00:00Z", free: 3 }),
          s2: JSON.stringify({ asOf: "2026-05-01T00:00:00Z", free: 0 }),
        },
      },
      { op: "expire", key: "poi:live:demo-live", seconds: 120 },
    ]);
  });

  it("only DELs when the live snapshot is empty (no HSET, no EXPIRE)", async () => {
    const fake = makeFakeRedis();
    const ctx = buildPoiJobContext({
      source: liveSource(),
      kind: "live",
      sql: sqlStub,
      redis: fake.redis,
    });
    ctx.state.liveState = new Map();

    const result = await runWriteLive(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts).toEqual({
      fieldCount: 0,
      key: "poi:live:demo-live",
      ttlSeconds: 0,
    });
    expect(fake.calls).toEqual([{ op: "del", key: "poi:live:demo-live" }]);
  });

  it("returns skipped when ctx.redis is missing", async () => {
    const ctx = buildPoiJobContext({
      source: liveSource(),
      kind: "live",
      sql: sqlStub,
      redis: null,
    });
    ctx.state.liveState = new Map();
    const result = await runWriteLive(ctx);
    expect(result.status).toBe("skipped");
  });

  it("falls back to the 600s default TTL when no spec value is set", async () => {
    const fake = makeFakeRedis();
    const ctx = buildPoiJobContext({
      source: liveSource(),
      kind: "live",
      sql: sqlStub,
      redis: fake.redis,
    });
    ctx.state.liveState = new Map<string, PoiLiveState>([["s1", { asOf: "2026-05-01T00:00:00Z" }]]);
    const result = await runWriteLive(ctx);
    expect(result.status).toBe("ok");
    const expireCall = fake.calls.find((c) => c.op === "expire");
    expect(expireCall && "seconds" in expireCall && expireCall.seconds).toBe(600);
  });
});
