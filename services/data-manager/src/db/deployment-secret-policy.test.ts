import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let originalNodeEnv: string | undefined;
let originalDatabaseUrl: string | undefined;

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
  originalDatabaseUrl = process.env.DATABASE_URL;
});

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  vi.resetModules();
});

describe("data-manager database bootstrap deployment-secret policy", () => {
  it("fails closed in production with a redacted error", async () => {
    const rejected = "private-manager-fixture";
    const databaseUrl = `postgresql://database_owner:${rejected}@database.invalid/openmapx`;
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = databaseUrl;
    vi.resetModules();

    const result = import("./index");
    await expect(result).rejects.toThrow(/too-short/);
    try {
      await result;
    } catch (error) {
      expect((error as Error).message).not.toContain(rejected);
      expect((error as Error).message).not.toContain(databaseUrl);
    }
  });

  it("keeps short local test fixtures available outside production", async () => {
    process.env.NODE_ENV = "development";
    process.env.DATABASE_URL = "postgresql://postgres:postgres@localhost:5432/openmapx";
    vi.resetModules();

    const module = await import("./index");
    await expect(module.sql.end({ timeout: 0 })).resolves.toBeUndefined();
  });
});
