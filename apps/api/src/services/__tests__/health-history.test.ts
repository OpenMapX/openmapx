import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const driver = vi.hoisted(() => ({ delete: vi.fn(), where: vi.fn() }));
vi.mock("../../db", () => ({ db: { delete: driver.delete } }));

import { pruneOldRecords } from "../health-history";

function result(count: unknown, command: unknown = "DELETE", rows: unknown[] = []) {
  return Object.assign(rows, { count, command });
}

describe("health history DELETE command metadata", () => {
  beforeEach(() => {
    driver.delete.mockReset().mockReturnValue({ where: driver.where });
    driver.where.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([undefined, 7])("retains the original default/custom days cutoff %s", async (days) => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-10-11T12:00:00Z").getTime());
    driver.where.mockResolvedValue(result(0));
    await pruneOldRecords(days);
    const query = new PgDialect().sqlToQuery(driver.where.mock.calls[0]?.[0]);
    expect(query.sql).toBe('"health_history"."checked_at" < $1');
    expect(query.params).toEqual([new Date(Date.now() - (days ?? 30) * 86400000).toISOString()]);
  });

  it.each([0, 350000, 1050000])(
    "returns exact native count %i without returning IDs",
    async (count) => {
      driver.where.mockResolvedValue(result(count));
      expect(await pruneOldRecords()).toBe(count);
      expect(driver.delete).toHaveBeenCalledTimes(1);
      expect(driver.where).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    undefined,
    null,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "2",
  ])("rejects invalid native count %s", async (count) => {
    driver.where.mockResolvedValue(result(count));
    await expect(pruneOldRecords()).rejects.toThrow(
      "Unexpected health history DELETE command metadata",
    );
    expect(driver.delete).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "SELECT", "UPDATE"])("rejects unexpected command %s", async (command) => {
    driver.where.mockResolvedValue(Object.assign([], { count: 2, command }));
    await expect(pruneOldRecords()).rejects.toThrow(
      "Unexpected health history DELETE command metadata",
    );
  });

  it("rejects transferred row metadata instead of treating it as a count", async () => {
    driver.where.mockResolvedValue(result(1, "DELETE", [{ id: 1 }]));
    await expect(pruneOldRecords()).rejects.toThrow(
      "Unexpected health history DELETE command metadata",
    );
  });

  it("propagates the exact single-statement failure without retrying", async () => {
    const failure = new Error("lost acknowledgement: outcome unknown");
    driver.where.mockRejectedValue(failure);
    await expect(pruneOldRecords()).rejects.toBe(failure);
    expect(driver.delete).toHaveBeenCalledTimes(1);
    expect(driver.where).toHaveBeenCalledTimes(1);
  });
});
