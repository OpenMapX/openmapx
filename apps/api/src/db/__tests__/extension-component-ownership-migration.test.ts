import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = join(import.meta.dirname, "..", "migrations", "0015_fair_emma_frost.sql");
const DOWN_MIGRATION = join(
  import.meta.dirname,
  "..",
  "migrations",
  "down",
  "0015_fair_emma_frost.down.sql",
);

const integration = describe.runIf(process.env.OPENMAPX_POSTGRES_TESTS === "1");

let container: StartedPostgreSqlContainer;
let sql: Sql;

/** Apply a migration file the way the runner does: statement by statement. */
async function applyMigration(path: string): Promise<void> {
  const contents = readFileSync(path, "utf8");
  for (const statement of contents.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await sql.unsafe(trimmed);
  }
}

integration("single-extension component ownership migration", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 4 });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  afterEach(async () => {
    await sql`DROP TABLE IF EXISTS installed_extension_component`;
  });

  async function createTable(): Promise<void> {
    await sql`
      CREATE TABLE installed_extension_component (
        extension_id text NOT NULL,
        kind text NOT NULL,
        component_id text NOT NULL,
        PRIMARY KEY (extension_id, kind, component_id)
      )
    `;
  }

  it("aborts and names every conflicting component instead of choosing a winner", async () => {
    await createTable();
    await sql`
      INSERT INTO installed_extension_component (extension_id, kind, component_id) VALUES
        ('ext-a', 'integration', 'shared-overlay'),
        ('ext-b', 'integration', 'shared-overlay'),
        ('ext-a', 'service', 'shared-ingest'),
        ('ext-c', 'service', 'shared-ingest'),
        ('ext-a', 'service', 'unique-one')
    `;

    await expect(applyMigration(MIGRATION)).rejects.toThrow(
      /integration:shared-overlay.*service:shared-ingest/s,
    );

    // Nothing was removed or reassigned.
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM installed_extension_component
    `;
    expect(count).toBe("5");
    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'installedExtensionComponent_kind_componentId_key'
    `;
    expect(indexes).toHaveLength(0);
  });

  it("creates the unique index when ownership is already single-extension", async () => {
    await createTable();
    await sql`
      INSERT INTO installed_extension_component (extension_id, kind, component_id) VALUES
        ('ext-a', 'integration', 'overlay-one'),
        ('ext-b', 'integration', 'overlay-two'),
        ('ext-a', 'service', 'overlay-one')
    `;

    await applyMigration(MIGRATION);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'installedExtensionComponent_kind_componentId_key'
    `;
    expect(indexes).toHaveLength(1);

    // A second extension can no longer claim an already-owned component.
    await expect(
      sql`
        INSERT INTO installed_extension_component (extension_id, kind, component_id)
        VALUES ('ext-c', 'integration', 'overlay-one')
      `,
    ).rejects.toThrow();
  });

  it("is reversible", async () => {
    await createTable();
    await applyMigration(MIGRATION);
    await applyMigration(DOWN_MIGRATION);

    const indexes = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE indexname = 'installedExtensionComponent_kind_componentId_key'
    `;
    expect(indexes).toHaveLength(0);
  });
});
