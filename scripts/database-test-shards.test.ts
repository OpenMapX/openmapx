import { describe, expect, it } from "vitest";
import {
  partitionScenarios,
  scenarioPattern,
  verifyShardReceipts,
} from "./database-test-shards.mjs";

describe("complete recovery scenario partitions", () => {
  it("assigns every expanded scenario exactly once without splitting lifecycle sequences", () => {
    const names = [
      "suite > twelve minute sequence",
      "suite > six minute retry",
      ...Array.from({ length: 80 }, (_, n) => `suite > case ${n}`),
    ];
    const partitions = partitionScenarios(names, 4, {
      "twelve minute sequence": 738,
      "six minute retry": 375,
    });
    expect(partitions.flat().sort()).toEqual([...names].sort());
    expect(partitions.filter((part) => part.includes(names[0]))).toHaveLength(1);
    expect(partitions.findIndex((part) => part.includes(names[0]))).not.toBe(
      partitions.findIndex((part) => part.includes(names[1])),
    );
    for (const name of names) {
      const runtime = name;
      expect(
        partitions.filter((part) => new RegExp(scenarioPattern(part)).test(runtime)),
      ).toHaveLength(1);
    }
    expect(
      partitionScenarios([...names].reverse(), 4, {
        "twelve minute sequence": 738,
        "six minute retry": 375,
      }),
    ).toEqual(partitions);
  });
  it("escapes punctuation and preserves literal nested delimiters in test titles", () => {
    const names = ["suite > case (a|b) [x] > literal"];
    expect(new RegExp(scenarioPattern(names)).test("suite > case (a|b) [x] > literal")).toBe(true);
    expect(new RegExp(scenarioPattern(names)).test("suite > case a [x] > literal")).toBe(false);
  });
  it("refuses empty, duplicate or incomplete scenario inventories", () => {
    expect(() => partitionScenarios([], 4)).toThrow();
    expect(() => partitionScenarios(["same", "same"], 2)).toThrow();
    expect(() => scenarioPattern([])).toThrow();
  });
  it("rejects missing, overlapping, changed-source and mismatched shard receipts", () => {
    const receipts = [1, 2].map((part) => ({
      group: "example",
      part,
      total: 2,
      source: "a".repeat(40),
      all: ["first", "second"],
      selected: [part === 1 ? "first" : "second"],
    }));
    const matrix = [
      { group: "example", part: 1, total: 2 },
      { group: "example", part: 2, total: 2 },
    ];
    expect(() => verifyShardReceipts(receipts, matrix, "a".repeat(40))).not.toThrow();
    expect(() => verifyShardReceipts(receipts.slice(0, 1), matrix, "a".repeat(40))).toThrow();
    expect(() =>
      verifyShardReceipts(
        [receipts[0], { ...receipts[1], selected: ["first"] }],
        matrix,
        "a".repeat(40),
      ),
    ).toThrow();
    expect(() => verifyShardReceipts(receipts, matrix, "b".repeat(40))).toThrow();
    expect(() =>
      verifyShardReceipts(
        [receipts[0], { ...receipts[1], all: ["first", "second", "lost"] }],
        matrix,
        "a".repeat(40),
      ),
    ).toThrow();
  });
});
