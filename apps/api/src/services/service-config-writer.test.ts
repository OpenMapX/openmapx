import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockUpdate = vi.fn();
const mockDelete = vi.fn();
const mockTransaction = vi.fn();
const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    transaction: (...args: unknown[]) => mockTransaction(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    delete: (...args: unknown[]) => mockDelete(...args),
  },
}));

import { mergeServiceConfig, persistServiceConfigPatch } from "./service-config-writer.js";

function renderSql(value: unknown): string {
  const dialect = new PgDialect();
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("mergeServiceConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInsert.mockReturnValue({ values: mockValues });
    mockValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
  });

  it("creates a service config row from only the supplied validated updates", async () => {
    await mergeServiceConfig("dawarich-app", { APPLICATION_HOST: "timeline.example.com" });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: "dawarich-app",
        config: { APPLICATION_HOST: "timeline.example.com" },
      }),
    );
  });

  it("atomically merges updates into the current JSONB value on conflict", async () => {
    await mergeServiceConfig("dawarich-app", { APPLICATION_HOST: "timeline.example.com" });

    const conflict = mockOnConflictDoUpdate.mock.calls[0]?.[0] as {
      set: { config: unknown };
    };
    expect(renderSql(conflict.set.config)).toBe(
      `coalesce("service_config"."config", '{}'::jsonb) || excluded."config"`,
    );
    expect(mockInsert).toHaveBeenCalledTimes(1);
  });

  it("does not swallow database errors", async () => {
    mockOnConflictDoUpdate.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(mergeServiceConfig("dawarich-app", { TZ: "Europe/Berlin" })).rejects.toThrow(
      "database unavailable",
    );
  });
});

describe("persistServiceConfigPatch failure boundaries", () => {
  const written = { id: "immutable", config: { before: 1, patch: 2 }, version: "42" };
  function transaction(
    previous = [{ id: "immutable", config: { before: 1 } }],
    returned: unknown[] = [written],
  ) {
    const returning = vi.fn().mockResolvedValue(returned);
    const where = vi.fn((_condition: SQL | undefined) => ({ returning }));
    const set = vi.fn((_value: { config: Record<string, unknown> }) => ({ where }));
    const tx = {
      select: vi.fn(() => ({
        from: () => ({ where: () => ({ for: vi.fn().mockResolvedValue(previous) }) }),
      })),
      update: vi.fn(() => ({ set })),
      insert: vi.fn(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) })),
      delete: vi.fn(() => ({ where })),
    };
    mockTransaction.mockImplementation(async (run) => run(tx));
    mockUpdate.mockImplementation(tx.update);
    mockDelete.mockImplementation(tx.delete);
    return { returning, where, set, tx };
  }

  it("returns only the inverse and retains locked prior data privately", async () => {
    const { returning, set, where } = transaction();
    const saved = await persistServiceConfigPatch("alpha", { patch: 2 });
    expect(Object.keys(saved)).toEqual(["restore"]);
    expect(set.mock.calls[0][0].config).toEqual({ before: 1, patch: 2 });
    returning.mockResolvedValueOnce([{ id: "immutable" }]);
    expect(await saved.restore()).toBe(true);
    expect(set.mock.calls[1][0].config).toEqual({ before: 1 });
    const condition = where.mock.calls[1][0];
    if (!condition) throw new Error("Missing inverse ownership predicate");
    const query = new PgDialect().sqlToQuery(condition);
    expect(query.sql).toContain('"service_config"."id" = $1');
    expect(query.sql).toContain("xmin::text = $2");
    expect(query.params).toEqual(["immutable", "42"]);
  });

  it("refuses an absent insertion conflict instead of adopting a contender", async () => {
    transaction([], []);
    await expect(persistServiceConfigPatch("alpha", { patch: 2 })).rejects.toThrow();
  });

  it("fails closed if the write returns no tuple evidence", async () => {
    transaction(undefined, [{ id: "immutable", config: {}, version: null }]);
    await expect(persistServiceConfigPatch("alpha", {})).rejects.toThrow();
  });

  it("propagates inverse database failure rather than treating it as ownership loss", async () => {
    const { returning } = transaction();
    const saved = await persistServiceConfigPatch("alpha", {});
    const failure = new Error("inverse unavailable");
    returning.mockRejectedValueOnce(failure);
    await expect(saved.restore()).rejects.toBe(failure);
  });
});
