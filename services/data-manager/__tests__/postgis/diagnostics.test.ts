import { describe, expect, it, vi } from "vitest";
import { collectDiagnostics, projectStatements } from "../../src/postgis/diagnostics";

describe("PostgreSQL diagnostics privacy projection", () => {
  it("preserves large counters while removing SQL text, names and arbitrary properties", () => {
    const rows = projectStatements([
      {
        queryid: "9223372036854775807",
        calls: "9007199254740993",
        total_exec_time: 4.5,
        query: "SELECT private_token",
        userid: 1,
        database: "private",
        wal_bytes: "123",
      },
    ]);
    expect(rows[0]).toEqual({
      queryId: "9223372036854775807",
      calls: "9007199254740993",
      totalExecMs: 4.5,
      walBytes: "123",
    });
    expect(
      projectStatements([{ queryid: "1", stats_since: "2026-10-04T01:00:00.123456Z" }])[0]
        .statsSince,
    ).toBe("2026-10-04T01:00:00.123456Z");
    expect(JSON.stringify(rows)).not.toMatch(/private|userid|database|SELECT/);
  });
  it("rejects malformed counters instead of emitting misleading values", () => {
    expect(() => projectStatements([{ queryid: "1", calls: "not-a-number" }])).toThrow();
    expect(() => projectStatements([{ queryid: "1", calls: 9007199254740992 }])).toThrow();
  });
  it("rejects missing duration values and invalid versions", async () => {
    expect(() => projectStatements([{ queryid: "1", total_exec_time: null }])).toThrow();
    const sql = {
      unsafe: vi
        .fn()
        .mockResolvedValue([
          { version: "invalid", installed: true, preload: "pg_stat_statements" },
        ]),
    };
    await expect(collectDiagnostics(sql)).rejects.toThrow("unavailable");
    expect(sql.unsafe).toHaveBeenCalledTimes(1);
  });
  it("reports unavailable extension without forwarding database errors or credentials", async () => {
    const sql = {
      unsafe: vi.fn().mockRejectedValue(new Error("password=secret postgres://private")),
    };
    await expect(collectDiagnostics(sql)).rejects.toThrow("PostgreSQL diagnostics unavailable");
    try {
      await collectDiagnostics(sql);
    } catch (error) {
      expect(String(error)).not.toMatch(/secret|private/);
    }
  });
});

it("rejects instrumentation that is loaded but disabled", async () => {
  const sql = {
    unsafe: vi.fn().mockResolvedValue([
      {
        version: "180006",
        installed: true,
        preload: "pg_stat_statements",
        tracking: "none",
        query_ids: "auto",
        utility: "off",
      },
    ]),
  };
  await expect(collectDiagnostics(sql)).rejects.toThrow("unavailable");
  expect(sql.unsafe).toHaveBeenCalledTimes(1);
});
