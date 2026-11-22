import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
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
    values: ["registry", "artifact", "source", "uploaded-artifact", "legacy_unknown"],
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
        'adminJob_status_idx',
        'adminJob_type_idx'
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

  it("drops indexes no query uses", async () => {
    const unused = await fixture.sql<{ name: string }[]>`
      SELECT indexname AS name FROM pg_indexes
      WHERE schemaname = 'public' AND indexname IN (
        'installedExtension_sourceTrust_idx',
        'installedIntegration_sourceType_idx',
        'idx_capability_binding_service',
        'app_logs_level_source_idx',
        'installedExtensionComponent_componentId_idx'
      )`;
    expect(unused).toEqual([]);
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
    ).rejects.toMatchObject({ constraint_name: "mangrove_keypair_wrap_passphrase_key" });
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
    ).rejects.toMatchObject({ constraint_name: "share_link_route_target_check" });
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
