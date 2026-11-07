import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockOnConflictDoUpdate = vi.fn();

vi.mock("../db/index.js", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

import { mergeServiceConfig } from "./service-config-writer.js";

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
