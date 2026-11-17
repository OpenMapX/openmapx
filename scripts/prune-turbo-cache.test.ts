import { describe, expect, it } from "vitest";
import { unusedCacheFiles, usedTaskHashes } from "./ci/prune-turbo-cache.mjs";

describe("Turbo build cache pruning", () => {
  it("keeps every file of the tasks in the run summaries and nothing else", () => {
    const used = usedTaskHashes([
      { tasks: [{ hash: "c4e9f3e4a47a5db7" }, { hash: "0123456789abcdef" }] },
      { tasks: [{ hash: "fedcba9876543210" }, {}] },
    ]);
    expect([...used].sort()).toEqual(["0123456789abcdef", "c4e9f3e4a47a5db7", "fedcba9876543210"]);
    const files = [
      "c4e9f3e4a47a5db7.tar.zst",
      "c4e9f3e4a47a5db7-meta.json",
      "c4e9f3e4a47a5db7-manifest.json",
      "fedcba9876543210.tar.zst",
      "aaaaaaaaaaaaaaaa.tar.zst",
      "aaaaaaaaaaaaaaaa-meta.json",
    ];
    expect(unusedCacheFiles(files, used)).toEqual([
      "aaaaaaaaaaaaaaaa.tar.zst",
      "aaaaaaaaaaaaaaaa-meta.json",
    ]);
  });
  it("finds no hashes in summaries without tasks", () => {
    expect(usedTaskHashes([{}, { tasks: [] }]).size).toBe(0);
  });
});
