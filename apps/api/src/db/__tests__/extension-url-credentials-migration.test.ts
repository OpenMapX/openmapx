import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const MIGRATION = join(
  import.meta.dirname,
  "..",
  "migrations",
  "0043_scrub_extension_url_credentials.sql",
);
const SECRET = "openmapx-secret-sentinel";
const UNSAFE_URL = `https://user:${SECRET}@example.test/archive.tgz?token=${SECRET}#part`;

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

let container: StartedPostgreSqlContainer;
let sql: Sql;

async function applyMigration(): Promise<void> {
  const contents = readFileSync(MIGRATION, "utf8");
  for (const statement of contents.split("--> statement-breakpoint")) {
    const trimmed = statement.trim();
    if (trimmed) await sql.unsafe(trimmed);
  }
}

async function snapshot(): Promise<string> {
  const rows = await sql`
    SELECT 'extension' AS kind, id, row_to_json(e)::text AS value
      FROM installed_extension e
    UNION ALL
    SELECT 'integration', id, row_to_json(i)::text FROM installed_integration i
    UNION ALL
    SELECT 'repository', hash, row_to_json(r)::text FROM service_repository r
    UNION ALL
    SELECT 'job', id, row_to_json(j)::text FROM admin_job j
    UNION ALL
    SELECT 'log', id, row_to_json(l)::text FROM admin_job_log l
    ORDER BY kind, id
  `;
  return JSON.stringify(rows);
}

integration("extension URL credential cleanup migration", () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:18-alpine").start();
    sql = postgres(container.getConnectionUri(), { max: 4, onnotice: () => {} });
  }, 180_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await container?.stop();
  });

  afterEach(async () => {
    await sql`DROP TABLE IF EXISTS admin_job_log, admin_job, service_repository, installed_integration, installed_extension`;
  });

  async function createFixtures(): Promise<void> {
    await sql.unsafe(`
      CREATE TABLE installed_extension (
        id text PRIMARY KEY,
        source_url text,
        manifest jsonb
      );
      CREATE TABLE installed_integration (
        id text PRIMARY KEY,
        repository text NOT NULL,
        managed_by_extension text
      );
      CREATE TABLE service_repository (
        hash text PRIMARY KEY,
        url text NOT NULL UNIQUE,
        managed_by_extension text NOT NULL
      );
      CREATE TABLE admin_job (
        id text PRIMARY KEY,
        type text NOT NULL,
        payload jsonb,
        result jsonb,
        error text
      );
      CREATE TABLE admin_job_log (
        id text PRIMARY KEY,
        job_id text NOT NULL REFERENCES admin_job(id),
        line text NOT NULL
      )
    `);

    await sql`
      INSERT INTO installed_extension (id, source_url, manifest) VALUES
        ('unsafe-extension', ${UNSAFE_URL}, ${sql.json({
          integrations: [{ id: "unsafe", artifact: UNSAFE_URL, sha256: "a".repeat(64) }],
          services: [{ service: "unsafe", repo: UNSAFE_URL }],
        })}),
        ('clean-extension', 'https://example.test/extension.json', ${sql.json({
          integrations: [{ id: "clean", artifact: "https://example.test/clean.tgz" }],
        })});
    `;
    await sql`
      INSERT INTO installed_integration (id, repository, managed_by_extension) VALUES
        ('unsafe-integration', ${UNSAFE_URL}, 'unsafe-extension'),
        ('manual-integration', 'https://example.test/manual.tgz', NULL);
    `;
    await sql`
      INSERT INTO service_repository (hash, url, managed_by_extension) VALUES
        ('unsafe-repository', ${UNSAFE_URL}, 'unsafe-extension');
    `;
    await sql`
      INSERT INTO admin_job (id, type, payload, result, error) VALUES
        ('unsafe-job', 'extension.install', ${sql.json({ sourceUrl: UNSAFE_URL })},
          ${sql.json({ nested: [UNSAFE_URL] })}, ${`Fetch failed for ${UNSAFE_URL}`}),
        ('other-job', 'system.update', ${sql.json({ url: "https://example.test/keep", keep: "exact" })},
          ${sql.json({ url: "https://example.test/keep" })}, 'Keep exact');
    `;
    await sql`
      INSERT INTO admin_job_log (id, job_id, line) VALUES
        ('unsafe-log', 'unsafe-job', ${`Downloading ${UNSAFE_URL}`}),
        ('other-log', 'other-job', 'Keep exact');
    `;
  }

  it("removes unsafe extension locators, preserves unrelated jobs, and is idempotent", async () => {
    await createFixtures();
    const [unrelatedBefore] = await sql`
      SELECT row_to_json(j)::text AS job,
             (SELECT row_to_json(l)::text FROM admin_job_log l WHERE l.job_id = j.id) AS log
        FROM admin_job j WHERE id = 'other-job'
    `;

    await applyMigration();

    const first = await snapshot();
    expect(first).not.toContain(SECRET);
    const [extension] = await sql<{ source_url: string | null; manifest: unknown }[]>`
      SELECT source_url, manifest FROM installed_extension WHERE id = 'unsafe-extension'
    `;
    expect(extension).toEqual({
      source_url: null,
      manifest: {
        integrations: [{ id: "unsafe", artifact: null, sha256: "a".repeat(64) }],
        services: [{ service: "unsafe", repo: null }],
      },
    });
    const [integrationRow] = await sql<{ repository: string }[]>`
      SELECT repository FROM installed_integration WHERE id = 'unsafe-integration'
    `;
    expect(integrationRow.repository).toBe("redacted-extension-locator:unsafe-integration");
    const [repositoryRow] = await sql<{ url: string }[]>`
      SELECT url FROM service_repository WHERE hash = 'unsafe-repository'
    `;
    expect(repositoryRow.url).toBe("redacted-extension-locator:unsafe-repository");
    const [unrelatedAfter] = await sql`
      SELECT row_to_json(j)::text AS job,
             (SELECT row_to_json(l)::text FROM admin_job_log l WHERE l.job_id = j.id) AS log
        FROM admin_job j WHERE id = 'other-job'
    `;
    expect(unrelatedAfter).toEqual(unrelatedBefore);

    await applyMigration();
    expect(await snapshot()).toBe(first);
  });
});
