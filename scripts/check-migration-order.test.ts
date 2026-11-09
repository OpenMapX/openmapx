import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findMigrationOrderViolations } from "./check-migration-order";

const journalPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../apps/api/src/db/migrations/meta/_journal.json",
);

describe("findMigrationOrderViolations", () => {
  it("accepts strictly increasing entries", () => {
    expect(
      findMigrationOrderViolations([
        { tag: "0000_a", when: 100 },
        { tag: "0001_b", when: 200 },
        { tag: "0002_c", when: 300 },
      ]),
    ).toEqual([]);
  });

  it("rejects an entry with the same timestamp as its predecessor", () => {
    const violations = findMigrationOrderViolations([
      { tag: "0000_a", when: 100 },
      { tag: "0001_b", when: 100 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("0001_b");
    expect(violations[0]).toContain("0000_a");
  });

  it("rejects a reordered entry and names both tags", () => {
    const violations = findMigrationOrderViolations([
      { tag: "0000_a", when: 100 },
      { tag: "0001_b", when: 300 },
      { tag: "0002_c", when: 200 },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("0002_c");
    expect(violations[0]).toContain("0001_b");
  });

  it("passes for the committed journal", () => {
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    expect(journal.entries.length).toBeGreaterThan(0);
    expect(findMigrationOrderViolations(journal.entries)).toEqual([]);
  });
});
