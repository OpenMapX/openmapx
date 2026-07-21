import { describe, expect, it } from "vitest";
import { collectFeedIdViolations } from "../../scripts/check-feed-ids";

// vitest runs from the repo root, so process.cwd() is the repo root here.
const REPO_ROOT = process.cwd();

describe("feed-id consistency", () => {
  it("has no feed-id violations across manifests and poi-sources", () => {
    expect(collectFeedIdViolations(REPO_ROOT)).toEqual([]);
  });
});
