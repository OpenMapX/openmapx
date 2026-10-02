import { writeFileSync } from "node:fs";
import type { PoiRow, RegisteredPoiSource } from "@openmapx/poi-source-registry";
import { createStaticPoiChangeKey } from "@openmapx/poi-source-registry/static-change-key";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { buildPoiJobContext, runStaticIngest } from "../../src/jobs/poi-ingest/pipeline.js";

const publishedAt = "2026-09-01T00:00:00.000Z";
const checkedAt = "2026-10-02T00:00:00.000Z";
const rows: PoiRow[] = [{ poiId: "a", lng: 6, lat: 50, payload: { name: "A", price: 1 } }];
const key = createStaticPoiChangeKey("static-reuse-fixture-v1");
function publication(hash = key(rows), count = rows.length) {
  return {
    last_static_hash: hash,
    last_static_row_count: count,
    last_static_ingest_at: publishedAt,
    table_exists: true,
    table_oid: "12345",
    refresh_evidence: {
      version: 1,
      static: {
        activeVersion: hash,
        lastPublishedVersion: hash,
        lastPublishedAt: publishedAt,
        tableOid: "12345",
        rowCount: count,
        activeAssociation: "known",
        pendingWriteIntentId: null,
      },
    },
  };
}
function fakeSql(state: unknown) {
  const queries: string[] = [];
  const params: unknown[][] = [];
  let swaps = 0;
  const sql = {
    unsafe: async (query: string, values: unknown[] = []) => {
      queries.push(query);
      params.push(values);
      return query.includes("SELECT") ? (state ? [state] : []) : [];
    },
    begin: async (fn: (tx: Sql) => Promise<void>) => {
      swaps++;
      await fn(sql as unknown as Sql);
    },
  };
  return {
    sql: sql as unknown as Sql,
    queries,
    params,
    get swaps() {
      return swaps;
    },
  };
}
function source(value = rows): RegisteredPoiSource {
  return {
    id: "de-test",
    stationIdPrefix: "de-test:",
    domain: "ev-charging",
    name: "Fixture",
    static: {
      cron: "0 4 * * *",
      fetch: { type: "http", url: "https://example.com/fixture" },
      parse: () => value,
      staticChangeKey: key,
    },
  };
}
async function run(state: unknown, value = rows, customize?: (src: RegisteredPoiSource) => void) {
  const db = fakeSql(state);
  const src = source(value);
  customize?.(src);
  let downloads = 0;
  const result = await runStaticIngest(
    buildPoiJobContext({
      source: src,
      kind: "static",
      sql: db.sql,
      redis: null,
      now: () => checkedAt,
      // Deliberately supply no lastStaticHash: manual, cron and restart use durable state.
      download: async (options) => {
        downloads++;
        writeFileSync(options.destination, "fixture");
        return { bytesWritten: 7, finalUrl: options.url, contentType: null };
      },
    }),
  );
  return { ...db, result, downloads };
}

describe("validated static publication reuse", () => {
  it("checks current publication without a caller hash and skips every static write", async () => {
    const out = await run(publication());
    expect(out.result.status).toBe("ok");
    expect(out.result.skippedStaticSwap).toBe(true);
    expect(out.result.staticPublicationVersion).toBe(key(rows));
    expect(out.result.staticPublishedAt).toBe(publishedAt);
    expect(out.result.stages.map((s) => [s.stage, s.status])).toEqual([
      ["fetch", "ok"],
      ["parse", "ok"],
      ["validate", "ok"],
      ["upsert-static", "skipped"],
      ["swap", "skipped"],
    ]);
    expect(out.queries).toHaveLength(1);
    expect(out.params[0]).toEqual(["de-test", 'poi_ingest."de_test_static"']);
    expect(out.swaps).toBe(0);
    expect(out.downloads).toBe(1);
  });

  it.each([
    ["no state", undefined],
    ["no table", { ...publication(), table_exists: false }],
    ["recreated table with stale publication metadata", { ...publication(), table_oid: "67890" }],
    ["no table identity", { ...publication(), table_oid: null }],
    ["no legacy hash", { ...publication(), last_static_hash: null }],
    ["legacy count mismatch", { ...publication(), last_static_row_count: 2 }],
    ["no publication date", { ...publication(), last_static_ingest_at: null }],
    ["invalid publication date", { ...publication(), last_static_ingest_at: "bad" }],
    ["no evidence", { ...publication(), refresh_evidence: null }],
    [
      "wrong evidence version",
      { ...publication(), refresh_evidence: { ...publication().refresh_evidence, version: 2 } },
    ],
    ...[
      "activeVersion",
      "lastPublishedVersion",
      "lastPublishedAt",
      "rowCount",
      "activeAssociation",
      "pendingWriteIntentId",
      "tableOid",
    ].map((field): [string, unknown] => [
      field,
      {
        ...publication(),
        refresh_evidence: {
          version: 1,
          static: {
            ...publication().refresh_evidence.static,
            [field]: field === "rowCount" ? 2 : "inconsistent",
          },
        },
      },
    ]),
  ])("rebuilds conservatively for %s", async (_name, state) => {
    const out = await run(state);
    expect(out.result.status).toBe("ok");
    expect(out.result.skippedStaticSwap).not.toBe(true);
    expect(out.result.staticHash).toBe(key(rows));
    expect(out.swaps).toBe(1);
    expect(out.queries.filter((q) => q.startsWith("CREATE TABLE"))).toHaveLength(1);
  });

  it.each([{ lng: 6.1 }, { lat: 50.1 }, { payload: { name: "A", price: 2 } }, { poiId: "b" }])(
    "rebuilds changed normalized output %j",
    async (patch) => {
      const out = await run(publication(), [{ ...rows[0], ...patch }]);
      expect(out.result.status).toBe("ok");
      expect(out.swaps).toBe(1);
      expect(out.result.staticHash).not.toBe(key(rows));
    },
  );

  it("rebuilds when comparison version changes", async () => {
    const out = await run(publication(), rows, (src) => {
      if (src.static) src.static.staticChangeKey = () => `v2:${key(rows)}`;
    });
    expect(out.swaps).toBe(1);
    expect(out.result.staticHash).toBe(`v2:${key(rows)}`);
  });

  it("validates before comparison and never refreshes a failed response", async () => {
    const out = await run(publication(), rows, (src) => {
      if (src.static) src.static.validate = () => ({ ok: false, error: "invalid fixture" });
    });
    expect(out.result.status).toBe("error");
    expect(out.queries).toHaveLength(0);
    expect(out.swaps).toBe(0);
  });

  it("leaves sources without opt-in on the original full-publication path", async () => {
    const out = await run(publication(), rows, (src) => {
      if (src.static) delete src.static.staticChangeKey;
    });
    expect(out.swaps).toBe(1);
    expect(out.queries.some((q) => q.includes("SELECT"))).toBe(false);
  });

  it("avoids all 182 insert batches on a second 91,000-row run and rebuilds a changed payload", async () => {
    const large = Array.from({ length: 91_000 }, (_, i) => ({ ...rows[0], poiId: String(i) }));
    const hash = key(large);
    const first = await run(undefined, large);
    const second = await run(publication(hash, large.length), large);
    const changed = await run(publication(hash, large.length), [
      { ...large[0], payload: { price: 2 } },
      ...large.slice(1),
    ]);
    expect(first.queries.filter((q) => q.startsWith("INSERT INTO poi_ingest"))).toHaveLength(182);
    expect(second.queries.filter((q) => q.startsWith("INSERT INTO poi_ingest"))).toHaveLength(0);
    expect(second.queries.filter((q) => q.startsWith("CREATE"))).toHaveLength(0);
    expect(second.swaps).toBe(0);
    expect(changed.queries.filter((q) => q.startsWith("INSERT INTO poi_ingest"))).toHaveLength(182);
    console.info(
      "static-poi-operation-evidence",
      JSON.stringify(
        [first, second, changed].map((out, index) => ({
          scenario: ["initial", "unchanged", "payload-changed"][index],
          rows: 91_000,
          insertBatches: out.queries.filter((q) => q.startsWith("INSERT INTO poi_ingest")).length,
          createTables: out.queries.filter((q) => q.startsWith("CREATE TABLE")).length,
          createIndexes: out.queries.filter((q) => q.startsWith("CREATE INDEX")).length,
          swaps: out.swaps,
          durationMs: out.result.durationMs,
        })),
      ),
    );
  });
});

it("keeps live refresh independent of opted-in static comparison", async () => {
  const { runLiveIngest } = await import("../../src/jobs/poi-ingest/pipeline.js");
  const { poiLiveHashKey } = await import("@openmapx/poi-source-registry");
  const db = fakeSql(publication());
  const src = source();
  if (!src.static) throw new Error("fixture requires static spec");
  src.static.staticChangeKey = () => {
    throw new Error("static comparison must not execute during live refresh");
  };
  src.live = {
    cron: "0 * * * *",
    fetch: { type: "http", url: "https://example.com/live" },
    ttlSeconds: 7200,
    parse: () => new Map([["a", { asOf: checkedAt, status: "AVAILABLE" }]]),
  };
  const writes = new Map<string, string>();
  let expiry: number | undefined;
  const multi = {
    del: () => {
      writes.clear();
      return multi;
    },
    hset: (key: string, values: Record<string, string>) => {
      expect(key).toBe(poiLiveHashKey(src.id));
      for (const [id, value] of Object.entries(values)) writes.set(id, value);
      return multi;
    },
    expire: (_key: string, ttl: number) => {
      expiry = ttl;
      return multi;
    },
    exec: async () => [
      [null, 1],
      [null, 1],
      [null, 1],
    ],
  };
  const result = await runLiveIngest(
    buildPoiJobContext({
      source: src,
      kind: "live",
      sql: db.sql,
      redis: { multi: () => multi } as unknown as import("ioredis").Redis,
      now: () => checkedAt,
      download: async (options) => {
        writeFileSync(options.destination, "live");
        return { bytesWritten: 4, contentType: null, finalUrl: options.url };
      },
    }),
  );
  expect(result.status).toBe("ok");
  expect(result.stages.map((stage) => stage.stage)).toEqual(["fetch", "parse", "write-live"]);
  expect(result.staticHash).toBeUndefined();
  expect(JSON.parse(writes.get("a") ?? "null")).toMatchObject({
    asOf: checkedAt,
    status: "AVAILABLE",
  });
  expect(expiry).toBe(7200);
  expect(
    db.queries.some((query) => query.includes("to_regclass") || query.startsWith("CREATE")),
  ).toBe(false);
});

it("fails safely when current publication metadata cannot be read", async () => {
  const src = source();
  const result = await runStaticIngest(
    buildPoiJobContext({
      source: src,
      kind: "static",
      redis: null,
      sql: {
        unsafe: async () => {
          throw new Error("fixture metadata read unavailable");
        },
      } as unknown as Sql,
      download: async (options) => {
        writeFileSync(options.destination, "fixture");
        return { bytesWritten: 7, contentType: null, finalUrl: options.url };
      },
    }),
  );
  expect(result.status).toBe("error");
  expect(result.stages.at(-1)).toMatchObject({
    stage: "upsert-static",
    status: "error",
    message: "fixture metadata read unavailable",
  });
  expect(result.skippedStaticSwap).not.toBe(true);
});
