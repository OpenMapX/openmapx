import { and, asc, eq, getTableName, inArray, is, type SQL } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import { ACTIVE_ADMIN_JOB_STATUSES, adminJob, adminJobStatusIn } from "../admin-job-schema";
import * as authSchema from "../auth-schema";

const integration = describe.runIf(process.env.OPENMAPX_RUN_DATABASE_TESTS === "1");

/** Better Auth's tables keep the indexes its CLI and plugins generate. */
const betterAuthTables = Object.values(authSchema)
  .filter((value) => is(value, PgTable))
  .map((table) => getTableName(table));

/** Every closed value set an app-owned text column holds, by constraint. */
const CLOSED_VALUE_SETS: Record<string, { table: string; column: string; values: string[] }> = {
  account_action_receipt_action_check: {
    table: "account_action_receipt",
    column: "action",
    values: [
      "create",
      "invitation",
      "verification-email",
      "reset-password",
      "verify",
      "password",
      "role",
    ],
  },
  admin_action_reauthentication_completed_method_check: {
    table: "admin_action_reauthentication",
    column: "completed_method",
    values: ["password", "password_totp", "password_recovery", "passkey", "federated"],
  },
  admin_job_status_check: {
    table: "admin_job",
    column: "status",
    values: ["queued", "running", "cancel_pending", "success", "failed", "canceled"],
  },
  admin_job_log_stream_check: {
    table: "admin_job_log",
    column: "stream",
    values: ["stdout", "stderr"],
  },
  data_subject_request_locator_type_check: {
    table: "data_subject_request",
    column: "locator_type",
    values: ["user_id", "email", "erasure_reference", "other_reference"],
  },
  data_subject_request_preservation_status_check: {
    table: "data_subject_request_preservation",
    column: "status",
    values: ["held", "source_capture_pending", "action_required", "captured", "released"],
  },
  health_history_status_check: {
    table: "health_history",
    column: "status",
    values: ["healthy", "degraded", "unhealthy", "error"],
  },
  installed_extension_source_trust_check: {
    table: "installed_extension",
    column: "source_trust",
    values: ["built-in", "verified", "community"],
  },
  installed_extension_component_kind_check: {
    table: "installed_extension_component",
    column: "kind",
    values: ["integration", "service"],
  },
  installed_integration_source_type_check: {
    table: "installed_integration",
    column: "source_type",
    values: ["registry", "artifact", "source", "uploaded-artifact"],
  },
  mangrove_keypair_wrap_wrap_type_check: {
    table: "mangrove_keypair_wrap",
    column: "wrap_type",
    values: ["passphrase", "webauthn"],
  },
  mobile_auth_handoff_purpose_check: {
    table: "mobile_auth_handoff",
    column: "purpose",
    values: ["sign-in", "link-provider", "add-passkey"],
  },
  parked_location_source_check: {
    table: "parked_location",
    column: "source",
    values: ["device", "manual", "arrival"],
  },
  personal_timeline_connection_mode_check: {
    table: "personal_timeline_connection",
    column: "mode",
    values: ["external", "managed"],
  },
  personal_timeline_connection_status_check: {
    table: "personal_timeline_connection",
    column: "status",
    values: ["connected", "degraded", "invalid"],
  },
  personal_vehicle_kind_check: {
    table: "personal_vehicle",
    column: "kind",
    values: ["car", "motorcycle", "bicycle"],
  },
  personal_vehicle_powertrain_check: {
    table: "personal_vehicle",
    column: "powertrain",
    values: ["electric", "plugin_hybrid", "hybrid", "petrol", "diesel", "other"],
  },
  share_link_mode_check: { table: "share_link", column: "mode", values: ["live", "snapshot"] },
  share_link_target_type_check: {
    table: "share_link",
    column: "target_type",
    values: ["list", "route"],
  },
};

/**
 * App-owned objects not named for their table and columns alone, by table. A
 * partial unique index whose predicate selects a subset of rows names that
 * subset, since its columns alone would read as a key over the whole table; an
 * index on an expression has no columns to name; and a column list that would
 * pass PostgreSQL's 63-byte identifier limit is shortened.
 */
const NAMED_BY_PURPOSE: Record<string, string> = {
  admin_job_active_system_maintenance_key: "admin_job",
  configuration_fence_state_prepared_key: "configuration_fence",
  data_subject_request_notification_delivery_key: "data_subject_request_notification",
  data_subject_request_notification_recipient_created_at_idx: "data_subject_request_notification",
  data_subject_request_preservation_request_registration_key: "data_subject_request_preservation",
  data_subject_request_user_id_kind_active_key: "data_subject_request",
  mangrove_keypair_wrap_user_id_passphrase_key: "mangrove_keypair_wrap",
  offline_package_jobs_request_key_live_key: "offline_package_jobs",
};

const NAME_SUFFIX: Record<string, string> = { p: "pkey", u: "key", f: "fkey", U: "key", i: "idx" };

type Fixture = Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
let fixture: Fixture;

async function seedUser(id: string, role = "user"): Promise<void> {
  await fixture.sql`INSERT INTO "user" (id, name, email, role, created_at, updated_at)
    VALUES (${id}, ${id}, ${`${id}@example.test`}, ${role}, now(), now())`;
}

integration("schema hygiene", () => {
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
  }, 180_000);

  afterAll(async () => {
    await fixture?.stop();
  });

  it("no index is a prefix duplicate of a unique constraint", async () => {
    expect(betterAuthTables).toEqual(expect.arrayContaining(["user", "session", "passkey"]));
    const duplicates = await fixture.sql<{ table: string; index: string; unique: string }[]>`
      SELECT t.relname AS table, ix.relname AS index, ux.relname AS unique
      FROM pg_index i
      JOIN pg_class ix ON ix.oid = i.indexrelid
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_index u ON u.indrelid = i.indrelid AND u.indisunique
        AND u.indexrelid <> i.indexrelid AND u.indpred IS NULL AND u.indexprs IS NULL
      JOIN pg_class ux ON ux.oid = u.indexrelid
      WHERE n.nspname IN ('public', 'data_manager')
        AND NOT (n.nspname = 'public' AND t.relname IN ${fixture.sql(betterAuthTables)})
        AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
        AND i.indnatts <= u.indnatts
        AND (u.indkey::int2[])[0:i.indnatts - 1] = (i.indkey::int2[])[0:i.indnatts - 1]
      ORDER BY 1, 2`;
    expect(duplicates).toEqual([]);
  });

  it("app-owned object names follow the convention", async () => {
    // Constraints, then the indexes that back no constraint. Extension-owned
    // tables (PostGIS in the test image) and Better Auth's are not the app's.
    const objects = await fixture.sql<
      { table: string; name: string; kind: string; columns: string[]; subset: boolean }[]
    >`
      WITH owned AS (
        SELECT r.oid, r.relname FROM pg_class r
        JOIN pg_namespace n ON n.oid = r.relnamespace
        WHERE r.relkind IN ('r', 'p') AND n.nspname IN ('public', 'data_manager')
          AND NOT (n.nspname = 'public' AND r.relname IN ${fixture.sql(betterAuthTables)})
          AND NOT EXISTS (SELECT FROM pg_depend d
            WHERE d.classid = 'pg_class'::regclass AND d.objid = r.oid AND d.deptype = 'e'))
      SELECT o.relname AS table, c.conname AS name, c.contype::text AS kind,
        array(
          SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.position
        ) AS columns,
        false AS subset
      FROM pg_constraint c JOIN owned o ON o.oid = c.conrelid
      WHERE c.contype IN ('p', 'u', 'f', 'c', 'x')
      UNION ALL
      SELECT o.relname, ix.relname, CASE WHEN i.indisunique THEN 'U' ELSE 'i' END,
        array(
          SELECT coalesce(a.attname::text, '')
          FROM unnest((i.indkey::int2[])[0:i.indnkeyatts - 1]) WITH ORDINALITY AS k(attnum, position)
          LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
          ORDER BY k.position
        ),
        i.indisunique AND i.indpred IS NOT NULL
          AND pg_get_expr(i.indpred, i.indrelid) !~ '^\\(?[a-z_]+ IS NOT NULL\\)?$'
      FROM pg_index i JOIN owned o ON o.oid = i.indrelid
      JOIN pg_class ix ON ix.oid = i.indexrelid
      WHERE NOT EXISTS (SELECT FROM pg_constraint c WHERE c.conindid = i.indexrelid
        AND c.contype IN ('p', 'u', 'x'))
      ORDER BY 1, 2`;
    expect(objects.map((row) => row.table)).toEqual(
      expect.arrayContaining(["admin_job", "jobs", "saved_list"]),
    );
    const misnamed: string[] = [];
    const byPurpose: string[] = [];
    for (const { table, name, kind, columns, subset } of objects) {
      if (kind === "c") {
        if (!new RegExp(`^${table}_[a-z0-9_]+_check$`).test(name)) misnamed.push(name);
        continue;
      }
      const suffix = NAME_SUFFIX[kind];
      const conventional =
        kind === "p" ? `${table}_pkey` : `${table}_${columns.join("_")}_${suffix}`;
      if (subset || columns.includes("") || conventional.length > 63) {
        byPurpose.push(name);
        const ok =
          NAMED_BY_PURPOSE[name] === table &&
          name.startsWith(`${table}_`) &&
          name.endsWith(`_${suffix}`) &&
          name.length <= 63;
        if (!ok) misnamed.push(`${name} (named by purpose)`);
      } else if (name !== conventional) misnamed.push(`${name} -> ${conventional}`);
    }
    expect(misnamed).toEqual([]);
    expect(byPurpose.sort()).toEqual(Object.keys(NAMED_BY_PURPOSE).sort());
  });

  it("every foreign key column is indexed", async () => {
    const unindexed = await fixture.sql<{ table: string; constraint: string }[]>`
      SELECT c.conrelid::regclass::text AS table, c.conname AS constraint
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'f' AND n.nspname IN ('public', 'data_manager')
        AND NOT (n.nspname = 'public' AND r.relname IN ${fixture.sql(betterAuthTables)})
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.conrelid AND i.indpred IS NULL
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey
            AND (i.indkey::int2[])[0:cardinality(c.conkey) - 1] <@ c.conkey)
      ORDER BY 1, 2`;
    expect(unindexed).toEqual([]);
  });

  it("the named CHECKs hold exactly each closed value set", async () => {
    const checks = await fixture.sql<{ name: string; table: string; definition: string }[]>`
      SELECT c.conname AS name, r.relname AS table, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'c' AND n.nspname = 'public' AND c.conname IN ${fixture.sql(
        Object.keys(CLOSED_VALUE_SETS),
      )}`;
    const byName = new Map(checks.map((row) => [row.name, row]));
    for (const [name, expected] of Object.entries(CLOSED_VALUE_SETS)) {
      const check = byName.get(name);
      expect(check?.table, name).toBe(expected.table);
      const listed = [...(check?.definition.matchAll(/'([^']*)'::text/g) ?? [])].map(
        (match) => match[1],
      );
      expect(listed.sort(), name).toEqual([...expected.values].sort());
      expect(check?.definition, name).toContain(expected.column);
    }
  });

  it("records extension ownership only as component links and keeps no constant columns", async () => {
    const columns = await fixture.sql<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('managed_by_extension', 'activation_version')`;
    expect(columns).toEqual([]);
  });

  it("indexes the prune paths and active admin jobs", async () => {
    const indexes = await fixture.sql<{ name: string; definition: string }[]>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'admin_action_reauthentication_expires_at_idx',
        'data_disclosure_event_occurred_at_idx',
        'health_history_checked_at_idx',
        'mangrove_keypair_wrap_user_id_idx',
        'admin_audit_log_target_type_target_id_idx',
        'admin_job_type_idx',
        'admin_job_status_idx'
      ) ORDER BY 1`;
    expect(Object.fromEntries(indexes.map((row) => [row.name, row.definition]))).toEqual({
      admin_action_reauthentication_expires_at_idx: expect.stringContaining("(expires_at)"),
      admin_audit_log_target_type_target_id_idx: expect.stringContaining(
        "(target_type, target_id)",
      ),
      admin_job_type_idx: expect.stringMatching(
        /\(type\) WHERE \(status = ANY \(ARRAY\['queued'::text, 'running'::text, 'cancel_pending'::text\]\)\)$/,
      ),
      data_disclosure_event_occurred_at_idx: expect.stringContaining("(occurred_at)"),
      health_history_checked_at_idx: expect.stringContaining("(checked_at)"),
      mangrove_keypair_wrap_user_id_idx: expect.stringContaining("(user_id)"),
    });
  });

  it("keys configuration rows and job log lines by their natural keys", async () => {
    const tables = [
      "admin_job_log",
      "integration_config",
      "integration_secret",
      "service_config",
      "service_secret",
    ];
    const keys = await fixture.sql<{ table: string; constraint: string; columns: string[] }[]>`
      SELECT r.relname AS table, c.conname AS constraint,
        array(
          SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, position)
          JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
          ORDER BY k.position
        ) AS columns
      FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE c.contype = 'p' AND n.nspname = 'public' AND r.relname IN ${fixture.sql(tables)}
      ORDER BY 1`;
    expect(keys).toEqual([
      { table: "admin_job_log", constraint: "admin_job_log_pkey", columns: ["job_id", "seq"] },
      {
        table: "integration_config",
        constraint: "integration_config_pkey",
        columns: ["integration_id"],
      },
      {
        table: "integration_secret",
        constraint: "integration_secret_pkey",
        columns: ["integration_id", "key"],
      },
      { table: "service_config", constraint: "service_config_pkey", columns: ["service_id"] },
      {
        table: "service_secret",
        constraint: "service_secret_pkey",
        columns: ["service_id", "key"],
      },
    ]);
    const surrogates = await fixture.sql<{ table: string }[]>`
      SELECT table_name AS table FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name IN ${fixture.sql(tables)}`;
    expect(surrogates).toEqual([]);
    const indexes = await fixture.sql<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ${fixture.sql(tables)} ORDER BY 1`;
    expect(indexes.map((row) => row.name)).toEqual([
      "admin_job_log_job_id_source_event_id_key",
      "admin_job_log_pkey",
      "integration_config_pkey",
      "integration_secret_pkey",
      "integration_secret_updated_by_idx",
      "service_config_pkey",
      "service_secret_pkey",
      "service_secret_updated_by_idx",
    ]);
  });

  it("refuses a second configuration row or job log line under the same key", async () => {
    await fixture.sql`INSERT INTO integration_config (integration_id, config)
      VALUES ('natural-key', '{}'::jsonb)`;
    await expect(
      fixture.sql`INSERT INTO integration_config (integration_id, config)
        VALUES ('natural-key', '{}'::jsonb)`,
    ).rejects.toMatchObject({ constraint_name: "integration_config_pkey" });
    await fixture.sql`INSERT INTO service_config (service_id, config)
      VALUES ('natural-key', '{}'::jsonb)`;
    await expect(
      fixture.sql`INSERT INTO service_config (service_id, config)
        VALUES ('natural-key', '{}'::jsonb)`,
    ).rejects.toMatchObject({ constraint_name: "service_config_pkey" });
    for (const [table, owner] of [
      ["integration_secret", "integration_id"],
      ["service_secret", "service_id"],
    ] as const) {
      const insert = (key: string) =>
        fixture.sql`INSERT INTO ${fixture.sql(table)} (${fixture.sql(owner)}, key, ciphertext, iv, tag)
          VALUES ('natural-key', ${key}, 'c', 'i', 't')`;
      await insert("TOKEN");
      await insert("OTHER");
      await expect(insert("TOKEN")).rejects.toMatchObject({ constraint_name: `${table}_pkey` });
    }
    const [job] = await fixture.sql<{ id: string }[]>`
      INSERT INTO admin_job (type) VALUES ('test.natural-key') RETURNING id`;
    const line = (seq: number, sourceEventId: string | null = null) =>
      fixture.sql`INSERT INTO admin_job_log (job_id, seq, line, source_event_id)
        VALUES (${job?.id ?? null}, ${seq}, 'line', ${sourceEventId})`;
    await line(0);
    await line(1, "ops:a:1");
    await line(2);
    await expect(line(1)).rejects.toMatchObject({ constraint_name: "admin_job_log_pkey" });
    await expect(line(3, "ops:a:1")).rejects.toMatchObject({
      constraint_name: "admin_job_log_job_id_source_event_id_key",
    });
  });

  it("serves active-job lookups from the partial index under a generic plan", async () => {
    await fixture.sql`INSERT INTO admin_job (type, status)
      SELECT 'test.generic-plan', 'success' FROM generate_series(1, 2000)`;
    await fixture.sql`ANALYZE admin_job`;
    const lookup = (status: SQL) =>
      fixture.db
        .select({ id: adminJob.id })
        .from(adminJob)
        .where(and(eq(adminJob.type, "test.generic-plan"), status))
        .orderBy(asc(adminJob.createdAt))
        .limit(1)
        .toSQL();
    const genericPlan = (query: { sql: string; params: unknown[] }) =>
      fixture.sql.begin(async (tx) => {
        await tx`SET LOCAL plan_cache_mode = force_generic_plan`;
        await tx.unsafe(`PREPARE active_lookup AS ${query.sql}`);
        const literals = query.params.map((value) =>
          typeof value === "number" ? String(value) : `'${String(value)}'`,
        );
        const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(
          `EXPLAIN EXECUTE active_lookup(${literals.join(", ")})`,
        );
        await tx`DEALLOCATE active_lookup`;
        return rows.map((row) => row["QUERY PLAN"]).join("\n");
      });
    expect(
      await genericPlan(lookup(adminJobStatusIn(adminJob.status, ACTIVE_ADMIN_JOB_STATUSES))),
    ).toContain("admin_job_type_idx");
    expect(
      await genericPlan(lookup(adminJobStatusIn(adminJob.status, ["running", "cancel_pending"]))),
    ).toContain("admin_job_type_idx");
    // Bound statuses cannot prove the index predicate once the plan is generic.
    expect(
      await genericPlan(lookup(inArray(adminJob.status, [...ACTIVE_ADMIN_JOB_STATUSES]))),
    ).not.toContain("admin_job_type_idx");
  });

  it("drops indexes no query uses", async () => {
    const leading = await fixture.sql<{ table: string; column: string }[]>`
      SELECT t.relname AS table, a.attname AS column FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
      WHERE n.nspname = 'public'`;
    const unused = new Set([
      "installed_extension.source_trust",
      "installed_integration.source_type",
      "capability_binding.service_id",
      "app_logs.level",
      "installed_extension_component.component_id",
    ]);
    expect(leading.filter((row) => unused.has(`${row.table}.${row.column}`))).toEqual([]);
  });

  it("refuses a second passphrase wrap but admits several passkey wraps", async () => {
    await seedUser("wrap-owner");
    await fixture.sql`INSERT INTO mangrove_keypair (user_id, revision, public_jwk)
      VALUES ('wrap-owner', 'r1', '{}'::jsonb)`;
    await fixture.sql`INSERT INTO mangrove_keypair_wrap (user_id, wrap_type, label) VALUES
      ('wrap-owner', 'passphrase', 'Main'),
      ('wrap-owner', 'webauthn', 'Phone'),
      ('wrap-owner', 'webauthn', 'Key')`;
    await expect(
      fixture.sql`INSERT INTO mangrove_keypair_wrap (user_id, wrap_type, label)
        VALUES ('wrap-owner', 'passphrase', 'Second')`,
    ).rejects.toMatchObject({ constraint_name: "mangrove_keypair_wrap_user_id_passphrase_key" });
    await expect(
      fixture.sql`INSERT INTO mangrove_keypair_wrap (user_id, wrap_type, label)
        VALUES ('wrap-owner', 'password', 'Typo')`,
    ).rejects.toMatchObject({ constraint_name: "mangrove_keypair_wrap_wrap_type_check" });
  });

  it("refuses share links whose shape contradicts their target and mode", async () => {
    await seedUser("share-owner");
    const insert = (values: {
      token: string;
      targetType: string;
      targetId: string | null;
      mode: string;
      snapshot: string | null;
    }) => fixture.sql`INSERT INTO share_link
        (user_id, token_hash, target_type, target_id, mode, label, snapshot)
      VALUES ('share-owner', ${values.token}, ${values.targetType}, ${values.targetId},
        ${values.mode}, 'Label', ${values.snapshot}::jsonb)`;
    const listId = "0193e4a0-0000-7000-8000-00000000aa01";
    await insert({
      token: "ok-live",
      targetType: "list",
      targetId: listId,
      mode: "live",
      snapshot: null,
    });
    await insert({
      token: "ok-snapshot",
      targetType: "list",
      targetId: listId,
      mode: "snapshot",
      snapshot: "{}",
    });
    await insert({
      token: "ok-route",
      targetType: "route",
      targetId: null,
      mode: "snapshot",
      snapshot: "{}",
    });
    await expect(
      insert({
        token: "route-target",
        targetType: "route",
        targetId: listId,
        mode: "snapshot",
        snapshot: "{}",
      }),
    ).rejects.toMatchObject({ constraint_name: "share_link_route_shape_check" });
    await expect(
      insert({
        token: "live-route",
        targetType: "route",
        targetId: null,
        mode: "live",
        snapshot: null,
      }),
    ).rejects.toMatchObject({ constraint_name: "share_link_route_shape_check" });
    await expect(
      insert({
        token: "list-without-target",
        targetType: "list",
        targetId: null,
        mode: "live",
        snapshot: null,
      }),
    ).rejects.toMatchObject({ constraint_name: "share_link_list_target_check" });
    await expect(
      insert({
        token: "empty-snapshot",
        targetType: "route",
        targetId: null,
        mode: "snapshot",
        snapshot: null,
      }),
    ).rejects.toMatchObject({ constraint_name: "share_link_snapshot_check" });
    await expect(
      insert({
        token: "live-with-snapshot",
        targetType: "list",
        targetId: listId,
        mode: "live",
        snapshot: "{}",
      }),
    ).rejects.toMatchObject({ constraint_name: "share_link_snapshot_check" });
    await expect(
      insert({
        token: "bad-mode",
        targetType: "list",
        targetId: listId,
        mode: "frozen",
        snapshot: null,
      }),
    ).rejects.toMatchObject({ constraint_name: "share_link_mode_check" });
  });

  it("admits a cancel_pending admin job and refuses an unknown status", async () => {
    await fixture.sql`INSERT INTO admin_job (type, status) VALUES ('test.job', 'cancel_pending')`;
    await expect(
      fixture.sql`INSERT INTO admin_job (type, status) VALUES ('test.job', 'cancelling')`,
    ).rejects.toMatchObject({ constraint_name: "admin_job_status_check" });
  });

  it("deleting every administrator alerted about a case keeps each alert", async () => {
    for (const id of ["alerted-admin-a", "alerted-admin-b", "remaining-admin"])
      await seedUser(id, "admin");
    const [request] = await fixture.sql<{ id: string }[]>`
      INSERT INTO data_subject_request (kind, channel, received_at, due_at)
      VALUES ('access', 'email', now(), now() + interval '30 days') RETURNING id`;
    await fixture.sql`INSERT INTO data_subject_request_notification
        (request_id, recipient_user_id, template)
      VALUES (${request?.id ?? null}, 'alerted-admin-a', 'admin_new_request'),
             (${request?.id ?? null}, 'alerted-admin-b', 'admin_new_request')`;
    await fixture.sql`DELETE FROM "user" WHERE id IN ('alerted-admin-a', 'alerted-admin-b')`;
    const alerts = await fixture.sql<{ recipient: string | null }[]>`
      SELECT recipient_user_id AS recipient FROM data_subject_request_notification
      WHERE request_id = ${request?.id ?? null}`;
    expect(alerts).toEqual([{ recipient: null }, { recipient: null }]);
  });
});
