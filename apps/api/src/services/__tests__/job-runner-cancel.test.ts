import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const cancelOperations = vi.hoisted(() => vi.fn());
const database = vi.hoisted(() => {
  const updates: Array<Record<string, unknown>> = [];
  const result = {
    opsProjection: {
      version: 1,
      eventTotal: 0,
      byteTotal: 0,
      truncated: false,
      operations: {},
    },
  };
  return {
    updates,
    result,
    db: {
      update: vi.fn(() => ({
        set: vi.fn((value: Record<string, unknown>) => {
          updates.push(value);
          return {
            where: vi.fn(() => ({
              returning: vi
                .fn()
                .mockResolvedValue(
                  value.status === "canceled" && updates.length === 1
                    ? []
                    : [{ id: "job-1", status: value.status ?? "running", result }],
                ),
              // biome-ignore lint/suspicious/noThenProperty: the Drizzle query builder is thenable.
              then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
            })),
          };
        }),
      })),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([{ status: "running", result }]),
          })),
        })),
      })),
    },
  };
});

vi.mock("../../db", () => ({ db: database.db }));
vi.mock("../admin-job-ops", () => ({ cancelAdminJobOperations: cancelOperations }));

const { jobRunner } = await import("../job-runner");

beforeEach(() => {
  database.updates.length = 0;
  vi.clearAllMocks();
});

describe("admin job cancellation", () => {
  it("cancels through the persisted agent projection before reporting canceled", async () => {
    cancelOperations.mockResolvedValue("canceled");

    await expect(jobRunner.cancel("job-1")).resolves.toBe(true);

    expect(cancelOperations).toHaveBeenCalledWith(
      database.result,
      undefined,
      expect.objectContaining({ onEvidence: expect.any(Function) }),
    );
    expect(database.updates).toContainEqual(expect.objectContaining({ status: "cancel_pending" }));
    expect(database.updates).toContainEqual(
      expect.objectContaining({ status: "canceled", finishedAt: expect.any(Date) }),
    );
  });

  it("does not report cancellation while the agent remains nonterminal", async () => {
    cancelOperations.mockResolvedValue("pending");

    await expect(jobRunner.cancel("job-1")).resolves.toBe(false);
    expect(database.updates.at(-1)).toMatchObject({ status: "cancel_pending" });
  });
});

it("observer abort without backend containment never publishes canceled", async () => {
  const controller = new AbortController();
  jobRunner.register("test.observer-abort", async () => {
    controller.abort();
    throw new DOMException("Aborted", "AbortError");
  });
  const execute = jobRunner as unknown as {
    executeJob(
      id: string,
      type: string,
      payload: Record<string, unknown>,
      result: Record<string, unknown> | null,
      signal: AbortSignal,
    ): Promise<void>;
  };
  await execute.executeJob("job-1", "test.observer-abort", {}, null, controller.signal);
  expect(database.updates).not.toContainEqual(expect.objectContaining({ status: "canceled" }));
  const patch = new PgDialect().sqlToQuery(database.updates.at(-1)?.result as SQL);
  expect(JSON.parse(patch.params[0] as string)).toMatchObject({
    observation: { state: "unknown" },
  });
});

it("retains a fulfilled backend's partial failure evidence in failed DB and SSE results", async () => {
  const { ApiOpsError } = await import("../ops-client");
  const { jobEventBus } = await import("../job-events");
  const evidence = {
    serviceBatch: {
      outcome: "partial" as const,
      completedServiceIds: ["tileserver"],
      failedServiceIds: ["valhalla"],
      skippedServiceIds: [],
    },
  };
  const events: unknown[] = [];
  const unsubscribe = jobEventBus.subscribe("job-evidence", ({ event }) => events.push(event));
  jobRunner.register("test.partial", async () => {
    const result = await Promise.resolve(evidence);
    throw new ApiOpsError("runtime", result);
  });
  await (jobRunner as unknown as { executeJob(...args: unknown[]): Promise<void> }).executeJob(
    "job-evidence",
    "test.partial",
    {},
    { phase: "build" },
    new AbortController().signal,
  );
  unsubscribe();
  const failed = database.updates.find((update) => update.status === "failed");
  expect(failed).toBeDefined();
  const stored = new PgDialect().sqlToQuery(failed!.result as SQL);
  expect(JSON.parse(stored.params[0] as string)).toMatchObject({ phase: "build", ...evidence });
  expect(events).toContainEqual(
    expect.objectContaining({
      status: "failed",
      result: expect.objectContaining(evidence),
    }),
  );
});
