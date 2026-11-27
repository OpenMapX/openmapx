import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initializeErasureJournal,
  isErasedSubject,
  readErasureJournal,
} from "@openmapx/core/erasure-journal";
import type { StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type { Sql } from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DIRECT_USER_FK_CLASSIFICATIONS,
  NON_USER_ID_COLUMNS,
  USER_ID_COLUMNS_WITHOUT_USER_FOREIGN_KEY,
} from "../../../../../scripts/check-subject-data";
import { withAccountMutation } from "../../account/account-mutations";
import { deriveOfflinePackagePrincipal } from "../../services/offline-package-principal";
import { userErasureHooks } from "../../services/user-erasure";
import {
  API_MIGRATIONS,
  connectProductionPostgis,
  productionPostgisPasswords,
  startProductionPostgis,
} from "../../test/production-postgis";
import { db } from "../index";
import {
  dataManagerOfflinePackageArtifactReference,
  dataManagerOfflinePackageJob,
  dataManagerOfflinePackageJobOwner,
  dataSubjectRequest,
  user,
} from "../schema";

const skipDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1";

/** Column names that can hold an account id. Every match must reference
 * "user", be cleared by the erasure trigger or the API hook, or be
 * classified as holding no account id. */
const USER_ID_COLUMN_NAME = "(^|_)(user_id|actor_id|target_id|recipient_id|principal|owner)$|_by$";

function columnKey(schema: string, table: string, column: string): string {
  return schema === "public" ? `${table}.${column}` : `${schema}.${table}.${column}`;
}

describe.skipIf(skipDatabase)("user erasure constraints with PostgreSQL", () => {
  it("keeps every direct user foreign key on an explicit erase-safe action", async () => {
    const result = await db.execute(sql`
      SELECT child_ns.nspname AS schema_name,
             child.relname AS table_name,
             child_column.attname AS column_name,
             fk.confdeltype AS delete_action
      FROM pg_constraint fk
      JOIN pg_class parent ON parent.oid = fk.confrelid
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
      JOIN pg_attribute child_column
        ON child_column.attrelid = child.oid
       AND child_column.attnum = fk.conkey[1]
      WHERE fk.contype = 'f'
        AND parent.relname = 'user'
        -- An integration's ext_ schema is its own; its migrations choose its keys.
        AND child_ns.nspname IN ('public', 'data_manager')
      ORDER BY child.relname, child_column.attname
    `);

    const rows = Array.from(result as Iterable<Record<string, unknown>>).map(
      (row) =>
        `${columnKey(String(row.schema_name), String(row.table_name), String(row.column_name))}:${row.delete_action}`,
    );
    expect(rows.map((row) => row.split(":")[0]).sort()).toEqual(
      Object.keys(DIRECT_USER_FK_CLASSIFICATIONS).sort(),
    );
    expect(rows).toEqual([
      "account.user_id:c",
      "account_action_receipt.actor_user_id:n",
      "account_action_receipt.target_user_id:n",
      "account_mail_outbox.user_id:c",
      "admin_action_reauthentication.actor_user_id:c",
      "admin_audit_log.actor_user_id:n",
      "admin_audit_log.target_user_id:n",
      "admin_job.created_by_user_id:n",
      "auth_policy_application.actor_user_id:n",
      "auth_policy_state.activated_by_user_id:n",
      "configuration_migration_preview.actor_user_id:c",
      "data_disclosure_event.user_id:n",
      "data_subject_request.actor_user_id:n",
      "data_subject_request.user_id:n",
      "data_subject_request_event.actor_user_id:n",
      "data_subject_request_notification.recipient_user_id:n",
      "installed_extension.installed_by_user_id:n",
      "installed_integration.installed_by_user_id:n",
      "integration_application_receipt.actor_user_id:n",
      "integration_secret.updated_by_user_id:n",
      "data_manager.job.triggered_by_user_id:n",
      "labeled_place.user_id:c",
      "mangrove_keypair.user_id:c",
      "mobile_auth_handoff.user_id:c",
      "oauth_access_token.user_id:c",
      "oauth_client.user_id:c",
      "oauth_consent.user_id:c",
      "oauth_refresh_token.user_id:c",
      "parked_location.user_id:c",
      "passkey.user_id:c",
      "personal_timeline_connection.user_id:c",
      "personal_vehicle.user_id:c",
      "platform_configuration_preview.actor_user_id:c",
      "saved_list.user_id:c",
      "service_secret.updated_by_user_id:n",
      "session.user_id:c",
      "session_auth_assurance.user_id:n",
      "share_link.user_id:c",
      "system_secret.updated_by_user_id:n",
      "system_setting.updated_by_user_id:n",
      "transit_credential_preview.actor_user_id:c",
      "two_factor.user_id:c",
    ]);
  });

  it("keeps the case history and marks every request of a deleted account as deleted", async () => {
    const userId = `erasure-privacy-${randomUUID()}`;
    await db.insert(user).values({
      id: userId,
      name: "Privacy erasure test",
      email: `${userId}@example.test`,
    });
    const requestBase = {
      kind: "access" as const,
      channel: "self_service" as const,
      userId,
      receivedAt: new Date(),
      dueAt: new Date(Date.now() + 86_400_000),
      identityMethod: "account_session" as const,
      identityVerifiedAt: new Date(),
    };
    const requests = await db
      .insert(dataSubjectRequest)
      .values([
        { ...requestBase, status: "completed" },
        { ...requestBase, kind: "portability", status: "in_progress" },
      ])
      .returning({ id: dataSubjectRequest.id });
    const ids = requests.map((request) => request.id);
    try {
      await db.delete(user).where(eq(user.id, userId));

      const after = await db
        .select({
          status: dataSubjectRequest.status,
          accountState: dataSubjectRequest.accountState,
          userId: dataSubjectRequest.userId,
          version: dataSubjectRequest.version,
        })
        .from(dataSubjectRequest)
        .where(inArray(dataSubjectRequest.id, ids));
      expect(after).toEqual(
        expect.arrayContaining([
          { status: "completed", accountState: "deleted", userId: null, version: 2 },
          { status: "in_progress", accountState: "deleted", userId: null, version: 2 },
        ]),
      );
    } finally {
      await db.delete(dataSubjectRequest).where(inArray(dataSubjectRequest.id, ids));
      await db.delete(user).where(eq(user.id, userId));
    }
  });

  it("the API delete path also removes offline-package rows for the user's principal", async () => {
    // The production hooks, journal and key files, in the transaction a
    // self-service deletion runs them in.
    const files = mkdtempSync(join(tmpdir(), "openmapx-erasure-hook-"));
    const journalKey = randomBytes(32);
    const key = randomBytes(32);
    const journalPath = join(files, "journal.jsonl");
    initializeErasureJournal(journalPath, journalKey, new Date());
    writeFileSync(join(files, "journal-key"), journalKey.toString("base64url"), { mode: 0o444 });
    writeFileSync(join(files, "offline-key"), key.toString("base64url"), { mode: 0o444 });
    vi.stubEnv("ERASURE_JOURNAL_PATH", journalPath);
    vi.stubEnv("ERASURE_JOURNAL_KEY_FILE", join(files, "journal-key"));
    vi.stubEnv("ERASURE_JOURNAL_KEY_UID", String(process.getuid?.() ?? 0));
    vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_FILE", join(files, "offline-key"));
    vi.stubEnv("OFFLINE_PACKAGE_PRINCIPAL_KEY_UID", undefined);
    const userId = `erasure-offline-${randomUUID()}`;
    const principal = deriveOfflinePackagePrincipal(userId, key);
    const otherPrincipal = deriveOfflinePackagePrincipal(`${userId}-other`, key);
    const jobId = randomUUID();
    const packageId = `erasure-package-${randomUUID()}`;
    await db.insert(user).values({ id: userId, name: "Offline", email: `${userId}@example.test` });
    await db.insert(dataManagerOfflinePackageJob).values({
      id: jobId,
      requestKey: `request-${jobId}`,
      packageId,
      request: {},
      status: "ready-to-download",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(dataManagerOfflinePackageJobOwner).values(
      [principal, otherPrincipal].map((owner) => ({
        jobId,
        principal: owner,
        createdAt: new Date(),
      })),
    );
    await db.insert(dataManagerOfflinePackageArtifactReference).values(
      [principal, otherPrincipal].map((owner) => ({
        principal: owner,
        packageId,
        byteLength: 10,
        retainedAt: new Date(),
      })),
    );
    try {
      const subject = { id: userId, email: `${userId}@example.test` };
      await withAccountMutation(
        {
          actorId: userId,
          targetId: userId,
          action: "delete",
          mutationKey: `erasure-hook-${userId}`,
          selfServiceDelete: true,
        },
        async (tx) => {
          await userErasureHooks.before(subject);
          await tx.delete(user).where(eq(user.id, userId));
          await userErasureHooks.after(subject);
        },
        db,
      );

      expect(isErasedSubject(readErasureJournal(journalPath, journalKey), journalKey, userId)).toBe(
        true,
      );
      expect(
        await db
          .select({ principal: dataManagerOfflinePackageJobOwner.principal })
          .from(dataManagerOfflinePackageJobOwner)
          .where(eq(dataManagerOfflinePackageJobOwner.jobId, jobId)),
      ).toEqual([{ principal: otherPrincipal }]);
      expect(
        await db
          .select({ principal: dataManagerOfflinePackageArtifactReference.principal })
          .from(dataManagerOfflinePackageArtifactReference)
          .where(eq(dataManagerOfflinePackageArtifactReference.packageId, packageId)),
      ).toEqual([{ principal: otherPrincipal }]);
    } finally {
      await db
        .delete(dataManagerOfflinePackageArtifactReference)
        .where(eq(dataManagerOfflinePackageArtifactReference.packageId, packageId));
      await db
        .delete(dataManagerOfflinePackageJob)
        .where(eq(dataManagerOfflinePackageJob.id, jobId));
      await db.delete(user).where(eq(user.id, userId));
      vi.unstubAllEnvs();
      rmSync(files, { recursive: true, force: true });
    }
  });
});

/** The production layout: the API role migrates, owns the tables and the
 * trigger function, and deletes the account with plain SQL. */
describe.skipIf(skipDatabase)("user erasure as the API role", () => {
  const passwords = productionPostgisPasswords();
  let container: StartedPostgreSqlContainer;
  let api: Sql;

  beforeAll(async () => {
    container = await startProductionPostgis(passwords);
    api = connectProductionPostgis(container, "openmapx_api", passwords.api);
    await migrate(drizzle(api), { migrationsFolder: API_MIGRATIONS });
  }, 240_000);

  afterAll(async () => {
    await api?.end();
    await container?.stop();
  });

  async function insertUser(id: string, email: string, role: "user" | "admin" = "user") {
    await api`INSERT INTO "user" (id, name, email, role, created_at, updated_at)
      VALUES (${id}, ${id}, ${email}, ${role}, now(), now())`;
  }

  async function count(query: Promise<{ n: number }[]>): Promise<number> {
    const [row] = await query;
    return row?.n ?? -1;
  }

  it("every column holding a user id has a foreign key or a trigger rule", async () => {
    const columns = await api<{ schema: string; table: string; column: string; fk: boolean }[]>`
      SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
        EXISTS (
          SELECT FROM pg_constraint fk
          JOIN pg_class parent ON parent.oid = fk.confrelid
          JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
          WHERE fk.contype = 'f' AND fk.conrelid = c.oid AND a.attnum = ANY (fk.conkey)
            AND parent_ns.nspname = 'public' AND parent.relname = 'user'
        ) AS fk
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'data_manager')
        AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname ~ ${USER_ID_COLUMN_NAME}
      ORDER BY 1, 2, 3`;
    const keys = (rows: ReadonlyArray<(typeof columns)[number]>) =>
      rows.map((row) => columnKey(row.schema, row.table, row.column));

    const unclassified = keys(columns.filter((row) => !row.fk)).filter(
      (key) => !(key in USER_ID_COLUMNS_WITHOUT_USER_FOREIGN_KEY) && !(key in NON_USER_ID_COLUMNS),
    );
    expect(unclassified).toEqual([]);
    expect(keys(columns.filter((row) => row.fk)).sort()).toEqual(
      Object.keys(DIRECT_USER_FK_CLASSIFICATIONS).sort(),
    );
    // Every classified column exists, so the lists cannot go stale.
    const existing = await api<{ key: string }[]>`
      SELECT CASE WHEN table_schema = 'public' THEN '' ELSE table_schema || '.' END
             || table_name || '.' || column_name AS key
      FROM information_schema.columns WHERE table_schema IN ('public', 'data_manager')`;
    const existingKeys = new Set(existing.map((row) => row.key));
    for (const key of [
      ...Object.keys(USER_ID_COLUMNS_WITHOUT_USER_FOREIGN_KEY),
      ...Object.keys(NON_USER_ID_COLUMNS),
    ])
      expect(existingKeys, key).toContain(key);
  });

  it("deleting a user with plain SQL as the API role removes every residue the database can identify", async () => {
    const suffix = randomUUID();
    const userId = `erased-${suffix}`;
    const email = `Erased.${suffix}@Example.test`;
    const otherId = `kept-${suffix}`;
    const otherEmail = `prefix-${email.toLowerCase()}`;
    await insertUser(userId, email);
    await insertUser(otherId, otherEmail);
    const [request] = await api<{ id: string }[]>`
      INSERT INTO data_subject_request (kind, channel, user_id, actor_user_id, status,
        received_at, due_at, identity_method, identity_verified_at)
      VALUES ('access', 'self_service', ${userId}, ${userId}, 'in_progress', now(),
        now() + interval '30 days', 'account_session', now())
      RETURNING id`;
    if (!request) throw new Error("The privacy case was not created");
    await api`INSERT INTO data_subject_request_event (request_id, event_type, actor_kind, actor_user_id)
      VALUES (${request.id}, 'received', 'subject', ${userId})`;
    // Better Auth 1.7.18's email-otp plugin stores its codes under
    // `${type}-otp-${email}` with the address lower-cased
    // (plugins/email-otp/utils.mjs:5, routes.mjs:95-101) and a change of
    // address under `change-email-otp-${userId}:${newEmail}` (routes.mjs:642).
    // auth-postgres.test.ts creates the same rows through Better Auth itself.
    const verificationRows: [string, string, string][] = [
      ["v-value", "reset-password:token", userId],
      ["v-email", email.toUpperCase(), "code"],
      ["v-change", `change-email:${userId}:${email}`, "code"],
      ...["sign-in", "email-verification", "forget-password", "change-email"].map(
        (type): [string, string, string] => [
          `v-otp-${type}`,
          `${type}-otp-${email.toLowerCase()}`,
          "hash:0",
        ],
      ),
      ["v-otp-mixed-case", `sign-in-otp-${email}`, "hash:0"],
      ["v-otp-change-address", `change-email-otp-${userId}:new-${suffix}@example.test`, "hash:0"],
      ["v-kept", otherEmail, "code"],
      ["v-kept-otp-other-user", `sign-in-otp-${otherEmail}`, "hash:0"],
      ["v-kept-otp-longer-address", `sign-in-otp-${email.toLowerCase()}.evil`, "hash:0"],
      ["v-kept-otp-other-type", `magic-link-otp-${email.toLowerCase()}`, "hash:0"],
      [
        "v-kept-change-other-user",
        `change-email-otp-${otherId}:new-${suffix}@example.test`,
        "hash:0",
      ],
      [
        "v-kept-change-longer-id",
        `change-email-otp-${userId}-2:new-${suffix}@example.test`,
        "hash:0",
      ],
      [
        "v-kept-change-id-with-colon",
        `change-email-otp-${userId}:x:new-${suffix}@example.test`,
        "hash:0",
      ],
    ];
    for (const [id, identifier, value] of verificationRows)
      await api`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
        VALUES (${`${id}-${suffix}`}, ${identifier}, ${value}, now() + interval '1 hour', now(), now())`;
    await api`INSERT INTO system_setting (key, value, updated_by_user_id)
      VALUES ('legal.hosting.locations', '"value"', ${userId})
      ON CONFLICT (key) DO UPDATE SET updated_by_user_id = EXCLUDED.updated_by_user_id`;
    await api`INSERT INTO system_secret (key, ciphertext, iv, tag, key_version, updated_by_user_id)
      VALUES ('lettermint.apiToken', 'c', 'i', 't', 1, ${userId})
      ON CONFLICT (key) DO UPDATE SET updated_by_user_id = EXCLUDED.updated_by_user_id`;
    const [audit] = await api<{ id: string }[]>`
      INSERT INTO admin_audit_log (actor_user_id, target_id, target_type, target_user_id, action,
        details, ip_address, user_agent)
      VALUES (${userId}, ${userId}, 'user', ${userId}, 'user.ban',
        ${JSON.stringify({ contact: email.toLowerCase() })}::jsonb, '192.0.2.1', 'fixture-agent')
      RETURNING id`;
    const [targetAudit] = await api<{ id: string }[]>`
      INSERT INTO admin_audit_log (actor_user_id, target_id, target_type, target_user_id, action)
      VALUES (${otherId}, ${userId}, 'user', ${userId}, 'user.unban') RETURNING id`;
    const [mention] = await api<{ id: string }[]>`
      INSERT INTO admin_audit_log (actor_user_id, action, details, ip_address)
      VALUES (${otherId}, 'cache.clear', ${JSON.stringify({ about: userId })}::jsonb, '192.0.2.2')
      RETURNING id`;
    await api`INSERT INTO app_log (level, source, message, metadata)
      VALUES ('warn', ${`erased-${suffix}`}, ${`failure for ${email.toUpperCase()}`}, NULL),
             ('warn', ${`erased-${suffix}`}, 'no identifier', ${JSON.stringify({ subject: userId })}::jsonb),
             ('warn', ${`kept-${suffix}`}, ${`failure for ${otherEmail}`}, NULL)`;
    const finishedJob = (trigger: string, triggeredByUserId: string | null) => api<
      { id: string }[]
    >`
      INSERT INTO data_manager.job (kind, status, trigger, triggered_by_user_id, finished_at,
        operation_key, operation_fingerprint, execution_fingerprint, admitted_at, deadline_at,
        execution_input, execution_state, execution_ref)
      VALUES ('erasure-fixture', 'succeeded', ${trigger}, ${triggeredByUserId}, now(),
        ${`opk1_erasure_${randomUUID().replaceAll("-", "")}`}, ${"a".repeat(64)}, ${"b".repeat(64)},
        now(), now() + interval '1 hour', '{}', '{}', '{}') RETURNING id`;
    const [job] = await finishedJob("api", userId);
    const [otherJob] = await finishedJob("api", otherId);
    await api`INSERT INTO admin_action_reauthentication (actor_user_id, starting_session_id, purpose,
        target_id, nonce_digest, expires_at)
      VALUES (${otherId}, 'session', 'user.email.verify', ${userId}, ${`nonce-a-${suffix}`}, now() + interval '5 minutes'),
             (${otherId}, 'session', 'user.email.verify', ${otherId}, ${`nonce-b-${suffix}`}, now() + interval '5 minutes')`;

    await api`DELETE FROM "user" WHERE id = ${userId}`;

    expect(
      await api`SELECT status, account_state, user_id, actor_user_id, version
        FROM data_subject_request WHERE id = ${request.id}`,
    ).toEqual([
      {
        status: "in_progress",
        account_state: "deleted",
        user_id: null,
        actor_user_id: null,
        version: 2,
      },
    ]);
    expect(
      await api`SELECT actor_kind, actor_user_id FROM data_subject_request_event
        WHERE request_id = ${request.id}`,
    ).toEqual([{ actor_kind: "subject", actor_user_id: null }]);
    expect(
      (await api`SELECT id FROM verification WHERE id LIKE ${`v-%-${suffix}`}`)
        .map((row) => row.id)
        .sort(),
    ).toEqual(
      verificationRows
        .map(([id]) => `${id}-${suffix}`)
        .filter((id) => id.startsWith("v-kept"))
        .sort(),
    );
    expect(
      await api`SELECT updated_by_user_id FROM system_setting WHERE key = 'legal.hosting.locations'`,
    ).toEqual([{ updated_by_user_id: null }]);
    expect(
      await api`SELECT updated_by_user_id FROM system_secret WHERE key = 'lettermint.apiToken'`,
    ).toEqual([{ updated_by_user_id: null }]);
    expect(
      await api`SELECT actor_user_id, target_id, target_user_id, details, ip_address, user_agent
        FROM admin_audit_log WHERE id = ${audit?.id ?? ""}`,
    ).toEqual([
      {
        actor_user_id: null,
        target_id: null,
        target_user_id: null,
        details: null,
        ip_address: null,
        user_agent: null,
      },
    ]);
    expect(
      await api`SELECT actor_user_id, target_id, target_user_id FROM admin_audit_log
        WHERE id = ${targetAudit?.id ?? ""}`,
    ).toEqual([{ actor_user_id: otherId, target_id: null, target_user_id: null }]);
    expect(
      await api`SELECT actor_user_id, details, ip_address FROM admin_audit_log
        WHERE id = ${mention?.id ?? ""}`,
    ).toEqual([{ actor_user_id: otherId, details: null, ip_address: "192.0.2.2" }]);
    expect(
      await count(api`SELECT count(*)::int AS n FROM app_log WHERE source = ${`erased-${suffix}`}`),
    ).toBe(0);
    expect(
      await count(api`SELECT count(*)::int AS n FROM app_log WHERE source = ${`kept-${suffix}`}`),
    ).toBe(1);
    expect(
      await api`SELECT id, trigger, triggered_by_user_id FROM data_manager.job
        WHERE id IN (${job?.id ?? ""}, ${otherJob?.id ?? ""})
        ORDER BY triggered_by_user_id NULLS FIRST`,
    ).toEqual([
      { id: job?.id, trigger: "api", triggered_by_user_id: null },
      { id: otherJob?.id, trigger: "api", triggered_by_user_id: otherId },
    ]);
    expect(
      await api`SELECT target_id FROM admin_action_reauthentication WHERE actor_user_id = ${otherId}`,
    ).toEqual([{ target_id: otherId }]);
  });

  it("records a pending erasure for every integration that registered a handler", async () => {
    const suffix = randomUUID();
    const first = { id: `pending-first-${suffix}` };
    const second = { id: `pending-second-${suffix}` };
    await insertUser(first.id, `${first.id}@example.test`);
    await insertUser(second.id, `${second.id}@example.test`);

    await api`DELETE FROM "user" WHERE id = ${first.id}`;
    expect(
      await api`SELECT 1 FROM subject_erasure_pending WHERE subject_user_id = ${first.id}`,
    ).toHaveLength(0);
    await api`INSERT INTO integration_subject_handler (integration_id) VALUES ('demo-adapter'), ('demo-other')`;
    await api`INSERT INTO subject_erasure_pending (integration_id, subject_user_id, attempts, last_error)
      VALUES ('demo-adapter', ${second.id}, 3, 'timeout')`;
    await api`DELETE FROM "user" WHERE id = ${second.id}`;
    expect(
      await api`SELECT integration_id, attempts, last_error FROM subject_erasure_pending
        WHERE subject_user_id = ${second.id} ORDER BY 1`,
    ).toEqual([
      { integration_id: "demo-adapter", attempts: 3, last_error: "timeout" },
      { integration_id: "demo-other", attempts: 0, last_error: null },
    ]);

    await api`DELETE FROM subject_erasure_pending WHERE subject_user_id = ${second.id}`;
    await api`DELETE FROM integration_subject_handler WHERE integration_id IN ('demo-adapter', 'demo-other')`;
  });

  it("erases mentions of the deleted address as a whole address, not of longer ones", async () => {
    const userId = `whole-address-${randomUUID()}`;
    const tag = `whole-address-${randomUUID()}`;
    await insertUser(userId, "Bob@Example.com");
    const mentions = {
      mixedCase: "login BOB@example.COM",
      sentenceFinal: "Mail sent to bob@example.com.",
      inJsonLine: "first line\nbob@example.com",
      longerLocalPart: "login alice.bob@example.com",
      longerDomain: "mail to bob@example.com.evil",
    };
    for (const [name, text] of Object.entries(mentions)) {
      await api`INSERT INTO app_log (level, source, message, metadata)
        VALUES ('info', ${tag}, ${`${name}: ${text}`}, NULL)`;
      await api`INSERT INTO admin_audit_log (action, target_id, details)
        VALUES ('cache.clear', ${`${tag}:${name}`}, ${JSON.stringify({ note: text })}::jsonb)`;
    }

    await api`DELETE FROM "user" WHERE id = ${userId}`;

    const remainingLogs = await api<{ message: string }[]>`
      SELECT message FROM app_log WHERE source = ${tag} ORDER BY message`;
    expect(remainingLogs.map((row) => row.message.split(":")[0])).toEqual([
      "longerDomain",
      "longerLocalPart",
    ]);
    const audits = await api<{ target: string; scrubbed: boolean }[]>`
      SELECT target_id AS target, details IS NULL AS scrubbed FROM admin_audit_log
      WHERE target_id LIKE ${`${tag}:%`} ORDER BY target_id`;
    expect(
      Object.fromEntries(audits.map((row) => [row.target.split(":")[1], row.scrubbed])),
    ).toEqual({
      inJsonLine: true,
      longerDomain: false,
      longerLocalPart: false,
      mixedCase: true,
      sentenceFinal: true,
    });
  });

  it("deleting an admin deletes the sessions they were impersonating in", async () => {
    const suffix = randomUUID();
    const impersonator = `impersonator-${suffix}`;
    const remainingAdmin = `admin-${suffix}`;
    const member = `member-${suffix}`;
    await insertUser(impersonator, `${impersonator}@example.test`, "admin");
    await insertUser(remainingAdmin, `${remainingAdmin}@example.test`, "admin");
    await insertUser(member, `${member}@example.test`);
    await api`INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id, impersonated_by)
      VALUES (${`impersonated-${suffix}`}, now() + interval '1 hour', ${`t1-${suffix}`}, now(), now(), ${member}, ${impersonator}),
             (${`own-${suffix}`}, now() + interval '1 hour', ${`t2-${suffix}`}, now(), now(), ${member}, NULL),
             (${`other-admin-${suffix}`}, now() + interval '1 hour', ${`t3-${suffix}`}, now(), now(), ${member}, ${remainingAdmin})`;

    await api`DELETE FROM "user" WHERE id = ${impersonator}`;

    expect(
      (await api`SELECT id FROM session WHERE user_id = ${member} ORDER BY id`).map(
        (row) => row.id,
      ),
    ).toEqual([`other-admin-${suffix}`, `own-${suffix}`]);
  });

  it("runs the account triggers as the deleting role, with a pinned search path", async () => {
    const definitions = await api<
      { name: string; owner: string; definer: boolean; config: string[] }[]
    >`
      SELECT proname AS name, pg_get_userbyid(proowner) AS owner, prosecdef AS definer,
             proconfig AS config
      FROM pg_proc
      WHERE proname IN ('openmapx_erase_user_residue', 'openmapx_preserve_admin_capacity')
      ORDER BY proname`;
    expect(definitions).toEqual(
      ["openmapx_erase_user_residue", "openmapx_preserve_admin_capacity"].map((name) => ({
        name,
        owner: "openmapx_api",
        definer: false,
        config: ["search_path=public, pg_temp"],
      })),
    );
    expect(
      await api`SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.user'::regclass AND NOT tgisinternal ORDER BY tgname`,
    ).toEqual([{ tgname: "openmapx_admin_capacity" }, { tgname: "openmapx_erase_user_residue" }]);
  });

  it("demotes and deletes administrators from a session whose search path lacks public", async () => {
    const suffix = randomUUID();
    const demoted = `restricted-demoted-${suffix}`;
    const deleted = `restricted-deleted-${suffix}`;
    const remaining = `restricted-remaining-${suffix}`;
    for (const id of [demoted, deleted, remaining])
      await insertUser(id, `${id}@example.test`, "admin");
    const activeAdmins = async () =>
      count(api`SELECT active_count AS n FROM public.account_admin_guard WHERE id = 1`);
    const before = await activeAdmins();

    await api.begin(async (tx) => {
      await tx.unsafe("SET LOCAL search_path = pg_catalog, pg_temp");
      await tx`UPDATE public."user" SET role = 'user' WHERE id = ${demoted}`;
      await tx`DELETE FROM public."user" WHERE id = ${deleted}`;
    });

    expect(await activeAdmins()).toBe(before - 2);
    expect(
      await api`SELECT id, role FROM "user" WHERE id IN (${demoted}, ${deleted}, ${remaining})
        ORDER BY id`,
    ).toEqual([
      { id: demoted, role: "user" },
      { id: remaining, role: "admin" },
    ]);
  });
});
