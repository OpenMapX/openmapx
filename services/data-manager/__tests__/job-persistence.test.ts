import { beforeEach, describe, expect, it, vi } from "vitest";

interface InsertCall {
  values: Record<string, unknown>;
}

const insertCalls: InsertCall[] = [];
let insertError: Error | null = null;

vi.mock("../src/db/index.js", () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        insertCalls.push({ values });
        return {
          // biome-ignore lint/suspicious/noThenProperty: models Drizzle's thenable query builder
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            (insertError ? Promise.reject(insertError) : Promise.resolve()).then(
              onFulfilled,
              onRejected,
            ),
        };
      },
    }),
  },
}));

beforeEach(() => {
  insertCalls.length = 0;
  insertError = null;
});

describe("job persistence", () => {
  it("converts timestamps and scrubs diagnostics without mutating the result", async () => {
    const { makePersistingOnStageComplete } = await import("../src/jobs/persistence.js");
    const result = {
      stage: "fetch",
      status: "error",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: "2026-08-21T00:00:01.000Z",
      durationMs: 1_000,
      message: "fetch https://user:MESSAGE-PASSWORD@example.org/feed?token=MESSAGE-TOKEN failed",
      error: {
        message: "Authorization: Bearer ERROR-BEARER-TOKEN",
        stack: "at fetch (https://example.org/feed?key=STACK-TOKEN)",
      },
      artifacts: {
        stderr: "download https://user:ARTIFACT-PASSWORD@example.org/feed?key=ARTIFACT-TOKEN",
      },
    };
    const hook = makePersistingOnStageComplete("job-1", { warn: vi.fn() }, "example");

    await hook(result);

    const persisted = insertCalls[0]?.values;
    expect(persisted?.startedAt).toEqual(new Date(result.startedAt));
    expect(persisted?.finishedAt).toEqual(new Date(result.finishedAt));
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toMatch(
      /MESSAGE-PASSWORD|MESSAGE-TOKEN|ERROR-BEARER-TOKEN|STACK-TOKEN|ARTIFACT-PASSWORD|ARTIFACT-TOKEN/,
    );
    expect(serialized).toContain("example.org");
    expect(serialized).toContain("[redacted]");
    expect(result.message).toContain("MESSAGE-TOKEN");
  });

  it("normalizes absent diagnostics and swallows redacted persistence errors", async () => {
    const { makePersistingOnStageComplete } = await import("../src/jobs/persistence.js");
    const warn = vi.fn();
    const hook = makePersistingOnStageComplete("job-1", { warn }, "example");
    const result = {
      stage: "promote",
      status: "skipped",
      startedAt: "2026-08-21T00:00:00.000Z",
      finishedAt: "2026-08-21T00:00:00.000Z",
      durationMs: 0,
    };

    await hook(result);
    expect(insertCalls[0]?.values).toMatchObject({ message: null, error: null, artifacts: null });

    insertError = new Error(
      "connection https://db-user:DB-PASSWORD@db.example.org/openmapx?token=DB-TOKEN refused",
    );
    await expect(hook(result)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db.example.org"));
    expect(warn.mock.calls[0]?.[0]).not.toMatch(/DB-PASSWORD|DB-TOKEN|db-user/);
  });
});
