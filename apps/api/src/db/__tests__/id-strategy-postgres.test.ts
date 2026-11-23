import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

/** App-owned tables whose primary key is a random id the database can assign. */
const RANDOM_PRIMARY_KEYS = [
  ["public", "account_mail_outbox"],
  ["public", "admin_action_reauthentication"],
  ["public", "admin_audit_log"],
  ["public", "admin_job"],
  ["public", "configuration_migration_preview"],
  ["public", "data_disclosure_event"],
  ["public", "data_subject_request"],
  ["public", "data_subject_request_event"],
  ["public", "data_subject_request_notification"],
  ["public", "data_subject_request_preservation"],
  ["public", "data_subject_request_task"],
  ["public", "labeled_place"],
  ["public", "mangrove_keypair_wrap"],
  ["public", "parked_location"],
  ["public", "personal_timeline_connection"],
  ["public", "personal_vehicle"],
  ["public", "platform_configuration_preview"],
  ["public", "saved_list"],
  ["public", "saved_place"],
  ["public", "share_link"],
  ["public", "transit_credential_preview"],
  ["data_manager", "job_stages"],
  ["data_manager", "jobs"],
] as const;

type Fixture = Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
let fixture: Fixture;

integration("one id strategy", () => {
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it("app-owned random primary keys are uuid with default uuidv7()", async () => {
    const rows = await fixture.sql<
      { schema: string; table: string; type: string; default: string | null }[]
    >`
      SELECT n.nspname AS schema, c.relname AS table,
             format_type(a.atttypid, a.atttypmod) AS type,
             pg_get_expr(d.adbin, d.adrelid) AS default
      FROM pg_constraint k
      JOIN pg_class c ON c.oid = k.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE k.contype = 'p' AND cardinality(k.conkey) = 1
        AND n.nspname IN ('public', 'data_manager')
      ORDER BY n.nspname, c.relname`;
    const byTable = new Map(rows.map((row) => [`${row.schema}.${row.table}`, row]));
    for (const [schema, table] of RANDOM_PRIMARY_KEYS) {
      expect(byTable.get(`${schema}.${table}`), `${schema}.${table}`).toMatchObject({
        type: "uuid",
        default: "uuidv7()",
      });
    }
    // A random primary key added later follows the same rule.
    expect(rows.filter((row) => row.default?.includes("gen_random_uuid"))).toEqual([]);
  });

  it("no serial sequence remains", async () => {
    const serials = await fixture.sql<{ table_schema: string; table_name: string }[]>`
      SELECT table_schema, table_name, column_name
      FROM information_schema.columns
      WHERE table_schema IN ('public', 'data_manager')
        AND column_default LIKE 'nextval(%'`;
    expect(serials).toEqual([]);
    const identities = await fixture.sql<{ table_name: string; identity_generation: string }[]>`
      SELECT table_name, identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id'
        AND table_name IN ('app_logs', 'health_history')
      ORDER BY table_name`;
    expect(identities).toEqual([
      { table_name: "app_logs", identity_generation: "ALWAYS" },
      { table_name: "health_history", identity_generation: "ALWAYS" },
    ]);
  });

  it("consumed_by_job_id has admin_job.id's type", async () => {
    const types = await fixture.sql<{ table_name: string; column_name: string; type: string }[]>`
      SELECT table_name, column_name, data_type AS type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND ((table_name = 'admin_job' AND column_name = 'id')
          OR (table_name = 'admin_job_log' AND column_name = 'job_id')
          OR column_name = 'consumed_by_job_id')
      ORDER BY table_name, column_name`;
    expect(types).toEqual([
      { table_name: "admin_job", column_name: "id", type: "uuid" },
      { table_name: "admin_job_log", column_name: "job_id", type: "uuid" },
      {
        table_name: "configuration_migration_preview",
        column_name: "consumed_by_job_id",
        type: "uuid",
      },
      {
        table_name: "platform_configuration_preview",
        column_name: "consumed_by_job_id",
        type: "uuid",
      },
    ]);
  });

  it("the database assigns the ids", async () => {
    const [first] = await fixture.sql<{ id: string }[]>`
      INSERT INTO health_history (service_id, status) VALUES ('a', 'healthy') RETURNING id`;
    const [second] = await fixture.sql<{ id: string }[]>`
      INSERT INTO health_history (service_id, status) VALUES ('a', 'healthy') RETURNING id`;
    expect(Number(second?.id)).toBeGreaterThan(Number(first?.id));
    await expect(
      fixture.sql`INSERT INTO health_history (id, service_id, status) VALUES (1000, 'a', 'healthy')`,
    ).rejects.toMatchObject({ code: "428C9" });
    const [job] = await fixture.sql<{ id: string; version: number }[]>`
      INSERT INTO admin_job (type) VALUES ('test')
      RETURNING id, uuid_extract_version(id) AS version`;
    expect(job?.version).toBe(7);
  });
});
