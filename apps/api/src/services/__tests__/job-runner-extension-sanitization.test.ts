import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => {
  const inserts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  return {
    inserts,
    updates,
    db: {
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserts.push(value);
          return Object.assign(Promise.resolve([]), {
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
          });
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn((value: Record<string, unknown>) => {
          updates.push(value);
          return { where: vi.fn().mockResolvedValue([]) };
        }),
      })),
    },
  };
});

vi.mock("../../db", () => ({ db: database.db }));
vi.mock("../admin-job-ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../admin-job-ops")>()),
  cancelAdminJobOperations: vi.fn(),
}));

const { jobRunner } = await import("../job-runner");
const { jobEventBus } = await import("../job-events");

const sensitive =
  "https://sentinel-user:sentinel-password@example.test/private?token=sentinel-query#sentinel-fragment";
const spacedQuery = "https://example.test/archive.tgz? sentinel-query-secret";
const spacedFragment = "https://example.test/archive.tgz# sentinel-fragment-secret";
const tabbedScheme = "ht\ttps://example.test/archive.tgz? tabbed-scheme-secret";
const validPayload = {
  manifest: {
    id: "fixture-extension",
    name: "Fixture extension",
    version: "1.0.0",
    integrations: [
      {
        id: "fixture-integration",
        artifact: "https://example.test/fixture.tar.gz",
        sha256: "a".repeat(64),
      },
    ],
  },
  sourceUrl: "https://example.test/extension.json",
  sourceTrust: "community",
};

type ExecuteJob = (
  jobId: string,
  type: string,
  payload: Record<string, unknown>,
  checkpoint: Record<string, unknown> | null,
  signal: AbortSignal,
) => Promise<void>;

const executeJob = (
  jobRunner as unknown as {
    executeJob: ExecuteJob;
  }
).executeJob.bind(jobRunner);

beforeEach(() => {
  database.inserts.length = 0;
  database.updates.length = 0;
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("extension job durable boundaries", () => {
  it("rejects an unsafe internal enqueue before inserting a job", async () => {
    await expect(
      jobRunner.enqueue("extension.install", {
        ...validPayload,
        sourceUrl: `${validPayload.sourceUrl}?token=sentinel-query`,
      }),
    ).rejects.toThrow(/invalid extension install payload/i);
    expect(database.inserts).toEqual([]);
  });

  it("sanitizes extension log, checkpoint, result and live-event values", async () => {
    jobRunner.register("extension.install", async (ctx) => {
      await ctx.log(`installing ${sensitive} and ${spacedQuery}`);
      await ctx.checkpoint({ checkpoint: sensitive, spacedQuery }, 25);
      return { result: sensitive, spacedFragment };
    });

    await executeJob(
      "extension-success",
      "extension.install",
      validPayload,
      null,
      new AbortController().signal,
    );

    const durableAndLive = {
      inserts: database.inserts,
      updates: database.updates,
      events: jobEventBus.history("extension-success", 0),
    };
    expect(JSON.stringify(durableAndLive)).not.toMatch(
      /sentinel-|query-secret|fragment-secret|example\.test|\/private/,
    );
    expect(JSON.stringify(durableAndLive)).toContain("[redacted-url]");
  });

  it("preserves every bounded durable operation while sanitizing extension checkpoints", async () => {
    const operations = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => {
        const suffix = String(index).padStart(16, "0");
        const operationKey = `opk1_${index === 0 ? "url" : "key"}${suffix}`;
        return [
          operationKey,
          {
            kind: "backup.create",
            operationKey,
            operationId: `job1_key${suffix}`,
            cursor: 0,
            events: 0,
            bytes: 0,
            truncated: false,
            terminal: false,
          },
        ];
      }),
    );
    const checkpoint = {
      opsProjection: {
        version: 1,
        eventTotal: 0,
        byteTotal: 0,
        truncated: false,
        operations,
      },
    };
    jobRunner.register("extension.install", async (ctx) => {
      await ctx.checkpoint(checkpoint);
      return undefined;
    });

    await executeJob(
      "extension-projection",
      "extension.install",
      validPayload,
      null,
      new AbortController().signal,
    );

    const persisted = database.updates.find(
      (update) =>
        typeof update.result === "object" &&
        update.result !== null &&
        "opsProjection" in update.result,
    )?.result as typeof checkpoint | undefined;
    expect(persisted?.opsProjection.operations).toEqual(operations);
  });

  it("redacts schemes containing legacy parser whitespace as a complete value", async () => {
    jobRunner.register("extension.install", async (ctx) => {
      await ctx.log(`failed ${tabbedScheme}`);
      return { diagnostic: tabbedScheme };
    });

    await executeJob(
      "extension-tabbed-scheme",
      "extension.install",
      validPayload,
      null,
      new AbortController().signal,
    );

    const durableAndLive = {
      inserts: database.inserts,
      updates: database.updates,
      events: jobEventBus.history("extension-tabbed-scheme", 0),
    };
    expect(JSON.stringify(durableAndLive)).not.toMatch(/tabbed-scheme-secret|example\.test/);
    expect(JSON.stringify(durableAndLive)).toContain("[redacted-url]");
  });

  it("sanitizes extension handler failures in storage and live events", async () => {
    jobRunner.register("extension.install", async () => {
      throw new Error(`failed ${spacedFragment}`);
    });

    await executeJob(
      "extension-failure",
      "extension.install",
      validPayload,
      null,
      new AbortController().signal,
    );

    const durableAndLive = {
      updates: database.updates,
      events: jobEventBus.history("extension-failure", 0),
    };
    expect(JSON.stringify(durableAndLive)).not.toMatch(/fragment-secret|example\.test/);
    expect(JSON.stringify(durableAndLive)).toContain("[redacted-url]");
  });

  it("does not alter payloads or outputs for unrelated job types", async () => {
    const payload = { exact: sensitive };
    await jobRunner.enqueue("fixture.unrelated", payload);
    expect(database.inserts.at(-1)).toMatchObject({ payload });
    database.inserts.length = 0;
    database.updates.length = 0;

    jobRunner.register("fixture.unrelated", async (ctx) => {
      await ctx.log(sensitive);
      await ctx.checkpoint({ checkpoint: sensitive });
      return { result: sensitive };
    });
    await executeJob(
      "unrelated-success",
      "fixture.unrelated",
      payload,
      null,
      new AbortController().signal,
    );

    expect(database.inserts).toContainEqual(expect.objectContaining({ line: sensitive }));
    expect(database.updates).toContainEqual(
      expect.objectContaining({ result: { checkpoint: sensitive } }),
    );
    expect(database.updates).toContainEqual(
      expect.objectContaining({
        result: { checkpoint: sensitive, result: sensitive },
        status: "success",
      }),
    );
  });
});
