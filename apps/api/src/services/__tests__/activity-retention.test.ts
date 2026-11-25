import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminJob } from "../../db/schema";
import { createDbMock, type DbMock } from "../../test/db.js";

const { processLogger } = vi.hoisted(() => ({
  processLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../../process-logger", () => ({ processLogger }));

const dbMock: DbMock = createDbMock();
vi.mock("../../db", () => ({ db: dbMock.db }));
vi.mock("drizzle-orm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("drizzle-orm")>();
  return { ...actual, lt: vi.fn((column: unknown, value: unknown) => ({ column, value })) };
});

const { lt } = await import("drizzle-orm");
const {
  DATA_MANAGER_JOB_RETENTION_DAYS,
  pruneAppLogs,
  pruneAuditLog,
  pruneCompletedJobs,
  pruneDataManagerJobs,
  pruneExpiredVerifications,
} = await import("../activity-retention.js");
const { retentionDays, retentionPeriods } = await import("../retention-settings.js");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-07-03T00:00:00.000Z");

describe("pruneAuditLog / pruneCompletedJobs retention guard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    vi.spyOn(processLogger, "warn").mockImplementation(() => {});
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
    {
      name: "pruneAppLogs",
      fn: pruneAppLogs,
      happyDays: 14,
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
      expect(processLogger.warn).toHaveBeenCalled();
    });

    it("deletes rows and computes the cutoff for a positive day count", async () => {
      if (fn === pruneCompletedJobs) {
        dbMock.queueDelete([]);
        dbMock.queueDelete([]);
      }
      dbMock.queueDelete([{ id: "a" }, { id: "b" }]);
      const result = await fn(happyDays);
      expect(result).toBe(2);
      if (fn === pruneCompletedJobs) expect(dbMock.db.delete).toHaveBeenLastCalledWith(adminJob);
      else expect(dbMock.db.delete).toHaveBeenCalledTimes(1);
      const expectedCutoff = new Date(NOW.getTime() - happyDays * MS_PER_DAY);
      expect(lt).toHaveBeenCalledWith(expect.anything(), expectedCutoff);
    });

    it("combines expiry with a durable preservation guard", async () => {
      dbMock.queueDelete([]);
      await fn(happyDays);
      const where = dbMock.db.delete.mock.results.at(-1)?.value.where;
      const query = new PgDialect().sqlToQuery(where.mock.calls[0][0]);
      expect(query.sql).toContain("not exists");
      expect(query.sql).toContain("data_subject_request_preservation");
      expect(query.sql).toContain("preservation_request.user_id");
      expect(query.params).toContain(
        fn === pruneAuditLog
          ? "admin-audit-attribution"
          : fn === pruneCompletedJobs
            ? "admin-jobs-attribution"
            : "application-logs",
      );
    });
  });

  it("deletes verification challenges that have expired", async () => {
    dbMock.queueDelete([{ id: "v1" }]);
    const result = await pruneExpiredVerifications();
    expect(result).toBe(1);
    expect(lt).toHaveBeenCalledWith(expect.anything(), NOW);
  });
});

// Its deletion against PostgreSQL is data-manager-job-retention-postgres.test.ts's.
describe("pruneDataManagerJobs retention guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(processLogger, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "days = %s is a no-op guard",
    async (days) => {
      expect(await pruneDataManagerJobs(days)).toBe(0);
      expect(dbMock.db.delete).not.toHaveBeenCalled();
      expect(processLogger.warn).toHaveBeenCalled();
    },
  );

  it("keeps finished jobs exactly as long as the privacy catalogue discloses", async () => {
    const { SUBJECT_DATA_CATALOGUE_BY_ID } = await import("../../privacy/catalogue.js");
    expect(SUBJECT_DATA_CATALOGUE_BY_ID.get("data-manager-trigger-attribution")?.retention).toEqual(
      expect.objectContaining({ kind: "fixed-days", days: DATA_MANAGER_JOB_RETENTION_DAYS }),
    );
    expect(DATA_MANAGER_JOB_RETENTION_DAYS).toBe(90);
  });
});

describe("retention periods", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("default to the periods the privacy catalogue discloses", async () => {
    const { SUBJECT_DATA_CATALOGUE_BY_ID } = await import("../../privacy/catalogue.js");
    for (const name of [
      "RETENTION_SERVER_LOG_DAYS",
      "RETENTION_PRIVACY_CASE_DAYS",
      "RETENTION_AUDIT_LOG_DAYS",
      "RETENTION_ADMIN_JOB_DAYS",
      "RETENTION_BACKUP_DAYS",
    ])
      vi.stubEnv(name, "");
    expect(await retentionPeriods({ database: null })).toEqual({
      serverLog: 30,
      privacyCase: 1095,
      auditLog: 365,
      adminJob: 30,
      backup: 30,
    });
    expect(SUBJECT_DATA_CATALOGUE_BY_ID.get("admin-audit-attribution")?.retention).toEqual(
      expect.objectContaining({ kind: "fixed-days", days: 365 }),
    );
    expect(SUBJECT_DATA_CATALOGUE_BY_ID.get("admin-jobs-attribution")?.retention).toEqual(
      expect.objectContaining({ kind: "fixed-days", days: 30 }),
    );
  });

  it("read the environment's period", async () => {
    vi.stubEnv("RETENTION_AUDIT_LOG_DAYS", "730");
    vi.stubEnv("RETENTION_BACKUP_DAYS", "14");
    expect(await retentionDays("auditLog", { database: null })).toBe(730);
    expect(await retentionDays("backup", { database: null })).toBe(14);
  });

  it.each([
    ["RETENTION_AUDIT_LOG_DAYS", "auditLog", "abc"],
    ["RETENTION_ADMIN_JOB_DAYS", "adminJob", "0"],
    ["RETENTION_BACKUP_DAYS", "backup", "36501"],
    ["RETENTION_SERVER_LOG_DAYS", "serverLog", "3651"],
    ["RETENTION_PRIVACY_CASE_DAYS", "privacyCase", "29"],
    ["RETENTION_BACKUP_DAYS", "backup", "1.5"],
  ] as const)("refuse %s=%s instead of falling back", async (name, period, value) => {
    vi.stubEnv(name, value);
    await expect(retentionDays(period, { database: null })).rejects.toThrow(name);
  });
});
