import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { accountAdminGuard, user } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("last-admin migration of historical roles", () => {
  it("rejects unknown roles without partial activation, then normalizes recognized combinations under the write lock", async () => {
    const fixture = await createMigratedPostgresFixture({ throughMigration: 43 });
    const apply = () =>
      migrate(fixture.db, {
        migrationsFolder: fileURLToPath(new URL("../db/migrations", import.meta.url)),
      });
    try {
      await fixture.db.insert(user).values([
        { id: "legacy-a", name: "Synthetic A", email: "legacy-a@example.test", role: "admin,user" },
        {
          id: "legacy-b",
          name: "Synthetic B",
          email: "legacy-b@example.test",
          role: "admin,privacy_admin",
        },
        {
          id: "legacy-c",
          name: "Synthetic C",
          email: "legacy-c@example.test",
          role: "privacy_admin,user",
        },
        {
          id: "legacy-unknown",
          name: "Synthetic unknown",
          email: "legacy-unknown@example.test",
          role: "foreign_admin",
        },
      ]);
      await expect(apply()).rejects.toThrow();
      expect((await fixture.db.select().from(user).where(eq(user.id, "legacy-a")))[0]?.role).toBe(
        "admin,user",
      );
      await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, "legacy-unknown"));
      await apply();
      expect((await fixture.db.select().from(user).orderBy(user.id)).map((r) => r.role)).toEqual([
        "admin",
        "admin",
        "privacy_admin",
        "user",
      ]);
      expect((await fixture.db.select().from(accountAdminGuard))[0]?.activeCount).toBe(2);
      await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, "legacy-a"));
      await expect(
        fixture.db.update(user).set({ banned: true }).where(eq(user.id, "legacy-b")),
      ).rejects.toThrow();
      await expect(
        fixture.db.update(user).set({ role: "admin,user" }).where(eq(user.id, "legacy-c")),
      ).rejects.toThrow();
    } finally {
      await fixture.stop();
    }
  }, 90000);
});
