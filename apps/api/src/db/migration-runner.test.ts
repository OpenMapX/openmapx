import { describe, expect, it } from "vitest";
import { pendingMigrations } from "./migration-runner.js";

const entries = [
  { tag: "0000_initial", when: 100 },
  { tag: "0001_next", when: 200 },
  { tag: "0002_latest", when: 300 },
];

describe("pendingMigrations", () => {
  it("lists every migration for a database that has none applied", () => {
    expect(pendingMigrations(entries, null)).toEqual(["0000_initial", "0001_next", "0002_latest"]);
  });

  it("lists the migrations newer than the newest applied one", () => {
    expect(pendingMigrations(entries, 200)).toEqual(["0002_latest"]);
  });

  it("lists nothing for a database at the newest migration", () => {
    expect(pendingMigrations(entries, 300)).toEqual([]);
  });
});
