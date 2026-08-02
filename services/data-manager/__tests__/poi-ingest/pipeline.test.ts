import type { PoiLiveState, PoiRow, RegisteredPoiSource } from "@openmapx/poi-source-registry";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import {
  buildPoiJobContext,
  runBundledIngest,
  runLiveIngest,
  runStaticIngest,
} from "../../src/jobs/poi-ingest/pipeline.js";
import type { PoiIngestStageName } from "../../src/jobs/poi-ingest/types.js";

interface FakeSqlRecorder {
  sql: Sql;
  unsafeCalls: string[];
  beginCount: number;
}

function makeFakeSql(): FakeSqlRecorder {
  const unsafeCalls: string[] = [];
  let beginCount = 0;
  const callable = ((..._args: unknown[]) => Promise.resolve([])) as unknown as Sql;
  Object.assign(callable, {
    unsafe: async (query: string) => {
      unsafeCalls.push(query);
      return [];
    },
    begin: async (cb: (tx: unknown) => Promise<void>) => {
      beginCount++;
      await cb({
        unsafe: async (query: string) => {
          unsafeCalls.push(query);
        },
      });
    },
    json: (value: unknown) => value,
  });
  return {
    sql: callable,
    unsafeCalls,
    get beginCount() {
      return beginCount;
    },
  };
}

interface FakeRedisRecorder {
  redis: Redis;
  ops: string[];
}

function makeFakeRedis(): FakeRedisRecorder {
  const ops: string[] = [];
  const pipeline = {
    del: (key: string) => {
      ops.push(`del:${key}`);
      return pipeline;
    },
    hset: (key: string, entries: Record<string, string>) => {
      ops.push(`hset:${key}:${Object.keys(entries).join(",")}`);
      return pipeline;
    },
    expire: (key: string, ttl: number) => {
      ops.push(`expire:${key}:${ttl}`);
      return pipeline;
    },
    exec: async () => {
      ops.push("exec");
      return [];
    },
  };
  const redis = { multi: () => pipeline } as unknown as Redis;
  return { redis, ops };
}

function makeFetch(body: string): typeof fetch {
  return (async () =>
    new Response(body, { status: 200, statusText: "OK" })) as unknown as typeof fetch;
}

function makeFailFetch(): typeof fetch {
  return (async () =>
    new Response("nope", {
      status: 500,
      statusText: "Internal Server Error",
    })) as unknown as typeof fetch;
}

const sampleRows: PoiRow[] = [
  { poiId: "a", lng: 10.0, lat: 50.0, payload: { name: "A" } },
  { poiId: "b", lng: 11.0, lat: 51.0, payload: { name: "B" } },
];

function staticSource(): RegisteredPoiSource {
  return {
    id: "demo-static",
    stationIdPrefix: "demo-static:",
    domain: "ev-charging",
    name: "Demo Static",
    static: {
      cron: "0 4 * * *",
      fetch: { type: "http", url: "https://example.com/x.csv" },
      parse: () => sampleRows,
      minRowCount: 1,
    },
  };
}

function staticSourceWithBadParser(): RegisteredPoiSource {
  return {
    id: "demo-broken",
    stationIdPrefix: "demo-broken:",
    domain: "ev-charging",
    name: "Broken",
    static: {
      cron: "0 4 * * *",
      fetch: { type: "http", url: "x" },
      parse: () => {
        throw new Error("parser exploded");
      },
    },
  };
}

function liveSource(): RegisteredPoiSource {
  return {
    id: "demo-static",
    stationIdPrefix: "demo-static:",
    domain: "ev-charging",
    name: "Demo",
    static: {
      cron: "0 4 * * *",
      fetch: { type: "http", url: "x" },
      parse: () => [],
    },
    live: {
      cron: "* * * * *",
      fetch: { type: "http", url: "https://example.com/live.json" },
      parse: () =>
        new Map<string, PoiLiveState>([["a", { asOf: "2026-05-01T00:00:00Z", free: 3 }]]),
      ttlSeconds: 60,
    },
  };
}

function bundledSource(
  opts: { changeKey?: (rows: readonly PoiRow[]) => string } = {},
): RegisteredPoiSource {
  return {
    id: "demo-bundled",
    stationIdPrefix: "demo-bundled:",
    domain: "parking",
    name: "Demo Bundled",
    bundled: {
      cron: "*/5 * * * *",
      fetch: { type: "http", url: "https://example.com/bundle.xml" },
      parse: () => ({
        static: sampleRows,
        live: new Map<string, PoiLiveState>([["a", { asOf: "2026-05-01T00:00:00Z", free: 1 }]]),
      }),
      staticChangeKey: opts.changeKey,
      liveTtlSeconds: 90,
    },
  };
}

describe("pipeline (static)", () => {
  it("runs fetch → parse → validate → upsert-static → swap in order", async () => {
    const sqlRec = makeFakeSql();
    const ctx = buildPoiJobContext({
      source: staticSource(),
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: makeFetch("hello"),
      now: () => "2026-05-01T00:00:00.000Z",
    });
    const result = await runStaticIngest(ctx);
    expect(result.status).toBe("ok");
    expect(result.stages.map((s) => s.stage)).toEqual<PoiIngestStageName[]>([
      "fetch",
      "parse",
      "validate",
      "upsert-static",
      "swap",
    ]);
    expect(result.staticRowCount).toBe(2);
    expect(ctx.state.staticRows).toEqual(sampleRows);
    expect(sqlRec.beginCount).toBe(1);
  });

  it("halts the pipeline when parse throws and never swaps", async () => {
    const sqlRec = makeFakeSql();
    const ctx = buildPoiJobContext({
      source: staticSourceWithBadParser(),
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: makeFetch("anything"),
    });
    const result = await runStaticIngest(ctx);
    expect(result.status).toBe("error");
    const stageNames = result.stages.map((s) => s.stage);
    expect(stageNames).toContain("parse");
    expect(stageNames).not.toContain("swap");
    expect(stageNames).not.toContain("upsert-static");
    expect(sqlRec.beginCount).toBe(0);
  });

  it("returns partial when aborted between stages", async () => {
    const sqlRec = makeFakeSql();
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: typeof fetch = (async () => {
      calls++;
      // Abort right after the first (fetch) stage completes.
      controller.abort();
      return new Response("hello", { status: 200 });
    }) as unknown as typeof fetch;
    const ctx = buildPoiJobContext({
      source: staticSource(),
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: fetchImpl,
      abortSignal: controller.signal,
    });
    const result = await runStaticIngest(ctx);
    expect(calls).toBe(1);
    expect(result.status).toBe("partial");
    // Only the fetch stage should have recorded a result.
    expect(result.stages.map((s) => s.stage)).toEqual<PoiIngestStageName[]>(["fetch"]);
    expect(sqlRec.beginCount).toBe(0);
  });

  it("returns status=error when fetch HTTP fails", async () => {
    const sqlRec = makeFakeSql();
    const ctx = buildPoiJobContext({
      source: staticSource(),
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: makeFailFetch(),
    });
    const result = await runStaticIngest(ctx);
    expect(result.status).toBe("error");
    expect(result.stages[0]?.stage).toBe("fetch");
    expect(sqlRec.beginCount).toBe(0);
  });

  it("returns a fetch-stage error when a response exceeds its byte cap", async () => {
    const sqlRec = makeFakeSql();
    const source = staticSource();
    if (!source.static) throw new Error("static source missing");
    source.static.fetch.maxBytes = 10;
    const ctx = buildPoiJobContext({
      source,
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: makeFetch("x".repeat(100)),
    });
    const result = await runStaticIngest(ctx);
    expect(result.status).toBe("error");
    expect(result.stages[0]?.stage).toBe("fetch");
    expect(result.stages[0]?.status).toBe("error");
    expect(result.stages[0]?.message).toMatch(/exceeded max/);
  });
});

describe("pipeline (live)", () => {
  it("runs fetch → parse → write-live and reports liveRowCount", async () => {
    const sqlRec = makeFakeSql();
    const redisRec = makeFakeRedis();
    const ctx = buildPoiJobContext({
      source: liveSource(),
      kind: "live",
      sql: sqlRec.sql,
      redis: redisRec.redis,
      fetch: makeFetch("{}"),
    });
    const result = await runLiveIngest(ctx);
    expect(result.status).toBe("ok");
    expect(result.stages.map((s) => s.stage)).toEqual<PoiIngestStageName[]>([
      "fetch",
      "parse",
      "write-live",
    ]);
    expect(result.liveRowCount).toBe(1);
    expect(redisRec.ops).toContain("exec");
  });
});

describe("pipeline (bundled)", () => {
  it("runs all six stages on the happy path", async () => {
    const sqlRec = makeFakeSql();
    const redisRec = makeFakeRedis();
    const ctx = buildPoiJobContext({
      source: bundledSource(),
      kind: "bundled",
      sql: sqlRec.sql,
      redis: redisRec.redis,
      fetch: makeFetch("anything"),
    });
    const result = await runBundledIngest(ctx);
    expect(result.status).toBe("ok");
    expect(result.stages.map((s) => s.stage)).toEqual<PoiIngestStageName[]>([
      "fetch",
      "parse",
      "validate",
      "upsert-static",
      "swap",
      "write-live",
    ]);
    expect(result.staticRowCount).toBe(2);
    expect(result.liveRowCount).toBe(1);
    expect(sqlRec.beginCount).toBe(1);
  });

  it("skips swap when staticChangeKey matches lastStaticHash; still writes live", async () => {
    const sqlRec = makeFakeSql();
    const redisRec = makeFakeRedis();
    const changeKey = () => "HASH-XYZ";
    const ctx = buildPoiJobContext({
      source: bundledSource({ changeKey }),
      kind: "bundled",
      sql: sqlRec.sql,
      redis: redisRec.redis,
      fetch: makeFetch("anything"),
      lastStaticHash: "HASH-XYZ",
    });
    const result = await runBundledIngest(ctx);
    expect(result.status).toBe("ok");
    expect(result.skippedStaticSwap).toBe(true);
    expect(result.staticHash).toBe("HASH-XYZ");

    const byStage = Object.fromEntries(result.stages.map((s) => [s.stage, s]));
    expect(byStage["upsert-static"]?.status).toBe("skipped");
    expect(byStage.swap?.status).toBe("skipped");
    expect(byStage["write-live"]?.status).toBe("ok");
    // No INSERT INTO + no transaction (swap was skipped).
    expect(sqlRec.beginCount).toBe(0);
    expect(sqlRec.unsafeCalls.some((q) => q.startsWith("INSERT INTO"))).toBe(false);
  });
});

describe("pipeline fetch — resolveHeaders", () => {
  it("invokes resolveHeaders with the logger and merges return value into fetch headers", async () => {
    const sqlRec = makeFakeSql();
    let capturedHeaders: Record<string, string> | undefined;
    let loggerSeen: unknown;
    const fetchImpl: typeof fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string> | undefined;
      return new Response("payload", { status: 200 });
    }) as unknown as typeof fetch;

    const source: RegisteredPoiSource = {
      id: "demo-headers",
      stationIdPrefix: "demo-headers:",
      domain: "ev-charging",
      name: "Headers Demo",
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://example.com/x.csv",
          headers: { "X-Static": "static-value", "X-Override": "static" },
          resolveHeaders: async (log) => {
            loggerSeen = log;
            return { Authorization: "Basic ZGVtbzpwdw==", "X-Override": "resolved" };
          },
        },
        parse: () => sampleRows,
        minRowCount: 1,
      },
    };

    const ctx = buildPoiJobContext({
      source,
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: fetchImpl,
    });
    const result = await runStaticIngest(ctx);

    expect(result.status).toBe("ok");
    expect(capturedHeaders).toEqual({
      "X-Static": "static-value",
      "X-Override": "resolved",
      Authorization: "Basic ZGVtbzpwdw==",
    });
    expect(loggerSeen).toBe(ctx.logger);
  });

  it("returns fetch-stage error when resolveHeaders throws", async () => {
    const sqlRec = makeFakeSql();
    const fetchImpl: typeof fetch = (async () =>
      new Response("never", { status: 200 })) as unknown as typeof fetch;

    const source: RegisteredPoiSource = {
      id: "demo-headers-fail",
      stationIdPrefix: "demo-headers-fail:",
      domain: "ev-charging",
      name: "Headers Demo Fail",
      static: {
        cron: "0 4 * * *",
        fetch: {
          type: "http",
          url: "https://example.com/x.csv",
          resolveHeaders: async () => {
            throw new Error("secret missing");
          },
        },
        parse: () => sampleRows,
      },
    };

    const ctx = buildPoiJobContext({
      source,
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: fetchImpl,
    });
    const result = await runStaticIngest(ctx);

    expect(result.status).toBe("error");
    expect(result.stages[0]?.stage).toBe("fetch");
    expect(result.stages[0]?.status).toBe("error");
    expect(result.stages[0]?.message).toContain("secret missing");
  });
});

describe("pipeline persistence hook", () => {
  it("invokes onStageComplete for every completed stage and swallows hook errors", async () => {
    const sqlRec = makeFakeSql();
    const seen: string[] = [];
    const ctx = buildPoiJobContext({
      source: staticSource(),
      kind: "static",
      sql: sqlRec.sql,
      redis: null,
      fetch: makeFetch("hello"),
      onStageComplete: async (r) => {
        seen.push(r.stage);
        if (r.stage === "parse") throw new Error("hook boom");
      },
    });
    const result = await runStaticIngest(ctx);
    expect(result.status).toBe("ok");
    expect(seen).toEqual(["fetch", "parse", "validate", "upsert-static", "swap"]);
  });
});
