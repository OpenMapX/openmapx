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
              returning: vi.fn().mockResolvedValue([]),
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

    expect(cancelOperations).toHaveBeenCalledWith(database.result);
    expect(database.updates).toContainEqual({ status: "cancel_pending" });
    expect(database.updates).toContainEqual(
      expect.objectContaining({ status: "canceled", finishedAt: expect.any(Date) }),
    );
  });

  it("does not report cancellation while the agent remains nonterminal", async () => {
    cancelOperations.mockResolvedValue("pending");

    await expect(jobRunner.cancel("job-1")).resolves.toBe(false);
    expect(database.updates.at(-1)).toEqual({ status: "cancel_pending" });
  });
});
