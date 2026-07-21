import type { RegisteredPoiSource } from "@openmapx/poi-source-registry";
import type { Redis } from "ioredis";
import type { Sql } from "postgres";
import { describe, expect, it } from "vitest";
import { buildPoiJobContext } from "../../src/jobs/poi-ingest/pipeline.js";
import {
  liveIndexName,
  runSwap,
  stagingIndexName,
  stagingTableName,
  tableName,
} from "../../src/jobs/poi-ingest/stages/swap.js";

interface RecordedSql {
  sql: Sql;
  unsafeCalls: string[];
}

function makeFakeSql(): RecordedSql {
  const unsafeCalls: string[] = [];
  const txObj = {
    unsafe: async (query: string) => {
      unsafeCalls.push(query);
    },
  };
  const fakeSql = {
    begin: async (cb: (tx: unknown) => Promise<void>) => {
      await cb(txObj);
    },
  } as unknown as Sql;
  return { sql: fakeSql, unsafeCalls };
}

const fakeSource: RegisteredPoiSource = {
  id: "bnetza-ev",
  stationIdPrefix: "bnetza-ev:",
  domain: "ev-charging",
  name: "BNetzA EV",
  static: {
    cron: "0 4 * * *",
    fetch: { type: "http", url: "https://example.com/x.csv" },
    parse: () => [],
  },
};

describe("swap stage", () => {
  it("derives sanitised table + index names", () => {
    expect(tableName("bnetza-ev")).toBe("bnetza_ev_static");
    expect(stagingTableName("bnetza-ev")).toBe("bnetza_ev_static__staging");
    expect(stagingIndexName("bnetza-ev")).toBe("idx_bnetza_ev_static__staging_geom");
    expect(liveIndexName("bnetza-ev")).toBe("idx_bnetza_ev_static_geom");
  });

  it("throws for invalid sourceIds (SQL identifier safety gate)", () => {
    expect(() => tableName("bad name")).toThrow(/invalid sourceId/);
    expect(() => tableName("BadName")).toThrow(/invalid sourceId/);
    expect(() => tableName('"; DROP TABLE x; --')).toThrow(/invalid sourceId/);
    expect(() => tableName("-leading-dash")).toThrow(/invalid sourceId/);
  });

  it("issues the three DDL statements inside a single transaction", async () => {
    const { sql, unsafeCalls } = makeFakeSql();
    const ctx = buildPoiJobContext({
      source: fakeSource,
      kind: "static",
      sql,
      redis: null as unknown as Redis | null,
      now: () => "2026-05-01T00:00:00.000Z",
    });
    const result = await runSwap(ctx);
    expect(result.status).toBe("ok");
    expect(result.artifacts).toEqual({ tableName: "bnetza_ev_static" });
    expect(unsafeCalls).toEqual([
      `DROP TABLE IF EXISTS poi_ingest."bnetza_ev_static" CASCADE`,
      `ALTER TABLE poi_ingest."bnetza_ev_static__staging" RENAME TO "bnetza_ev_static"`,
      `ALTER INDEX poi_ingest."idx_bnetza_ev_static__staging_geom" RENAME TO "idx_bnetza_ev_static_geom"`,
    ]);
  });

  it("returns status=error when the transaction throws", async () => {
    const fakeSql = {
      begin: async () => {
        throw new Error("boom");
      },
    } as unknown as Sql;
    const ctx = buildPoiJobContext({
      source: fakeSource,
      kind: "static",
      sql: fakeSql,
      redis: null,
    });
    const result = await runSwap(ctx);
    expect(result.status).toBe("error");
    expect(result.error?.message).toBe("boom");
  });
});
