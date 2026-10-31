import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { describe, expect, it } from "vitest";
import { accountAdminGuard, user } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("last-admin migration of historical roles", () => {
  it("upgrades deployed main history without skipping the earlier-numbered admin SQL", async () => {
    const fixture = await createMigratedPostgresFixture({ throughMigration: 43 });
    try {
      await fixture.sql`INSERT INTO "user" (id,name,email,role) VALUES ('main-admin','Synthetic main administrator','main-admin@example.test','admin')`;
      await migrate(fixture.db, {
        migrationsFolder: fileURLToPath(new URL("../db/migrations", import.meta.url)),
      });
      const rows = await fixture.sql`SELECT name,role FROM "user" WHERE id='main-admin'`;
      expect(rows[0]).toMatchObject({ name: "Synthetic main administrator", role: "admin" });
      const columns =
        await fixture.sql`SELECT table_schema,table_name,column_name FROM information_schema.columns WHERE (table_schema='data_manager' AND table_name='jobs' AND column_name='execution_version') OR (table_schema='public' AND table_name='installed_integration' AND column_name='last_transaction_id') OR (table_schema='public' AND table_name='mangrove_keypair' AND column_name='revision')`;
      expect(columns).toHaveLength(3);
      expect((await fixture.db.select().from(accountAdminGuard))[0]?.activeCount).toBe(1);
      const count = await fixture.sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      expect(count[0]?.n).toBe(55);
    } finally {
      await fixture.stop();
    }
  }, 90000);
  it("rejects unknown roles without partial activation, then normalizes recognized combinations under the write lock", async () => {
    const fixture = await createMigratedPostgresFixture({ throughMigration: 45 });
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
