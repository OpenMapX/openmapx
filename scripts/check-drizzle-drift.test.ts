import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { baselineComparison } from "./check-drizzle-drift.mjs";

const entry = (idx: number, tag: string) => ({ idx, version: "7", when: idx, tag });

describe("drizzle drift gate", () => {
  it("compares the committed baseline with a regeneration while only the baseline exists", () => {
    expect(
      baselineComparison({
        entries: [entry(0, "0000_baseline"), entry(1, "0001_database_objects")],
      }),
    ).toEqual({ applies: true });
  });

  it("applies to the committed journal", () => {
    const journal = JSON.parse(
      readFileSync(
        new URL("../apps/api/src/db/migrations/meta/_journal.json", import.meta.url),
        "utf8",
      ),
    );
    expect(baselineComparison(journal).applies).toBe(true);
  });

  it("skips the comparison once an incremental migration follows the baseline", () => {
    const result = baselineComparison({
      entries: [
        entry(0, "0000_baseline"),
        entry(1, "0001_database_objects"),
        entry(2, "0002_add_widget"),
      ],
    });
    expect(result.applies).toBe(false);
    expect(result.reason).toMatch(/later migrations follow the baseline \(0002_add_widget\)/);
    expect(result.reason).toMatch(/drizzle-kit check and generate still guard drift/);
  });

  it("skips the comparison for a journal that is not the baseline pair", () => {
    expect(baselineComparison({ entries: [entry(0, "0000_baseline")] }).applies).toBe(false);
    expect(
      baselineComparison({
        entries: [entry(0, "0001_database_objects"), entry(1, "0000_baseline")],
      }).applies,
    ).toBe(false);
  });
});
