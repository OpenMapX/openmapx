import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../src/db/index.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        mocks.inserted.push(values);
        return Promise.resolve();
      },
    }),
  },
}));

import {
  recordValidateOutcome,
  resetFeedStateCircuitForTests,
} from "../../src/jobs/transitous/feed-state-writer.js";

beforeEach(() => {
  mocks.inserted.length = 0;
  resetFeedStateCircuitForTests();
});

describe("recordValidateOutcome", () => {
  it("scrubs validation failures before durable feed-state persistence", async () => {
    const message =
      "fetch https://feed-user:FEED-PASSWORD@example.org/archive?token=FEED-TOKEN failed";

    await recordValidateOutcome({ region: "de", name: "demo", ok: false, message });

    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]?.validationMessage).toBe("fetch https://example.org/archive failed");
    expect(JSON.stringify(mocks.inserted)).not.toMatch(/FEED-PASSWORD|FEED-TOKEN|feed-user/);
    expect(message).toContain("FEED-TOKEN");
  });
});
