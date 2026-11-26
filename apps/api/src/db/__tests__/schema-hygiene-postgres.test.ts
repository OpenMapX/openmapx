import {
  ADMIN_REAUTH_PURPOSES,
  AUDIT_ACTION_NAMES,
  AUDIT_TARGET_TYPES,
  approvedGrantsSchema,
  type GrantId,
  normalizeGrants,
} from "@openmapx/core/api-contracts";
import { ACTIVE_JOB_STATUSES, ADMIN_JOB_TYPES } from "@openmapx/core/jobs";
import { and, asc, eq, getTableName, inArray, is, type SQL } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMigratedPostgresFixture } from "../../test/postgres-fixture";
import { adminJob, adminJobStatusIn } from "../admin-job-schema";
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
      "email_verification",
      "password_reset",
      "verify",
      "password",
      "role",
    ],
  },
  admin_audit_log_action_check: {
    table: "admin_audit_log",
    column: "action",
    values: [...AUDIT_ACTION_NAMES],
  },
  admin_audit_log_target_type_check: {
    table: "admin_audit_log",
    column: "target_type",
    values: [...AUDIT_TARGET_TYPES],
  },
  admin_action_reauthentication_purpose_check: {
    table: "admin_action_reauthentication",
    column: "purpose",
    values: [...ADMIN_REAUTH_PURPOSES],
  },
  admin_action_reauthentication_completed_method_check: {
    table: "admin_action_reauthentication",
    column: "completed_method",
    values: ["password", "password_totp", "password_recovery", "passkey", "federated"],
  },
  admin_job_status_check: {
    table: "admin_job",
    column: "status",
    values: ["queued", "running", "cancel_pending", "succeeded", "failed", "cancelled"],
  },
  admin_job_type_check: {
    table: "admin_job",
    column: "type",
    values: [...ADMIN_JOB_TYPES],
  },
  admin_job_log_stream_check: {
    table: "admin_job_log",
    column: "stream",
    values: ["stdout", "stderr"],
  },
  attention_item_severity_check: {
    table: "attention_item",
    column: "severity",
    values: ["info", "warning", "critical"],
  },
  attention_item_clearance_check: {
    table: "attention_item",
    column: "clearance",
    values: ["condition", "acknowledge"],
  },
  attention_notification_channel_check: {
    table: "attention_notification",
    column: "channel",
    values: ["email", "webhook"],
  },
  attention_notification_severity_check: {
    table: "attention_notification",
    column: "severity",
    values: ["warning", "critical"],
  },
  attention_notification_status_check: {
    table: "attention_notification",
    column: "status",
    values: ["pending", "sending", "sent", "retryable", "failed", "canceled"],
  },
  data_subject_request_event_event_type_check: {
    table: "data_subject_request_event",
    column: "event_type",
    values: [
      "received",
      "status_changed",
      "identity_verified",
      "task_resolved",
      "extended",
      "export_started",
      "export_delivered",
      "export_failed",
    ],
  },
  data_subject_request_event_actor_kind_check: {
    table: "data_subject_request_event",
    column: "actor_kind",
    values: ["subject", "admin", "system"],
  },
  data_subject_request_task_source_check: {
    table: "data_subject_request_task",
    column: "source",
    values: ["openmapx-db", "redis", "managed-service", "operator", "extension"],
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
  feed_state_status_check: {
    table: "feed_state",
    column: "status",
    values: ["active", "stale", "failed", "unknown"],
  },
  feed_state_validation_status_check: {
    table: "feed_state",
    column: "validation_status",
    values: ["ok", "warning", "error"],
  },
  extension_name_claim_kind_check: {
    table: "extension_name_claim",
    column: "kind",
    values: ["service", "integration", "database-role", "database-schema"],
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
  integration_task_run_status_check: {
    table: "integration_task_run",
    column: "status",
    values: ["running", "succeeded", "failed"],
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
  job_status_check: {
    table: "job",
    column: "status",
    values: [
      "queued",
      "running",
      "cancel_pending",
      "succeeded",
      "partially_succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ],
  },
  job_stage_stage_check: {
    table: "job_stage",
    column: "stage",
    values: [
      "prepare",
      "filter",
      "preflight",
      "compile-gbfs",
      "fetch",
      "fetch-operator",
      "validate",
      "gen-motis-config",
      "assemble-staging",
      "stage-proxy",
      "motis-import",
      "motis-health",
      "gen-full-config",
      "gen-attribution",
      "promote",
      "gc",
      "mirror",
    ],
  },
  job_stage_status_check: {
    table: "job_stage",
    column: "status",
    values: ["succeeded", "partially_succeeded", "failed", "skipped"],
  },
  offline_package_job_status_check: {
    table: "offline_package_job",
    column: "status",
    values: ["preparing", "ready-to-download", "failed", "expired"],
  },
  overture_release_status_check: {
    table: "overture_release",
    column: "status",
    values: ["imported", "links_pending"],
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
  configuration_fence_status_prepared_key: "configuration_fence",
  data_subject_request_notification_delivery_key: "data_subject_request_notification",
  data_subject_request_notification_recipient_created_at_idx: "data_subject_request_notification",
  data_subject_request_preservation_request_registration_key: "data_subject_request_preservation",
  data_subject_request_user_id_kind_active_key: "data_subject_request",
  integration_task_run_running_key: "integration_task_run",
  mangrove_keypair_wrap_user_id_passphrase_key: "mangrove_keypair_wrap",
  offline_package_job_request_key_live_key: "offline_package_job",
  personal_vehicle_user_id_default_key: "personal_vehicle",
};

const NAME_SUFFIX: Record<string, string> = { p: "pkey", u: "key", f: "fkey", U: "key", i: "idx" };

/**
 * App-owned table names that end in "s" although they name one row, with the
 * reason. Every other table name is singular.
 */
const SINGULAR_TABLE_NAMES_ENDING_IN_S: Record<string, string> = {};

/** Column name segments that abbreviate a word; columns spell it out. */
const ABBREVIATED_SEGMENTS = new Set(["msg", "addr", "cnt", "cfg", "desc", "pwd", "qty", "ts"]);

/** The parts of one encrypted value: `<prefix>_ciphertext` and its siblings. */
const ENCRYPTED_VALUE_PARTS = ["ciphertext", "iv", "tag", "key_version"] as const;
const ENCRYPTED_VALUE_PART = /^(?:(.+)_)?(ciphertext|iv|tag|key_version)$/;

/** Ciphertext columns that hold a self-describing envelope rather than the
 * server's AES-GCM parts, with the reason. */
const SELF_DESCRIBING_CIPHERTEXTS: Record<string, string> = {
  "mangrove_keypair.passphrase_ciphertext":
    "an age envelope the browser writes; it carries its own header, nonce and recipient",
  "mangrove_keypair.recipients_ciphertext":
    "an age envelope the browser writes; it carries its own header, nonce and recipients",
};

/** Columns named `state` or `*_state` that hold no lifecycle of their row,
 * each with the reason. */
const NON_LIFECYCLE_STATE_COLUMNS: Record<string, string> = {
  "mobile_auth_handoff.state":
    "the OAuth `state` parameter of the sign-in attempt, named as the protocol names it",
  "data_subject_request.account_state":
    "what the case registration recorded about the subject's account (current, inaccessible, deleted, unknown), not the case's own progress",
  "job.execution_state":
    "the durable execution's opaque JSON state document, not a closed list of statuses",
};

interface OwnedColumn {
  schema: string;
  table: string;
  column: string;
  referencesUser: boolean;
}

/** Every rule a table or column name breaks, as `<table>[.<column>]: <rule>`. */
function namingViolations(columns: readonly OwnedColumn[]): string[] {
  const violations: string[] = [];
  const tables = [...new Set(columns.map((row) => row.table))];
  for (const table of tables)
    if (table.endsWith("s") && !(table in SINGULAR_TABLE_NAMES_ENDING_IN_S))
      violations.push(`${table}: table names are singular`);
  const byTable = new Map<string, Set<string>>();
  for (const row of columns)
    byTable.set(row.table, (byTable.get(row.table) ?? new Set()).add(row.column));
  for (const { table, column, referencesUser } of columns) {
    const name = `${table}.${column}`;
    if (column === "actor_id") violations.push(`${name}: the acting account is actor_user_id`);
    if (referencesUser && column !== "user_id" && !column.endsWith("_user_id"))
      violations.push(`${name}: a column referencing "user" is <role>_user_id`);
    if ((column === "state" || column.endsWith("_state")) && !(name in NON_LIFECYCLE_STATE_COLUMNS))
      violations.push(`${name}: a lifecycle column is status`);
    if (/encrypt/.test(column))
      violations.push(
        `${name}: an encrypted value is <prefix>_ciphertext, _iv, _tag, _key_version`,
      );
    if (column.split("_").some((segment) => ABBREVIATED_SEGMENTS.has(segment)))
      violations.push(`${name}: names are spelled out`);
    const part = ENCRYPTED_VALUE_PART.exec(column);
    if (part && !(name in SELF_DESCRIBING_CIPHERTEXTS)) {
      const prefix = part[1] ? `${part[1]}_` : "";
      const siblings = byTable.get(table) ?? new Set();
      const missing = ENCRYPTED_VALUE_PARTS.filter((sibling) => !siblings.has(prefix + sibling));
      if (missing.length)
        violations.push(`${name}: encrypted value lacks ${missing.map((m) => prefix + m)}`);
    }
  }
  return [...new Set(violations)].sort();
}

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

  it("app-owned table and column names follow the naming rules", async () => {
    // Better Auth's tables keep their generated names; extension-owned tables
    // are not the app's.
    const columns = await fixture.sql<OwnedColumn[]>`
      SELECT n.nspname AS schema, r.relname AS table, a.attname AS column,
        EXISTS (SELECT FROM pg_constraint fk
          WHERE fk.contype = 'f' AND fk.conrelid = r.oid AND fk.confrelid = '"user"'::regclass
            AND a.attnum = ANY (fk.conkey)) AS "referencesUser"
      FROM pg_class r
      JOIN pg_namespace n ON n.oid = r.relnamespace
      JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum > 0 AND NOT a.attisdropped
      WHERE r.relkind IN ('r', 'p') AND n.nspname IN ('public', 'data_manager')
        AND NOT (n.nspname = 'public' AND r.relname IN ${fixture.sql(betterAuthTables)})
        AND NOT EXISTS (SELECT FROM pg_depend d
          WHERE d.classid = 'pg_class'::regclass AND d.objid = r.oid AND d.deptype = 'e')
      ORDER BY 1, 2, 3`;
    expect(columns.map((row) => row.table)).toEqual(expect.arrayContaining(["admin_audit_log"]));
    expect(namingViolations(columns)).toEqual([]);
  });

  it("app-owned object names follow the convention", async () => {
    // Constraints, then the indexes that back no constraint. Extension-owned
    // tables (PostGIS in the test image) and Better Auth's are not the app's.
    // NOT NULL constraints (contype 'n') are left out: PostgreSQL names them itself.
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
      expect.arrayContaining(["admin_job", "job", "saved_list"]),
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
      WHERE c.contype = 'c' AND n.nspname IN ('public', 'data_manager') AND c.conname IN ${fixture.sql(
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

  it("records the owning extension on configuration rows and keeps no constant columns", async () => {
    const constants = await fixture.sql<{ table: string; column: string }[]>`
      SELECT table_name AS table, column_name AS column FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('managed_by_extension', 'activation_version')`;
    expect(constants).toEqual([]);
    const owned = await fixture.sql<{ table: string; nullable: string }[]>`
      SELECT table_name AS table, is_nullable AS nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'owner_extension_id' ORDER BY 1`;
    expect(owned).toEqual(
      [
        "capability_binding",
        "integration_config",
        "integration_secret",
        "service_config",
        "service_secret",
      ].map((table) => ({ table, nullable: "YES" })),
    );
  });

  it("indexes the prune paths and active admin jobs", async () => {
    const indexes = await fixture.sql<{ name: string; definition: string }[]>`
      SELECT indexname AS name, indexdef AS definition FROM pg_indexes
      WHERE schemaname IN ('public', 'data_manager') AND indexname IN (
        'job_finished_at_idx',
        'job_operation_key_idx',
        'admin_action_reauthentication_expires_at_idx',
        'data_disclosure_event_occurred_at_idx',
        'session_expires_at_idx',
        'oauth_access_token_expires_at_idx',
        'oauth_refresh_token_expires_at_idx',
        'oauth_client_assertion_expires_at_idx',
        'account_action_receipt_created_at_idx',
        'integration_application_receipt_created_at_idx',
        'auth_policy_application_created_at_idx',
        'share_link_expires_at_idx',
        'parked_location_expires_at_idx',
        'health_history_checked_at_idx',
        'mangrove_keypair_wrap_user_id_idx',
        'admin_audit_log_target_type_target_id_idx',
        'admin_job_type_idx',
        'admin_job_status_idx'
      ) ORDER BY 1`;
    expect(Object.fromEntries(indexes.map((row) => [row.name, row.definition]))).toEqual({
      // The declared retention deletes by expiry or creation time in batches.
      account_action_receipt_created_at_idx: expect.stringContaining("(created_at)"),
      admin_action_reauthentication_expires_at_idx: expect.stringContaining("(expires_at)"),
      auth_policy_application_created_at_idx: expect.stringContaining("(created_at)"),
      integration_application_receipt_created_at_idx: expect.stringContaining("(created_at)"),
      oauth_access_token_expires_at_idx: expect.stringContaining("(expires_at)"),
      oauth_client_assertion_expires_at_idx: expect.stringContaining("(expires_at)"),
      oauth_refresh_token_expires_at_idx: expect.stringContaining("(expires_at)"),
      parked_location_expires_at_idx: expect.stringMatching(
        /\(expires_at\) WHERE \(expires_at IS NOT NULL\)$/,
      ),
      session_expires_at_idx: expect.stringContaining("(expires_at)"),
      share_link_expires_at_idx: expect.stringMatching(
        /\(expires_at\) WHERE \(expires_at IS NOT NULL\)$/,
      ),
      admin_audit_log_target_type_target_id_idx: expect.stringContaining(
        "(target_type, target_id)",
      ),
      admin_job_type_idx: expect.stringMatching(
        /\(type\) WHERE \(status = ANY \(ARRAY\['queued'::text, 'running'::text, 'cancel_pending'::text\]\)\)$/,
      ),
      data_disclosure_event_occurred_at_idx: expect.stringContaining("(occurred_at)"),
      health_history_checked_at_idx: expect.stringContaining("(checked_at)"),
      // Data-manager jobs stay 90 days: the API's prune selects by finish time,
      // and the control prune sweeps the keys of restore-closed rows.
      job_finished_at_idx: expect.stringContaining("data_manager.job USING btree (finished_at)"),
      job_operation_key_idx: expect.stringMatching(
        /\(operation_key\) WHERE \(\(execution_admission IS NULL\) AND \(released_at IS NULL\)\)$/,
      ),
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
      "system_secret",
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
      { table: "system_secret", constraint: "system_secret_pkey", columns: ["key"] },
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
      "integration_secret_updated_by_user_id_idx",
      "service_config_pkey",
      "service_secret_pkey",
      "service_secret_updated_by_user_id_idx",
      "system_secret_pkey",
      "system_secret_updated_by_user_id_idx",
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
        fixture.sql`INSERT INTO ${fixture.sql(table)} (${fixture.sql(owner)}, key, ciphertext, iv, tag, key_version)
          VALUES ('natural-key', ${key}, 'c', 'i', 't', 1)`;
      await insert("TOKEN");
      await insert("OTHER");
      await expect(insert("TOKEN")).rejects.toMatchObject({ constraint_name: `${table}_pkey` });
    }
    const [job] = await fixture.sql<{ id: string }[]>`
      INSERT INTO admin_job (type) VALUES ('integration.reload') RETURNING id`;
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
      SELECT 'integration.reload', 'succeeded' FROM generate_series(1, 2000)`;
    await fixture.sql`ANALYZE admin_job`;
    const lookup = (status: SQL) =>
      fixture.db
        .select({ id: adminJob.id })
        .from(adminJob)
        .where(and(eq(adminJob.type, "integration.reload"), status))
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
      await genericPlan(lookup(adminJobStatusIn(adminJob.status, ACTIVE_JOB_STATUSES))),
    ).toContain("admin_job_type_idx");
    expect(
      await genericPlan(lookup(adminJobStatusIn(adminJob.status, ["running", "cancel_pending"]))),
    ).toContain("admin_job_type_idx");
    // Bound statuses cannot prove the index predicate once the plan is generic.
    expect(
      await genericPlan(lookup(inArray(adminJob.status, [...ACTIVE_JOB_STATUSES]))),
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
      "app_log.level",
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
      snapshotVersion?: number | null;
    }) => fixture.sql`INSERT INTO share_link
        (user_id, token_hash, target_type, target_id, mode, label, snapshot, snapshot_version)
      VALUES ('share-owner', ${values.token}, ${values.targetType}, ${values.targetId},
        ${values.mode}, 'Label', ${values.snapshot}::jsonb,
        ${values.snapshotVersion === undefined ? (values.snapshot === null ? null : 1) : values.snapshotVersion})`;
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
    for (const [token, snapshot, snapshotVersion] of [
      ["unversioned-snapshot", "{}", null],
      ["unknown-version", "{}", 2],
      ["version-without-snapshot", null, 1],
    ] as const)
      await expect(
        insert({
          token,
          targetType: "list",
          targetId: listId,
          mode: snapshot ? "snapshot" : "live",
          snapshot,
          snapshotVersion,
        }),
      ).rejects.toMatchObject({ constraint_name: "share_link_snapshot_version_check" });
  });

  it("refuses a second default vehicle, coordinates out of range and an unversioned blob", async () => {
    await seedUser("garage-owner");
    const vehicle = (name: string, isDefault: boolean) =>
      fixture.sql`INSERT INTO personal_vehicle (user_id, name, kind, powertrain, is_default)
        VALUES ('garage-owner', ${name}, 'car', 'petrol', ${isDefault})`;
    await vehicle("First", true);
    await vehicle("Second", false);
    await expect(vehicle("Third", true)).rejects.toMatchObject({
      constraint_name: "personal_vehicle_user_id_default_key",
    });
    await expect(
      fixture.sql`INSERT INTO personal_vehicle (user_id, name, kind, powertrain, ev)
        VALUES ('garage-owner', 'Electric', 'car', 'electric', '{}'::jsonb)`,
    ).rejects.toMatchObject({ constraint_name: "personal_vehicle_ev_version_check" });
    for (const [lat, lng, constraint] of [
      [91, 0, "parked_location_lat_check"],
      [0, -181, "parked_location_lng_check"],
    ] as const)
      await expect(
        fixture.sql`INSERT INTO parked_location (user_id, lat, lng, source)
          VALUES ('garage-owner', ${lat}, ${lng}, 'manual')`,
      ).rejects.toMatchObject({ constraint_name: constraint });
    for (const [lat, lng, constraint] of [
      [-90.5, 0, "labeled_place_lat_check"],
      [0, 180.5, "labeled_place_lng_check"],
    ] as const)
      await expect(
        fixture.sql`INSERT INTO labeled_place (user_id, label, name, lat, lng)
          VALUES ('garage-owner', ${constraint}, 'Place', ${lat}, ${lng})`,
      ).rejects.toMatchObject({ constraint_name: constraint });
    const [label] = await fixture.sql<{ stamped: boolean }[]>`
      INSERT INTO labeled_place (user_id, label, name, lat, lng)
      VALUES ('garage-owner', 'home', 'Home', 90, -180)
      RETURNING created_at IS NOT NULL AND updated_at IS NOT NULL AS stamped`;
    expect(label?.stamped).toBe(true);
  });

  it("stores only durable place ids on saved and labelled places", async () => {
    await seedUser("place-owner");
    const label = (name: string, placeId: string | null) =>
      fixture.sql`INSERT INTO labeled_place (user_id, label, name, lat, lng, place_id)
        VALUES ('place-owner', ${name}, 'Place', 50, 6, ${placeId})`;
    await label("none", null);
    await label("osm", "osm:node/123");
    await label("kebab", "openseamap-harbour:4");
    for (const placeId of [
      "style-poi:42",
      "saved:0193e4a0-0000-7000-8000-000000000001",
      "label:0193e4a0-0000-7000-8000-000000000002",
      "coordinate:50.000000,6.000000",
      "stylePoi:42",
      "osm:",
      "no-scheme",
    ])
      await expect(label(placeId, placeId)).rejects.toMatchObject({
        constraint_name: "labeled_place_place_id_check",
      });
    const [list] = await fixture.sql<{ id: string }[]>`
      INSERT INTO saved_list (user_id, name) VALUES ('place-owner', 'Trip') RETURNING id`;
    await expect(
      fixture.sql`INSERT INTO saved_place (list_id, name, lat, lng, place_id)
        VALUES (${list?.id ?? null}, 'Place', 50, 6, 'style-poi:42')`,
    ).rejects.toMatchObject({ constraint_name: "saved_place_place_id_check" });
  });

  it("admits a cancel_pending admin job and refuses an unknown status or type", async () => {
    await fixture.sql`INSERT INTO admin_job (type, status) VALUES ('integration.reload', 'cancel_pending')`;
    for (const type of ["extension.enable", "extension.disable", "extension.purge"])
      await fixture.sql`INSERT INTO admin_job (type) VALUES (${type})`;
    await expect(
      fixture.sql`INSERT INTO admin_job (type, status) VALUES ('integration.reload', 'cancelling')`,
    ).rejects.toMatchObject({ constraint_name: "admin_job_status_check" });
    await expect(
      fixture.sql`INSERT INTO admin_job (type, status) VALUES ('integration.reloaded', 'queued')`,
    ).rejects.toMatchObject({ constraint_name: "admin_job_type_check" });
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

  describe("extension platform rows", () => {
    const refused = (statement: Promise<unknown>, constraint: string) =>
      expect(statement).rejects.toMatchObject({ constraint_name: constraint });
    const demo = () =>
      fixture.sql`INSERT INTO installed_extension (id, name, installed_version) VALUES ('demo', 'Demo', '1.0.0')
        ON CONFLICT DO NOTHING`;

    it("installed extensions carry their state, approvals and pins", async () => {
      await demo();
      const [extension] =
        await fixture.sql`SELECT enabled, approved_grants FROM installed_extension WHERE id = 'demo'`;
      expect(extension).toEqual({ enabled: true, approved_grants: {} });
      await refused(
        fixture.sql`UPDATE installed_extension SET approved_grants = '["gpu"]'::jsonb WHERE id = 'demo'`,
        "installed_extension_approved_grants_check",
      );
      const component = (kind: string, id: string, commit: string | null, digest: string | null) =>
        fixture.sql`INSERT INTO installed_extension_component (extension_id, kind, component_id, resolved_commit, image_digest)
          VALUES ('demo', ${kind}, ${id}, ${commit}, ${digest})`;
      await component("service", "demo-engine", "a".repeat(40), `sha256:${"b".repeat(64)}`);
      await component("service", "demo-plain", null, null);
      await component("integration", "demo-adapter", "a".repeat(40), null);
      await refused(
        component("service", "demo-tag", "v1.0.0", null),
        "installed_extension_component_resolved_commit_check",
      );
      await refused(
        component("service", "demo-digest", null, "b".repeat(64)),
        "installed_extension_component_image_digest_check",
      );
    });

    it("approved grants are stored only in their one normalised form", async () => {
      await demo();
      const store = (grants: unknown) =>
        fixture.sql`UPDATE installed_extension SET approved_grants = ${JSON.stringify(grants)}::jsonb
          WHERE id = 'demo'`;
      for (const grants of [
        { svc: "gpu" },
        { svc: [1, 2] },
        { svc: ["privileged", "gpu"] },
        { svc: ["gpu", "gpu"] },
        { svc: { a: 1 } },
        { svc: ["gpu", null] },
        ["gpu"],
      ])
        await refused(store(grants), "installed_extension_approved_grants_check");
      await store({});
      await store({ svc: ["gpu", "privileged"], other: [] });

      // Grant identifiers mixing every character class a grant may hold: the
      // database's order must be the code-unit order the API sorts in.
      const identifiers: GrantId[] = [
        "gpu",
        "host-network",
        "logging",
        "peer-services",
        "privileged",
        "reachable-by-platform",
        "host-path:/srv/data:ro",
        "host-path:/srv/data:rw",
        "host-path:/srv/data/2:ro",
        "host-path:/srv/data/A:ro",
        "host-path:/srv/data/a:ro",
        "host-path:/srv/data-2:ro",
        "host-path:/srv/data.2:ro",
        "host-path:/srv/data_2:ro",
        "host-path:/srv/dataA:ro",
        "host-path:/srv/Data:ro",
        "host-path:/srv/data0:ro",
        "host-path:/srv/data9:ro",
        "device:/dev/dri/renderD128",
        "device:/dev/tty-a",
        "device:/dev/tty_a",
        "device:/dev/ttyA",
        "device:/dev/ttya",
        "device:/dev/tty0",
        "device:/dev/tty/a",
        "capability:NET_ADMIN",
        "capability:NET_RAW",
        "capability:SYS_TIME",
        "capability:_",
        "platform-service:redis",
        "platform-service:demo-engine",
        "platform-service:demo0",
        "database-role:demo_role",
        "database-role:demo2_role",
        "database-role:demorole",
      ];
      const sorted = normalizeGrants(identifiers);
      const byDatabase = await fixture.sql<{ id: string }[]>`
        SELECT id FROM unnest(${identifiers}::text[]) AS id ORDER BY id COLLATE "C"`;
      expect(byDatabase.map((row) => row.id)).toEqual(sorted);
      const parsed = approvedGrantsSchema.parse({ "demo-engine": sorted, "demo-plain": [] });
      await store(parsed);
      expect(
        await fixture.sql`SELECT approved_grants FROM installed_extension WHERE id = 'demo'`,
      ).toEqual([{ approved_grants: parsed }]);
      // Each neighbouring pair swapped is refused by both, so they agree on
      // every adjacent comparison, not only on the whole list.
      for (let i = 1; i < sorted.length; i++) {
        const swapped = [...sorted];
        [swapped[i - 1], swapped[i]] = [swapped[i] as GrantId, swapped[i - 1] as GrantId];
        expect(approvedGrantsSchema.safeParse({ "demo-engine": swapped }).success, `${i}`).toBe(
          false,
        );
        await refused(
          store({ "demo-engine": swapped }),
          "installed_extension_approved_grants_check",
        );
      }
    });

    it("configuration rows carry an owner and a schema version, and outlive the extension", async () => {
      await demo();
      await fixture.sql`INSERT INTO service_config (service_id, config, owner_extension_id) VALUES ('demo-engine', '{}'::jsonb, 'demo')`;
      expect(
        await fixture.sql`SELECT schema_version FROM service_config WHERE service_id = 'demo-engine'`,
      ).toEqual([{ schema_version: 1 }]);
      await refused(
        fixture.sql`UPDATE service_config SET schema_version = 0 WHERE service_id = 'demo-engine'`,
        "service_config_schema_version_check",
      );
      await refused(
        fixture.sql`INSERT INTO integration_config (integration_id, config, schema_version) VALUES ('demo-adapter', '{}'::jsonb, 0)`,
        "integration_config_schema_version_check",
      );
      const targets = JSON.stringify([
        { component: "service:demo-engine", key: "INSTANCE_ID" },
        { capability: "acme/feed" },
      ]);
      await fixture.sql`INSERT INTO extension_setting (extension_id, key, value, targets) VALUES ('demo', 'instanceId', 'maps.example.org', ${targets}::jsonb)`;
      await fixture.sql`INSERT INTO extension_setting (extension_id, key, ciphertext, iv, tag, key_version, targets, generated)
        VALUES ('demo', 'relayToken', 'c', 'i', 't', 1, ${targets}::jsonb, true)`;
      await refused(
        fixture.sql`INSERT INTO extension_setting (extension_id, key, value, ciphertext, iv, tag, key_version, targets)
          VALUES ('demo', 'both', 'v', 'c', 'i', 't', 1, '[]'::jsonb)`,
        "extension_setting_value_check",
      );
      await refused(
        fixture.sql`INSERT INTO extension_setting (extension_id, key, targets) VALUES ('demo', 'neither', '[]'::jsonb)`,
        "extension_setting_value_check",
      );
      await refused(
        fixture.sql`INSERT INTO extension_setting (extension_id, key, value, targets, generated) VALUES ('demo', 'plain', 'v', '[]'::jsonb, true)`,
        "extension_setting_generated_check",
      );
      await refused(
        fixture.sql`INSERT INTO extension_setting (extension_id, key, value, targets) VALUES ('demo', 'object', 'v', '{}'::jsonb)`,
        "extension_setting_targets_check",
      );
      for (const key of ["RELAY_TOKEN", "relay_token", "relayTOKEN", `k${"a".repeat(64)}`])
        await refused(
          fixture.sql`INSERT INTO extension_setting (extension_id, key, value, targets) VALUES ('demo', ${key}, 'v', '[]'::jsonb)`,
          "extension_setting_key_check",
        );
      await refused(
        fixture.sql`INSERT INTO extension_setting (extension_id, key, value, targets) VALUES ('demo', 'instanceId', 'other', '[]'::jsonb)`,
        "extension_setting_pkey",
      );
      await fixture.sql`INSERT INTO extension_advisory_ack (extension_id, advisory_key) VALUES ('demo', ${"d".repeat(64)})`;
      await refused(
        fixture.sql`INSERT INTO extension_advisory_ack (extension_id, advisory_key) VALUES ('demo', 'advisory-1')`,
        "extension_advisory_ack_advisory_key_check",
      );
      await refused(
        fixture.sql`INSERT INTO extension_advisory_ack (extension_id, advisory_key) VALUES ('absent', ${"d".repeat(64)})`,
        "extension_advisory_ack_extension_id_fkey",
      );
      await fixture.sql`DELETE FROM installed_extension WHERE id = 'demo'`;
      expect(
        await fixture.sql`SELECT 1 FROM extension_advisory_ack WHERE extension_id = 'demo'`,
      ).toHaveLength(0);
      expect(
        await fixture.sql`SELECT 1 FROM extension_setting WHERE extension_id = 'demo'`,
      ).toHaveLength(2);
      expect(
        await fixture.sql`SELECT owner_extension_id FROM service_config WHERE service_id = 'demo-engine'`,
      ).toEqual([{ owner_extension_id: "demo" }]);
    });

    it("task runs allow one running row per task, and migrations a numbered name", async () => {
      const run = (status: string, finished: string | null) =>
        fixture.sql`INSERT INTO integration_task_run (integration_id, task_name, status, finished_at)
          VALUES ('demo-adapter', 'import', ${status}, ${finished}) RETURNING id`;
      const [first] = await run("running", null);
      await refused(run("running", null), "integration_task_run_running_key");
      await refused(run("succeeded", null), "integration_task_run_finished_at_check");
      await refused(
        run("interrupted", "2026-11-25T00:00:00Z"),
        "integration_task_run_status_check",
      );
      await fixture.sql`UPDATE integration_task_run SET status = 'failed', finished_at = now(), error = 'interrupted by a restart'
        WHERE id = ${first?.id ?? null}`;
      await run("running", null);
      const migration = (name: string, sha256: string) =>
        fixture.sql`INSERT INTO extension_migration (integration_id, name, sha256) VALUES ('demo-adapter', ${name}, ${sha256})`;
      await migration("0001_create_reports.sql", "0".repeat(64));
      await refused(migration("create.sql", "0".repeat(64)), "extension_migration_name_check");
      await refused(migration("0002_a__b.sql", "0".repeat(64)), "extension_migration_name_check");
      await refused(migration("0002_more.sql", "abc"), "extension_migration_sha256_check");
      await refused(
        migration("0001_create_reports.sql", "1".repeat(64)),
        "extension_migration_pkey",
      );
    });

    it("name claims, catalogue sources and the revocation snapshot keep their keys", async () => {
      const claim = (kind: string, name: string, extension: string) =>
        fixture.sql`INSERT INTO extension_name_claim (kind, name, extension_id, source) VALUES (${kind}, ${name}, ${extension}, 'verified')`;
      await claim("service", "demo-engine", "demo");
      await claim("database-role", "demo-engine", "demo");
      await refused(claim("service", "demo-engine", "other"), "extension_name_claim_pkey");
      await refused(claim("volume", "demo-data", "demo"), "extension_name_claim_kind_check");
      await fixture.sql`INSERT INTO extension_catalog_source (url, label) VALUES ('https://example.org/catalog.json', 'Example')`;
      const snapshot = (id: number, body: string) =>
        fixture.sql`INSERT INTO extension_revocation_snapshot (id, snapshot, fetched_at) VALUES (${id}, ${body}::jsonb, now())`;
      await snapshot(1, '{"removed":[],"critical":[["demo",{"reason":"advisory"}]]}');
      await refused(
        snapshot(2, '{"removed":[],"critical":[]}'),
        "extension_revocation_snapshot_singleton_check",
      );
      await fixture.sql`DELETE FROM extension_revocation_snapshot`;
      await refused(snapshot(1, '{"removed":{}}'), "extension_revocation_snapshot_snapshot_check");
      await refused(snapshot(1, "{}"), "extension_revocation_snapshot_snapshot_check");
    });

    it("pending erasures count attempts, and attention rows have closed value sets", async () => {
      await fixture.sql`INSERT INTO subject_erasure_pending (integration_id, subject_user_id) VALUES ('demo-adapter', 'user-1')`;
      expect(await fixture.sql`SELECT attempts, last_error FROM subject_erasure_pending`).toEqual([
        { attempts: 0, last_error: null },
      ]);
      await refused(
        fixture.sql`UPDATE subject_erasure_pending SET attempts = -1`,
        "subject_erasure_pending_attempts_check",
      );
      await refused(
        fixture.sql`INSERT INTO subject_erasure_pending (integration_id, subject_user_id) VALUES ('demo-adapter', 'user-1')`,
        "subject_erasure_pending_pkey",
      );
      await fixture.sql`INSERT INTO integration_subject_handler (integration_id) VALUES ('demo-adapter')`;
      await refused(
        fixture.sql`INSERT INTO integration_subject_handler (integration_id) VALUES ('demo-adapter')`,
        "integration_subject_handler_pkey",
      );
      await refused(
        fixture.sql`INSERT INTO attention_item (key, severity, source, title) VALUES ('k', 'error', 's', 't')`,
        "attention_item_severity_check",
      );
      await refused(
        fixture.sql`INSERT INTO attention_item (key, severity, source, title, clearance) VALUES ('k', 'info', 's', 't', 'dismiss')`,
        "attention_item_clearance_check",
      );
      await fixture.sql`INSERT INTO attention_item (key, severity, source, title) VALUES ('k', 'info', 's', 't')`;
      expect(
        await fixture.sql`SELECT clearance, acknowledged_at, occurrence_ref FROM attention_item WHERE key = 'k'`,
      ).toEqual([{ clearance: "condition", acknowledged_at: null, occurrence_ref: null }]);
      await fixture.sql`INSERT INTO attention_observation (key, since) VALUES ('k', now())`;
      expect(
        await fixture.sql`SELECT bad_count, good_count, data FROM attention_observation WHERE key = 'k'`,
      ).toEqual([{ bad_count: 0, good_count: 0, data: null }]);
      const notification = (channel: string, severity: string, status = "pending") =>
        fixture.sql`INSERT INTO attention_notification (attention_key, occurrence, channel, severity, status, due_at)
          VALUES ('k', 'o1', ${channel}, ${severity}, ${status}, now())`;
      await notification("email", "warning");
      await refused(
        notification("email", "critical"),
        "attention_notification_attention_key_occurrence_channel_key",
      );
      await refused(notification("sms", "warning"), "attention_notification_channel_check");
      await refused(notification("webhook", "info"), "attention_notification_severity_check");
      await refused(
        notification("webhook", "warning", "cancelled"),
        "attention_notification_status_check",
      );
      await fixture.sql`DELETE FROM attention_item WHERE key = 'k'`;
      expect(
        await fixture.sql`SELECT status, attempts FROM attention_notification WHERE attention_key = 'k'`,
      ).toEqual([{ status: "pending", attempts: 0 }]);
    });
  });
});

describe("table and column naming rules", () => {
  it("refuse each misnamed table and column", () => {
    const column = (table: string, name: string, referencesUser = false): OwnedColumn => ({
      schema: "public",
      table,
      column: name,
      referencesUser,
    });
    expect(
      namingViolations([
        column("widgets", "id"),
        column("widget", "actor_id", true),
        column("widget", "created_by", true),
        column("widget", "owner_user_id", true),
        column("widget", "state"),
        column("widget", "sync_state"),
        column("mobile_auth_handoff", "state"),
        column("data_subject_request", "account_state"),
        column("widget", "msg"),
        column("widget", "encrypted_api_key"),
        column("widget", "token_ciphertext"),
        column("widget", "token_iv"),
        column("widget", "token_tag"),
        column("vault", "ciphertext"),
        column("vault", "iv"),
        column("vault", "tag"),
        column("vault", "key_version"),
      ]),
    ).toEqual([
      'widget.actor_id: a column referencing "user" is <role>_user_id',
      "widget.actor_id: the acting account is actor_user_id",
      'widget.created_by: a column referencing "user" is <role>_user_id',
      "widget.encrypted_api_key: an encrypted value is <prefix>_ciphertext, _iv, _tag, _key_version",
      "widget.msg: names are spelled out",
      "widget.state: a lifecycle column is status",
      "widget.sync_state: a lifecycle column is status",
      "widget.token_ciphertext: encrypted value lacks token_key_version",
      "widget.token_iv: encrypted value lacks token_key_version",
      "widget.token_tag: encrypted value lacks token_key_version",
      "widgets: table names are singular",
    ]);
  });
});
