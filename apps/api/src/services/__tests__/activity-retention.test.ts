import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbMock, type DbMock } from "../../test/db.js";

const dbMock: DbMock = createDbMock();
vi.mock("../../db", () => ({ db: dbMock.db }));
vi.mock("../../db/schema", () => ({
  adminAuditLog: { id: "auditId", createdAt: "auditCreatedAt" },
  adminJob: { id: "jobId", finishedAt: "jobFinishedAt" },
}));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, lt: vi.fn((column: unknown, value: unknown) => ({ column, value })) };
});

const { lt } = await import("drizzle-orm");
const { pruneAuditLog, pruneCompletedJobs } = await import("../activity-retention.js");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-03T00:00:00.000Z");

describe("pruneAuditLog / pruneCompletedJobs retention guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each([
    {
      name: "pruneAuditLog",
      fn: pruneAuditLog,
      happyDays: 30,
    },
    {
      name: "pruneCompletedJobs",
      fn: pruneCompletedJobs,
      happyDays: 7,
    },
  ])("$name", ({ fn, happyDays }) => {
    it.each([
      ["0", 0],
      ["-5", -5],
      ["NaN", Number.NaN],
      ["+Infinity", Number.POSITIVE_INFINITY],
    ])("days = %s is a no-op guard", async (_label, days) => {
      const result = await fn(days);
      expect(result).toBe(0);
      expect(dbMock.db.delete).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    });

    it("deletes rows and computes the cutoff for a positive day count", async () => {
      dbMock.queueDelete([{ id: "a" }, { id: "b" }]);
      const result = await fn(happyDays);
      expect(result).toBe(2);
      expect(dbMock.db.delete).toHaveBeenCalledTimes(1);
      const expectedCutoff = new Date(NOW.getTime() - happyDays * MS_PER_DAY);
      expect(lt).toHaveBeenCalledWith(expect.anything(), expectedCutoff);
    });
  });
});
