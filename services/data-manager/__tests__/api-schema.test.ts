import { readFileSync } from "node:fs";
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import {
  appliedApiSchemaVersion,
  expectedApiSchemaVersion,
  waitForApiSchema,
} from "../src/db/api-schema.js";

function history(...reads: (string | null | { code: string; message?: string })[]): postgres.Sql {
  const query = vi.fn(async () => {
    const next = reads.length > 1 ? reads.shift() : reads[0];
    if (next !== null && typeof next === "object")
      throw Object.assign(new Error(next.message ?? next.code), next);
    return [{ latest: next ?? null }];
  });
  return query as unknown as postgres.Sql;
}

const expected = { tag: "0001_database_objects", when: 2000 };

describe("API schema version", () => {
  it("expects the newest entry of the API migration journal", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../../../apps/api/src/db/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    ) as { entries: { tag: string; when: number }[] };
    const last = journal.entries.at(-1);
    expect(expectedApiSchemaVersion()).toEqual({ tag: last?.tag, when: last?.when });
  });

  it("tells an absent, empty or unreadable history from an applied one", async () => {
    expect(await appliedApiSchemaVersion(history({ code: "3F000" }))).toEqual({ state: "absent" });
    expect(await appliedApiSchemaVersion(history({ code: "42P01" }))).toEqual({ state: "absent" });
    expect(await appliedApiSchemaVersion(history(null))).toEqual({ state: "empty" });
    expect(
      await appliedApiSchemaVersion(history({ code: "42501", message: "permission denied" })),
    ).toEqual({ state: "unreadable", detail: "permission denied" });
    expect(await appliedApiSchemaVersion(history("2000"))).toEqual({
      state: "applied",
      when: 2000,
    });
    await expect(appliedApiSchemaVersion(history({ code: "57P01" }))).rejects.toThrow();
  });

  it("waits until the API applied this build's newest migration or a newer one", async () => {
    const onWait = vi.fn();
    await waitForApiSchema(history({ code: "3F000" }, "1000", "1000", "3000"), {
      timeoutMs: 10_000,
      pollMs: 1,
      onWait,
      expected,
    });
    expect(onWait.mock.calls.map(([found]) => found)).toEqual([
      "drizzle.__drizzle_migrations does not exist",
      "the newest applied migration has when 1000",
    ]);
  });

  it("gives up after the timeout, naming what it expected and found", async () => {
    await expect(
      waitForApiSchema(history("1000"), { timeoutMs: 5, pollMs: 1, expected }),
    ).rejects.toThrow(
      /when 2000 \(0001_database_objects\) or later, but the newest applied migration has when 1000/,
    );
  });
});
