import { describe, expect, it, vi } from "vitest";
import { applyRequiredMigrations } from "./startup-migrations.js";

describe("applyRequiredMigrations", () => {
  it("completes the required migration before startup can continue", async () => {
    const order: string[] = [];

    await applyRequiredMigrations({
      migrationsDirectory: "/app/migrations",
      directoryExists: () => true,
      migrate: async () => {
        order.push("migrate");
      },
    });
    order.push("continue-startup");

    expect(order).toEqual(["migrate", "continue-startup"]);
  });

  it("rejects a failed migration so startup never reaches its listener", async () => {
    const listen = vi.fn();

    await expect(
      (async () => {
        await applyRequiredMigrations({
          migrationsDirectory: "/app/migrations",
          directoryExists: () => true,
          migrate: async () => {
            throw new Error("database refused migration");
          },
        });
        listen();
      })(),
    ).rejects.toThrow("Required database migration failed");

    expect(listen).not.toHaveBeenCalled();
  });

  it("rejects a missing migration artifact rather than skipping schema setup", async () => {
    const migrate = vi.fn();

    await expect(
      applyRequiredMigrations({
        migrationsDirectory: "/app/migrations",
        directoryExists: () => false,
        migrate,
      }),
    ).rejects.toThrow("Required database migrations are missing");

    expect(migrate).not.toHaveBeenCalled();
  });
});
