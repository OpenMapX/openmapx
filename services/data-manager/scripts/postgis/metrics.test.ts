import { describe, expect, it } from "vitest";
import {
  counterDelta,
  diagnosticDelta,
  percentile,
  sampleCpuPercent,
  sanitizePlan,
} from "./metrics";

describe("benchmark measurements", () => {
  it("uses nearest rank quantiles without mutating samples", () => {
    const values = [9, 1, 5, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(9);
    expect(values).toEqual([9, 1, 5, 3]);
    expect(() => percentile([], 95)).toThrow();
    expect(() => percentile([1], Number.NaN)).toThrow();
  });
  it("preserves large deltas and rejects resets", () => {
    expect(counterDelta("9007199254740993", "9007199254741000")).toBe("7");
    expect(() => counterDelta("10", "9")).toThrow("reset");
  });
  it("rejects truncated or evicted statement inventories", () => {
    const snapshot = { statsReset: null, statementCount: "51", deallocations: "0", statements: [] };
    expect(() => diagnosticDelta(snapshot as never, snapshot as never)).toThrow();
    expect(() =>
      diagnosticDelta(
        { ...snapshot, statementCount: "1" } as never,
        { ...snapshot, statementCount: "1", deallocations: "1" } as never,
      ),
    ).toThrow();
  });
  it("removes plan expressions, values and relation identities recursively", () => {
    const result = sanitizePlan({
      "Node Type": "Index Scan",
      "Actual Rows": 2,
      Filter: "password=secret",
      "Relation Name": "private",
      Plans: [{ "Node Type": "Sort", "Sort Key": ["private"], "Shared Hit Blocks": 4 }],
    });
    expect(result).toEqual({
      "Node Type": "Index Scan",
      "Actual Rows": 2,
      Plans: [{ "Node Type": "Sort", "Shared Hit Blocks": 4 }],
    });
  });
  it("computes CPU from cumulative deltas and keeps missing measurements explicit", () => {
    expect(
      sampleCpuPercent({ cpu: 100, system: 1000, cpus: 2 }, { cpu: 150, system: 1200, cpus: 2 }),
    ).toBe(50);
    expect(
      sampleCpuPercent({ cpu: 100, system: 1000, cpus: 2 }, { cpu: 100, system: 1000, cpus: 2 }),
    ).toBeNull();
  });
});
it("rejects a selectively reset statement even when aggregate totals increase", () => {
  const base = {
    statsReset: null,
    statementCount: "1",
    deallocations: "0",
    statements: [{ queryId: "1", calls: "10", statsSince: "2026-10-04T01:00:00.123456Z" }],
  };
  const after = {
    ...base,
    statements: [{ queryId: "1", calls: "11", statsSince: "2026-10-04T01:00:00.123457Z" }],
  };
  expect(() => diagnosticDelta(base as never, after as never)).toThrow("reset");
});
