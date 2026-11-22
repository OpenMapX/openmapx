import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

let container: StartedPostgreSqlContainer;

async function freshDatabase(name: string): Promise<Sql> {
  const admin = postgres(container.getConnectionUri(), { max: 1 });
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(container.getConnectionUri());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 2, onnotice: () => {} });
  await sql`CREATE EXTENSION IF NOT EXISTS postgis`;
  return sql;
}

async function migrateToHead(sql: Sql): Promise<void> {
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
}

integration("the API migration baseline", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer(
      "ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7",
    )
      .withStartupTimeout(60_000)
      .start();
  }, 180_000);

  afterAll(async () => {
    await container?.stop();
  });

  it("migrates an empty database to head once and applies nothing on a second run", async () => {
    const sql = await freshDatabase("fresh");
    try {
      await migrateToHead(sql);
      expect(await sql`SELECT active_count FROM account_admin_guard WHERE id = 1`).toEqual([
        { active_count: 0 },
      ]);
      const before =
        await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      expect(before).toHaveLength(2);
      await migrateToHead(sql);
      expect(
        await sql`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
      ).toEqual(before);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it("lets only one extension own a component", async () => {
    const sql = await freshDatabase("component_ownership");
    try {
      await migrateToHead(sql);
      await sql`
        INSERT INTO installed_extension (id, name, installed_version) VALUES
          ('ext-a', 'Extension A', '1.0.0'),
          ('ext-b', 'Extension B', '1.0.0')
      `;
      await sql`
        INSERT INTO installed_extension_component (extension_id, kind, component_id) VALUES
          ('ext-a', 'integration', 'overlay-one'),
          ('ext-a', 'service', 'overlay-one')
      `;
      await expect(
        sql`
          INSERT INTO installed_extension_component (extension_id, kind, component_id)
          VALUES ('ext-b', 'integration', 'overlay-one')
        `,
      ).rejects.toMatchObject({
        constraint_name: "installedExtensionComponent_kind_componentId_key",
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it("a second account with the same provider and account id is refused", async () => {
    const sql = await freshDatabase("account_identity");
    try {
      await migrateToHead(sql);
      await sql`
        INSERT INTO "user" (id, name, email, updated_at) VALUES
          ('user-a', 'A', 'a@example.test', now()),
          ('user-b', 'B', 'b@example.test', now())
      `;
      await sql`
        INSERT INTO account (id, account_id, provider_id, user_id, updated_at)
        VALUES ('account-a', 'osm-42', 'osm', 'user-a', now())
      `;
      await expect(
        sql`
          INSERT INTO account (id, account_id, provider_id, user_id, updated_at)
          VALUES ('account-b', 'osm-42', 'osm', 'user-b', now())
        `,
      ).rejects.toMatchObject({ constraint_name: "account_provider_id_account_id_key" });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it("a duplicate passkey credential id is refused", async () => {
    const sql = await freshDatabase("passkey_credential");
    try {
      await migrateToHead(sql);
      await sql`
        INSERT INTO "user" (id, name, email, updated_at) VALUES
          ('user-a', 'A', 'a@example.test', now()),
          ('user-b', 'B', 'b@example.test', now())
      `;
      await sql`
        INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
        VALUES ('passkey-a', 'key-a', 'user-a', 'credential-1', 0, 'singleDevice', false)
      `;
      await expect(
        sql`
          INSERT INTO passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up)
          VALUES ('passkey-b', 'key-b', 'user-b', 'credential-1', 0, 'singleDevice', false)
        `,
      ).rejects.toMatchObject({ constraint_name: "passkey_credential_id_key" });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);

  it("indexes every data_manager foreign key that cascades or nulls on delete", async () => {
    const sql = await freshDatabase("data_manager_fk_indexes");
    try {
      await migrateToHead(sql);

      // A referencing column needs an index whose leading columns are exactly
      // the key's columns, or each parent delete scans the whole child table.
      const unindexed = await sql<{ constraint: string }[]>`
        SELECT fk.conname AS constraint
        FROM pg_constraint fk
        JOIN pg_namespace ns ON ns.oid = fk.connamespace
        WHERE fk.contype = 'f'
          AND fk.confdeltype IN ('c', 'n')
          AND ns.nspname = 'data_manager'
          AND NOT EXISTS (
            SELECT 1 FROM pg_index ix
            WHERE ix.indrelid = fk.conrelid
              AND ix.indnkeyatts >= cardinality(fk.conkey)
              AND (ix.indkey::int2[])[0:cardinality(fk.conkey) - 1] @> fk.conkey
              AND fk.conkey @> (ix.indkey::int2[])[0:cardinality(fk.conkey) - 1]
          )
        ORDER BY fk.conname
      `;
      expect(unindexed).toEqual([]);
    } finally {
      await sql.end({ timeout: 5 });
    }
  }, 120_000);
});
