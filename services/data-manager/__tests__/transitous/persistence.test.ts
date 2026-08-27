import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StageResult } from "../../src/jobs/transitous/types.js";

let insertedValues: Record<string, unknown> | undefined;

vi.mock("../../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertedValues = values;
        return Promise.resolve();
      },
    }),
  },
}));

beforeEach(() => {
  insertedValues = undefined;
});

describe("makePersistingOnStageComplete", () => {
  it("scrubs messages, errors, and artifacts before durable stage persistence", async () => {
    const { makePersistingOnStageComplete } = await import(
      "../../src/jobs/transitous/persistence.js"
    );
    const result: StageResult = {
      stage: "fetch",
      status: "error",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: "2026-08-21T00:00:01.000Z",
      durationMs: 1000,
      message: "fetch https://user:MESSAGE-PASSWORD@example.org/feed?token=MESSAGE-TOKEN failed",
      error: {
        message: "Authorization: Bearer ERROR-BEARER-TOKEN",
        stack: "at fetch (https://example.org/feed?key=STACK-TOKEN)",
      },
      artifacts: {
        stderr: "download https://user:ARTIFACT-PASSWORD@example.org/feed?key=ARTIFACT-TOKEN",
      },
    };

    await makePersistingOnStageComplete("job-1", {
      info: () => {},
      warn: () => {},
      error: () => {},
    })(result);

    const serialized = JSON.stringify(insertedValues);
    expect(serialized).not.toMatch(
      /MESSAGE-PASSWORD|MESSAGE-TOKEN|ERROR-BEARER-TOKEN|STACK-TOKEN|ARTIFACT-PASSWORD|ARTIFACT-TOKEN/,
    );
    expect(serialized).toContain("example.org");
    expect(serialized).toContain("[redacted]");
    expect(result.message).toContain("MESSAGE-TOKEN");
  });
});
