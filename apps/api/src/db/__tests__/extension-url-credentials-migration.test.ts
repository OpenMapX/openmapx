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
const ALTERNATE_HTTPS_URL = String.raw`https:\\user:${SECRET}@example.test\archive.tgz`;
const LEGACY_GIT_URL = `ssh://user:${SECRET}@example.test/repository.git?token=${SECRET}`;
const TAB_BEFORE_QUERY_URL = `https://example.test/archive.tgz\t?token=${SECRET}`;
const NEWLINE_BEFORE_FRAGMENT_URL = `https://example.test/archive.tgz\n#${SECRET}`;
const TAB_IN_SCHEME_URL = `ht\ttps://user:${SECRET}@example.test/archive.tgz`;
const SPACE_IN_PASSWORD_URL = `https://user:openmapx ${SECRET}@example.test/archive.tgz`;
const SAFE_BACKSLASH_AT_URL = String.raw`https:\\example.test\releases\@scope.tgz`;
const SAFE_EMPTY_QUERY_URL = "https://example.test/releases/empty-query.tgz?";
const SAFE_EMPTY_FRAGMENT_URL = "https://example.test/releases/empty-fragment.tgz#";
const SAFE_QUESTION_PROSE =
  "Download https://example.test/archive.tgz when ready? Ask an operator.";
const SPACE_QUERY_URL = `https://example.test/archive name.tgz?token=${SECRET}`;
const SPACE_FRAGMENT_URL = `https://example.test/archive name.tgz#${SECRET}`;
const SPACE_LEADING_QUERY_URL = `https://example.test/archive.tgz? ${SECRET}`;
const SPACE_LEADING_FRAGMENT_URL = `https://example.test/archive.tgz# ${SECRET}`;
const DOTTED_USER_PASSWORD_URL = `https://user.name:openmapx ${SECRET}@example.test/archive.tgz`;
const PERCENT_USER_PASSWORD_URL = `https://user%2Ename:openmapx ${SECRET}@example.test/archive.tgz`;
const PLUS_USER_PASSWORD_URL = `https://user+name:openmapx ${SECRET}@example.test/archive.tgz`;
const UNICODE_USER_PASSWORD_URL = `https://usér:openmapx ${SECRET}@example.test/archive.tgz`;
const SPACED_USER_PASSWORD_URL = `https://user name:openmapx ${SECRET}@example.test/archive.tgz`;
const SPACED_USER_URL = `https://user ${SECRET}@example.test/archive`;
const SPACED_USER_ROOT_URL = `https://user ${SECRET}@example.test`;
const SPACED_PASSWORD_ROOT_URL = `https://user: ${SECRET}@example.test`;
const PUNCTUATED_USER_PASSWORD_URL = `https://user!name:openmapx ${SECRET}@example.test/archive`;
const EXTENSIONLESS_SPACE_QUERY_URL = `https://example.test/archive name?token=${SECRET}`;
const EXTENSIONLESS_SPACE_FRAGMENT_URL = `https://example.test/archive name#${SECRET}`;
const EXTENSIONLESS_SPACE_LEADING_QUERY_URL = `https://example.test/archive name? ${SECRET}`;
const EXTENSIONLESS_SPACE_LEADING_FRAGMENT_URL = `https://example.test/archive name# ${SECRET}`;
const CONTROL_SPACE_QUERY_URL = `\u0001https://example.test/archive name.tgz?token=${SECRET}`;
const SAFE_HOST_EMAIL_PROSE = "Contact https://example.test:443 owner@example.org for access.";
const SAFE_URL_LEADING_PROSE = "https://example.test/archive.tgz is ready? Ask an operator.";
const SAFE_IPV6_EMAIL_PROSE = "Contact https://[2001:db8::1] owner@example.org for access.";
const SAFE_HOMEPAGE = "https://example.test/docs#installation";
const SAFE_ISSUE_PROSE = "Download https://example.test/archive.tgz and follow issue #123.";
const SAFE_REPOSITORY_ISSUE_PROSE =
  "Download https://example.test/archive.tgz and follow OpenMapX/openmapx#123.";
const SAFE_EMAIL_PATH_PROSE = "Contact https://example.test owner@example.org/support.";
const LEGACY_PROSE_URLS = [
  SPACE_QUERY_URL,
  SPACE_FRAGMENT_URL,
  SPACE_LEADING_QUERY_URL,
  SPACE_LEADING_FRAGMENT_URL,
  DOTTED_USER_PASSWORD_URL,
  PERCENT_USER_PASSWORD_URL,
  PLUS_USER_PASSWORD_URL,
  UNICODE_USER_PASSWORD_URL,
  SPACED_USER_PASSWORD_URL,
  SPACED_USER_URL,
  SPACED_USER_ROOT_URL,
  SPACED_PASSWORD_ROOT_URL,
  PUNCTUATED_USER_PASSWORD_URL,
  EXTENSIONLESS_SPACE_QUERY_URL,
  EXTENSIONLESS_SPACE_FRAGMENT_URL,
  EXTENSIONLESS_SPACE_LEADING_QUERY_URL,
  EXTENSIONLESS_SPACE_LEADING_FRAGMENT_URL,
] as const;
const JOB_LEGACY_URLS = [
  UNSAFE_URL,
  ALTERNATE_HTTPS_URL,
  LEGACY_GIT_URL,
  TAB_BEFORE_QUERY_URL,
  NEWLINE_BEFORE_FRAGMENT_URL,
  TAB_IN_SCHEME_URL,
  SPACE_IN_PASSWORD_URL,
  ...LEGACY_PROSE_URLS,
] as const;

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
        ('unsafe-extension', ${TAB_IN_SCHEME_URL}, ${sql.json({
          integrations: [
            { id: "unsafe", artifact: UNSAFE_URL, sha256: "a".repeat(64) },
            { id: "alternate", artifact: ALTERNATE_HTTPS_URL, sha256: "b".repeat(64) },
            { id: "tab-query", artifact: TAB_BEFORE_QUERY_URL, sha256: "c".repeat(64) },
            {
              id: "newline-fragment",
              artifact: NEWLINE_BEFORE_FRAGMENT_URL,
              sha256: "d".repeat(64),
            },
            { id: "tab-scheme", artifact: TAB_IN_SCHEME_URL, sha256: "e".repeat(64) },
            { id: "space-password", artifact: SPACE_IN_PASSWORD_URL, sha256: "f".repeat(64) },
          ],
          services: [{ service: "unsafe", repo: LEGACY_GIT_URL }],
          legacyLocators: LEGACY_PROSE_URLS.map((artifact) => ({ artifact })),
          notes: LEGACY_PROSE_URLS.map((url) => `Downloading ${url}`),
        })}),
        ('clean-extension', 'https://example.test/extension.json', ${sql.json({
          integrations: [{ id: "clean", artifact: "https://example.test/clean.tgz" }],
        })}),
        ('safe-provenance', ${SAFE_BACKSLASH_AT_URL}, ${sql.json({
          integrations: [
            { id: "safe", artifact: SAFE_BACKSLASH_AT_URL },
            { id: "empty-query", artifact: SAFE_EMPTY_QUERY_URL },
            { id: "empty-fragment", artifact: SAFE_EMPTY_FRAGMENT_URL },
          ],
          description: SAFE_QUESTION_PROSE,
          notes: [
            SAFE_HOST_EMAIL_PROSE,
            SAFE_URL_LEADING_PROSE,
            SAFE_IPV6_EMAIL_PROSE,
            SAFE_ISSUE_PROSE,
            SAFE_REPOSITORY_ISSUE_PROSE,
            SAFE_EMAIL_PATH_PROSE,
          ],
          homepage: SAFE_HOMEPAGE,
        })});
    `;
    await sql`
      INSERT INTO installed_integration (id, repository, managed_by_extension) VALUES
        ('unsafe-integration', ${CONTROL_SPACE_QUERY_URL}, 'unsafe-extension'),
        ('manual-integration', 'https://example.test/manual.tgz', NULL);
    `;
    await sql`
      INSERT INTO service_repository (hash, url, managed_by_extension) VALUES
        ('unsafe-repository', ${NEWLINE_BEFORE_FRAGMENT_URL}, 'unsafe-extension');
    `;
    await sql`
      INSERT INTO admin_job (id, type, payload, result, error) VALUES
        ('unsafe-job', 'extension.install', ${sql.json({
          sourceUrl: UNSAFE_URL,
          legacyLocators: JOB_LEGACY_URLS.map((artifact) => ({ artifact })),
        })},
          ${sql.json({
            nested: [
              UNSAFE_URL,
              ALTERNATE_HTTPS_URL,
              LEGACY_GIT_URL,
              TAB_BEFORE_QUERY_URL,
              NEWLINE_BEFORE_FRAGMENT_URL,
              TAB_IN_SCHEME_URL,
              SPACE_IN_PASSWORD_URL,
              SPACE_LEADING_QUERY_URL,
              SPACE_LEADING_FRAGMENT_URL,
              DOTTED_USER_PASSWORD_URL,
              PERCENT_USER_PASSWORD_URL,
              PLUS_USER_PASSWORD_URL,
              UNICODE_USER_PASSWORD_URL,
              SPACED_USER_PASSWORD_URL,
              SPACED_USER_URL,
              SPACED_USER_ROOT_URL,
              SPACED_PASSWORD_ROOT_URL,
              PUNCTUATED_USER_PASSWORD_URL,
              EXTENSIONLESS_SPACE_QUERY_URL,
              EXTENSIONLESS_SPACE_FRAGMENT_URL,
              EXTENSIONLESS_SPACE_LEADING_QUERY_URL,
              EXTENSIONLESS_SPACE_LEADING_FRAGMENT_URL,
            ],
          })},
          ${`Fetch failed for ${EXTENSIONLESS_SPACE_QUERY_URL}`}),
        ('safe-job', 'extension.install', ${sql.json({
          message: SAFE_HOST_EMAIL_PROSE,
          messages: [SAFE_REPOSITORY_ISSUE_PROSE, SAFE_EMAIL_PATH_PROSE],
          manifest: { homepage: SAFE_HOMEPAGE },
        })},
          ${sql.json({
            message: SAFE_URL_LEADING_PROSE,
            messages: [SAFE_REPOSITORY_ISSUE_PROSE, SAFE_EMAIL_PATH_PROSE],
          })}, ${SAFE_HOST_EMAIL_PROSE}),
        ('unsafe-removal-job', 'extension.remove', ${sql.json({ id: "unsafe-extension" })},
          NULL, NULL),
        ('safe-removal-job', 'extension.remove', ${sql.json({ id: "clean-extension" })},
          NULL, NULL),
        ('other-job', 'system.update', ${sql.json({ url: "https://example.test/keep", keep: "exact" })},
          ${sql.json({ url: "https://example.test/keep" })}, 'Keep exact');
    `;
    await sql`
      INSERT INTO admin_job_log (id, job_id, line) VALUES
        ('unsafe-log', 'unsafe-job', ${`Downloading ${SPACED_USER_URL}`}),
        ('safe-log', 'safe-job', ${SAFE_URL_LEADING_PROSE}),
        ('safe-email-log', 'safe-job', ${SAFE_EMAIL_PATH_PROSE}),
        ('safe-issue-log', 'safe-job', ${SAFE_REPOSITORY_ISSUE_PROSE}),
        ('unsafe-removal-log', 'unsafe-removal-job',
          ${`Removing service repository ${SPACE_IN_PASSWORD_URL}...`}),
        ('safe-removal-log', 'safe-removal-job',
          'Removing service repository https://example.test/repository.git...'),
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
    const [safeBefore] = await sql`
      SELECT row_to_json(e)::text AS extension
        FROM installed_extension e WHERE id = 'safe-provenance'
    `;
    const [safeJobBefore] = await sql`
      SELECT row_to_json(j)::text AS job,
             (SELECT json_agg(row_to_json(l) ORDER BY l.id)::text
                FROM admin_job_log l WHERE l.job_id = j.id) AS log
        FROM admin_job j WHERE id = 'safe-job'
    `;
    const [safeRemovalBefore] = await sql`
      SELECT row_to_json(j)::text AS job,
             (SELECT row_to_json(l)::text FROM admin_job_log l WHERE l.job_id = j.id) AS log
        FROM admin_job j WHERE id = 'safe-removal-job'
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
        integrations: [
          { id: "unsafe", artifact: null, sha256: "a".repeat(64) },
          { id: "alternate", artifact: null, sha256: "b".repeat(64) },
          { id: "tab-query", artifact: null, sha256: "c".repeat(64) },
          { id: "newline-fragment", artifact: null, sha256: "d".repeat(64) },
          { id: "tab-scheme", artifact: null, sha256: "e".repeat(64) },
          { id: "space-password", artifact: null, sha256: "f".repeat(64) },
        ],
        services: [{ service: "unsafe", repo: null }],
        legacyLocators: LEGACY_PROSE_URLS.map(() => ({ artifact: null })),
        notes: [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
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
    const [safeAfter] = await sql`
      SELECT row_to_json(e)::text AS extension
        FROM installed_extension e WHERE id = 'safe-provenance'
    `;
    expect(safeAfter).toEqual(safeBefore);
    const [safeJobAfter] = await sql`
      SELECT row_to_json(j)::text AS job,
             (SELECT json_agg(row_to_json(l) ORDER BY l.id)::text
                FROM admin_job_log l WHERE l.job_id = j.id) AS log
        FROM admin_job j WHERE id = 'safe-job'
    `;
    expect(safeJobAfter).toEqual(safeJobBefore);
    const [safeRemovalAfter] = await sql`
      SELECT row_to_json(j)::text AS job,
             (SELECT row_to_json(l)::text FROM admin_job_log l WHERE l.job_id = j.id) AS log
        FROM admin_job j WHERE id = 'safe-removal-job'
    `;
    expect(safeRemovalAfter).toEqual(safeRemovalBefore);

    await applyMigration();
    expect(await snapshot()).toBe(first);
  });
});
