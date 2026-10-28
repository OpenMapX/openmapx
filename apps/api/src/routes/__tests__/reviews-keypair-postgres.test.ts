import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mangroveKeypair, mangroveKeypairWrap, user } from "../../db/schema";
import { buildTestApp } from "../../test/app";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const connection = vi.hoisted(() => ({
  db: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>["db"],
}));
vi.mock("../../db/index", () => ({
  get db() {
    return connection.db;
  },
}));
vi.mock("../../utils/require-auth", () => ({
  requireAuthHook: async () => {},
  getUserId: () => "mangrove-test",
}));

// This fixture always starts its own PostGIS container and never reads DATABASE_URL.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "encrypted Mangrove CAS in migrated PostGIS",
  () => {
    let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>, app: FastifyInstance;
    beforeAll(async () => {
      fixture = await createMigratedPostgresFixture();
      connection.db = fixture.db;
      const { reviewsKeypairRoute } = await import("../reviews-keypair");
      app = await buildTestApp(reviewsKeypairRoute, { prefix: "/api" });
      await fixture.db
        .insert(user)
        .values({ id: "mangrove-test", name: "Mangrove Test", email: "mangrove@example.test" });
    }, 120_000);
    afterAll(async () => {
      try {
        await app?.close();
      } finally {
        await fixture?.stop();
      }
    });
    beforeEach(async () => {
      await fixture.db.delete(mangroveKeypair).where(eq(mangroveKeypair.userId, "mangrove-test"));
    });
    const initial = {
      publicJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
      passphraseCiphertext: "original",
      wraps: [{ wrapType: "passphrase", label: "Original" }],
    };
    const create = (payload = initial) =>
      app.inject({ method: "POST", url: "/api/reviews/keypair", payload });
    const update = (revision: string, label: string) =>
      app.inject({
        method: "PUT",
        url: "/api/reviews/keypair/wraps",
        payload: {
          expectedRevision: revision,
          passphraseCiphertext: label,
          wraps: [{ wrapType: "passphrase", label }],
        },
      });
    const remove = (revision: string) =>
      app.inject({
        method: "DELETE",
        url: "/api/reviews/keypair",
        payload: { expectedRevision: revision },
      });
    const get = () => app.inject({ method: "GET", url: "/api/reviews/keypair" });

    it("preserves historical migration records and drops plaintext columns", async () => {
      const columns =
        await fixture.sql`SELECT column_name FROM information_schema.columns WHERE table_name='mangrove_keypair'`;
      expect(columns.map((c) => c.column_name)).toContain("revision");
      expect(columns.map((c) => c.column_name)).not.toContain("encryption_mode");
      expect(columns.map((c) => c.column_name)).not.toContain("private_jwk");
      const journal = JSON.parse(
        await readFile(new URL("../../db/migrations/meta/_journal.json", import.meta.url), "utf8"),
      );
      expect(journal.entries.at(-1).tag).toBe("0043_mangrove_encrypted_revision");
      const applied =
        await fixture.sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      expect(applied[0].count).toBe(journal.entries.length);
    });
    it("applies the new migration to historical encrypted and plaintext development rows", async () => {
      const initialSql = await readFile(
        new URL("../../db/migrations/0000_initial.sql", import.meta.url),
        "utf8",
      );
      const newSql = await readFile(
        new URL("../../db/migrations/0043_mangrove_encrypted_revision.sql", import.meta.url),
        "utf8",
      );
      const tableStatements = initialSql
        .split("--> statement-breakpoint")
        .filter((statement) => statement.includes('CREATE TABLE "mangrove_keypair'));
      await fixture.sql.begin(async (sql) => {
        await sql`CREATE SCHEMA mangrove_migration_fixture`;
        await sql`SET LOCAL search_path TO mangrove_migration_fixture, public`;
        for (const statement of tableStatements) await sql.unsafe(statement);
        await sql`ALTER TABLE mangrove_keypair_wrap ADD FOREIGN KEY (user_id) REFERENCES mangrove_keypair(user_id) ON DELETE CASCADE`;
        await sql`INSERT INTO mangrove_keypair(user_id,encryption_mode,public_jwk,private_jwk,passphrase_ciphertext) VALUES ('plain','unencrypted','{}','{}',null), ('encrypted','encrypted','{}',null,'retained')`;
        await sql`INSERT INTO mangrove_keypair_wrap(id,user_id,wrap_type,label) VALUES ('plain-wrap','plain','passphrase','Plain'), ('encrypted-wrap','encrypted','passphrase','Encrypted')`;
        for (const statement of newSql.split("--> statement-breakpoint"))
          if (statement.trim()) await sql.unsafe(statement);
        const rows = await sql`SELECT * FROM mangrove_keypair`;
        expect(rows).toHaveLength(1);
        expect(rows[0].user_id).toBe("encrypted");
        expect(rows[0].revision).toBeTypeOf("string");
        expect(rows[0].passphrase_ciphertext).toBe("retained");
        expect(rows[0]).not.toHaveProperty("private_jwk");
        const wraps = await sql`SELECT * FROM mangrove_keypair_wrap`;
        expect(wraps).toHaveLength(1);
        expect(wraps[0].user_id).toBe("encrypted");
        await sql`DROP SCHEMA mangrove_migration_fixture CASCADE`;
      });
    });
    it("GET keeps one real transaction snapshot across a concurrent wrap replacement", async () => {
      await create();
      const before = (await get()).json();
      let parentRead!: () => void, resume!: () => void;
      const read = new Promise<void>((r) => {
          parentRead = r;
        }),
        gate = new Promise<void>((r) => {
          resume = r;
        });
      // Pause only after the real parent SELECT; the concurrent route still uses
      // real independent transactions and commits before the GET reads its wraps.
      function pausedBuilder<T extends object>(builder: T): T {
        return new Proxy(builder, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (typeof value !== "function") return value;
            if (key === "then") return value.bind(target);
            return (...args: unknown[]) => {
              const next = Reflect.apply(value, target, args);
              if (key === "limit")
                return Promise.resolve(next).then(async (rows) => {
                  parentRead();
                  await gate;
                  return rows;
                });
              return pausedBuilder(next);
            };
          },
        });
      }
      const transaction = fixture.db.transaction.bind(fixture.db);
      const spy = vi.spyOn(fixture.db, "transaction").mockImplementationOnce((callback, config) =>
        transaction(
          (tx) =>
            callback(
              new Proxy(tx, {
                get(target, key) {
                  if (key === "select")
                    return (...args: unknown[]) =>
                      pausedBuilder(Reflect.apply(target.select, target, args));
                  const value = Reflect.get(target, key);
                  return typeof value === "function" ? value.bind(target) : value;
                },
              }),
            ),
          config,
        ),
      );
      try {
        const getting = get();
        await read;
        expect((await update(before.revision, "replacement")).statusCode).toBe(200);
        resume();
        expect((await getting).json()).toEqual(before);
        expect((await get()).json().wraps[0].label).toBe("replacement");
      } finally {
        resume();
        spy.mockRestore();
      }
    });
    it("admits one simultaneous create and no orphan wraps", async () => {
      const results = await Promise.all([create(), create()]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(await fixture.db.select().from(mangroveKeypairWrap)).toHaveLength(1);
    });
    it("admits exactly one concurrent update and leaves all losing state unchanged", async () => {
      const revision = (await create()).json().revision;
      const results = await Promise.all([update(revision, "A"), update(revision, "B")]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const env = (await get()).json();
      const winner = results.find((r) => r.statusCode === 200);
      if (!winner) throw new Error("No update succeeded");
      expect(env.revision).toBe(winner.json().revision);
      expect(env.revision).not.toBe(revision);
      expect(env.wraps).toHaveLength(1);
      expect(env.wraps[0].label).toBe(env.passphraseCiphertext);
    });
    it("serializes update/delete and refuses stale operations after delete/recreate", async () => {
      const revision = (await create()).json().revision;
      const results = await Promise.all([update(revision, "new"), remove(revision)]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const current = await get();
      if (current.statusCode === 200)
        expect((await remove(current.json().revision)).statusCode).toBe(200);
      expect(await fixture.db.select().from(mangroveKeypairWrap)).toHaveLength(0);
      const recreated = (
        await create({ ...initial, publicJwk: { ...initial.publicJwk, x: "replacement" } })
      ).json().revision;
      expect(recreated).not.toBe(revision);
      expect((await update(revision, "old-private-key")).statusCode).toBe(409);
      expect((await remove(revision)).statusCode).toBe(409);
      const env = (await get()).json();
      expect(env.publicJwk.x).toBe("replacement");
      expect(env.revision).toBe(recreated);
      expect(env.wraps[0].label).toBe("Original");
    });
    it("rolls back parent revision, ciphertext and removed wraps when wrap insertion fails", async () => {
      const revision = (await create()).json().revision;
      const before = (await get()).json();
      await fixture.sql`CREATE FUNCTION mangrove_reject_wrap() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.label = 'reject-write' THEN RAISE EXCEPTION 'test wrap rejection'; END IF; RETURN NEW; END $$`;
      await fixture.sql`CREATE TRIGGER mangrove_reject_wrap BEFORE INSERT ON mangrove_keypair_wrap FOR EACH ROW EXECUTE FUNCTION mangrove_reject_wrap()`;
      try {
        expect((await update(revision, "reject-write")).statusCode).toBe(500);
        expect((await get()).json()).toEqual(before);
        await remove(revision);
        expect(
          (await create({ ...initial, wraps: [{ wrapType: "passphrase", label: "reject-write" }] }))
            .statusCode,
        ).toBe(500);
        expect((await get()).statusCode).toBe(204);
        expect(await fixture.db.select().from(mangroveKeypairWrap)).toHaveLength(0);
      } finally {
        await fixture.sql`DROP TRIGGER mangrove_reject_wrap ON mangrove_keypair_wrap`;
        await fixture.sql`DROP FUNCTION mangrove_reject_wrap()`;
      }
    });
  },
);
