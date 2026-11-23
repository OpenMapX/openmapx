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
import { PrivacyRequestService } from "../../privacy/request-service";
import { deriveOfflinePackagePrincipal } from "../../services/offline-package-principal";
import { saveSystemSettings } from "../../services/settings";
import { userErasureHooks } from "../../services/user-erasure";
import {
  API_MIGRATIONS,
  connectProductionPostgis,
  productionPostgisPasswords,
  startProductionPostgis,
} from "../../test/production-postgis";
import { db } from "../index";
import {
  dataManagerOfflinePackageArtifactReferences,
  dataManagerOfflinePackageJobOwners,
  dataManagerOfflinePackageJobs,
  dataSubjectRequest,
  dataSubjectRequestEvent,
  systemSettings,
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
      SELECT child.relname AS table_name,
             child_column.attname AS column_name,
             fk.confdeltype AS delete_action
      FROM pg_constraint fk
      JOIN pg_class parent ON parent.oid = fk.confrelid
      JOIN pg_class child ON child.oid = fk.conrelid
      JOIN pg_attribute child_column
        ON child_column.attrelid = child.oid
       AND child_column.attnum = fk.conkey[1]
      WHERE fk.contype = 'f'
        AND parent.relname = 'user'
      ORDER BY child.relname, child_column.attname
    `);

    const rows = Array.from(result as Iterable<Record<string, unknown>>).map(
      (row) => `${row.table_name}.${row.column_name}:${row.delete_action}`,
    );
    expect(rows.map((row) => row.split(":")[0]).sort()).toEqual(
      Object.keys(DIRECT_USER_FK_CLASSIFICATIONS).sort(),
    );
    expect(rows).toEqual([
      "account.user_id:c",
      "account_action_receipt.actor_id:n",
      "account_action_receipt.target_id:n",
      "account_mail_outbox.user_id:c",
      "admin_action_reauthentication.actor_id:c",
      "admin_audit_log.actor_id:n",
      "admin_audit_log.target_user_id:n",
      "admin_job.created_by:n",
      "auth_policy_application.actor_id:n",
      "auth_policy_state.activated_by:n",
      "configuration_migration_preview.actor_id:c",
      "data_disclosure_event.user_id:n",
      "data_subject_request.actor_user_id:n",
      "data_subject_request.user_id:n",
      "data_subject_request_event.actor_user_id:n",
      "data_subject_request_notification.recipient_user_id:n",
      "installed_extension.installed_by:n",
      "installed_integration.installed_by:n",
      "integration_application_receipt.actor_id:n",
      "integration_secret.updated_by:n",
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
      "platform_configuration_preview.actor_id:c",
      "saved_list.user_id:c",
      "service_secret.updated_by:n",
      "session.user_id:c",
      "session_auth_assurance.user_id:n",
      "share_link.user_id:c",
      "system_secret.updated_by:n",
      "system_settings.updated_by:n",
      "transit_credential_preview.actor_id:c",
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
        { ...requestBase, state: "completed" },
        { ...requestBase, kind: "portability", state: "in_progress" },
      ])
      .returning({ id: dataSubjectRequest.id });
    const ids = requests.map((request) => request.id);
    try {
      await db.delete(user).where(eq(user.id, userId));

      const after = await db
        .select({
          state: dataSubjectRequest.state,
          accountState: dataSubjectRequest.accountState,
          userId: dataSubjectRequest.userId,
          version: dataSubjectRequest.version,
        })
        .from(dataSubjectRequest)
        .where(inArray(dataSubjectRequest.id, ids));
      expect(after).toEqual(
        expect.arrayContaining([
          { state: "completed", accountState: "deleted", userId: null, version: 2 },
          { state: "in_progress", accountState: "deleted", userId: null, version: 2 },
        ]),
      );
    } finally {
      await db.delete(dataSubjectRequest).where(inArray(dataSubjectRequest.id, ids));
      await db.delete(user).where(eq(user.id, userId));
    }
  });

  it("a loopback admin can save a setting and act on a privacy case", async () => {
    const key = `erasure-loopback-${randomUUID()}`;
    const [request] = await db
      .insert(dataSubjectRequest)
      .values({
        kind: "access",
        channel: "email",
        locatorType: "other_reference",
        receivedAt: new Date(),
        dueAt: new Date(Date.now() + 86_400_000),
      })
      .returning({ id: dataSubjectRequest.id });
    if (!request) throw new Error("The privacy case was not created");
    try {
      await saveSystemSettings([{ key, value: "set over loopback" }], "loopback");
      const service = new PrivacyRequestService();
      await service.verifyIdentity({
        requestId: request.id,
        version: 1,
        reasonCode: "document-checked",
        actorId: "loopback",
        idempotencyKey: `loopback-verify-${randomUUID()}`,
      });
      await service.recordExportFailure(request.id, "export-failed");

      expect(
        await db
          .select({ updatedBy: systemSettings.updatedBy })
          .from(systemSettings)
          .where(eq(systemSettings.key, key)),
      ).toEqual([{ updatedBy: null }]);
      const events = await db
        .select({
          actorKind: dataSubjectRequestEvent.actorKind,
          actorUserId: dataSubjectRequestEvent.actorUserId,
        })
        .from(dataSubjectRequestEvent)
        .where(eq(dataSubjectRequestEvent.requestId, request.id));
      expect(events).toEqual(
        expect.arrayContaining([
          { actorKind: "admin", actorUserId: null },
          { actorKind: "system", actorUserId: null },
        ]),
      );
    } finally {
      await db.delete(dataSubjectRequest).where(eq(dataSubjectRequest.id, request.id));
      await db.delete(systemSettings).where(eq(systemSettings.key, key));
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
    await db.insert(dataManagerOfflinePackageJobs).values({
      id: jobId,
      requestKey: `request-${jobId}`,
      packageId,
      request: {},
      status: "ready-to-download",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(dataManagerOfflinePackageJobOwners).values(
      [principal, otherPrincipal].map((owner) => ({
        jobId,
        principal: owner,
        createdAt: new Date(),
      })),
    );
    await db.insert(dataManagerOfflinePackageArtifactReferences).values(
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
          .select({ principal: dataManagerOfflinePackageJobOwners.principal })
          .from(dataManagerOfflinePackageJobOwners)
          .where(eq(dataManagerOfflinePackageJobOwners.jobId, jobId)),
      ).toEqual([{ principal: otherPrincipal }]);
      expect(
        await db
          .select({ principal: dataManagerOfflinePackageArtifactReferences.principal })
          .from(dataManagerOfflinePackageArtifactReferences)
          .where(eq(dataManagerOfflinePackageArtifactReferences.packageId, packageId)),
      ).toEqual([{ principal: otherPrincipal }]);
    } finally {
      await db
        .delete(dataManagerOfflinePackageArtifactReferences)
        .where(eq(dataManagerOfflinePackageArtifactReferences.packageId, packageId));
      await db
        .delete(dataManagerOfflinePackageJobs)
        .where(eq(dataManagerOfflinePackageJobs.id, jobId));
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
      INSERT INTO data_subject_request (kind, channel, user_id, actor_user_id, state,
        received_at, due_at, identity_method, identity_verified_at)
      VALUES ('access', 'self_service', ${userId}, ${userId}, 'in_progress', now(),
        now() + interval '30 days', 'account_session', now())
      RETURNING id`;
    if (!request) throw new Error("The privacy case was not created");
    await api`INSERT INTO data_subject_request_event (request_id, event_type, actor_kind, actor_user_id)
      VALUES (${request.id}, 'received', 'subject', ${userId})`;
    await api`INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
      VALUES (${`v-value-${suffix}`}, 'reset-password:token', ${userId}, now() + interval '1 hour', now(), now()),
             (${`v-email-${suffix}`}, ${email.toUpperCase()}, 'code', now() + interval '1 hour', now(), now()),
             (${`v-change-${suffix}`}, ${`change-email:${userId}:${email}`}, 'code', now() + interval '1 hour', now(), now()),
             (${`v-kept-${suffix}`}, ${otherEmail}, 'code', now() + interval '1 hour', now(), now())`;
    await api`INSERT INTO system_settings (key, value, updated_by)
      VALUES (${`setting-${suffix}`}, '"value"', ${userId})`;
    await api`INSERT INTO system_secret (key, ciphertext, iv, tag, updated_by)
      VALUES (${`secret-${suffix}`}, 'c', 'i', 't', ${userId})`;
    const [audit] = await api<{ id: string }[]>`
      INSERT INTO admin_audit_log (actor_id, target_id, target_type, target_user_id, action,
        details, ip_address, user_agent)
      VALUES (${userId}, ${userId}, 'user', ${userId}, 'erasure.fixture',
        ${JSON.stringify({ contact: email.toLowerCase() })}::jsonb, '192.0.2.1', 'fixture-agent')
      RETURNING id`;
    const [targetAudit] = await api<{ id: string }[]>`
      INSERT INTO admin_audit_log (actor_id, target_id, target_type, target_user_id, action)
      VALUES (${otherId}, ${userId}, 'user', ${userId}, 'erasure.target') RETURNING id`;
    const [mention] = await api<{ id: string }[]>`
      INSERT INTO admin_audit_log (actor_id, action, details, ip_address)
      VALUES (${otherId}, 'erasure.mention', ${JSON.stringify({ about: userId })}::jsonb, '192.0.2.2')
      RETURNING id`;
    await api`INSERT INTO app_logs (level, source, msg, metadata)
      VALUES ('warn', ${`erased-${suffix}`}, ${`failure for ${email.toUpperCase()}`}, NULL),
             ('warn', ${`erased-${suffix}`}, 'no identifier', ${JSON.stringify({ subject: userId })}::jsonb),
             ('warn', ${`kept-${suffix}`}, ${`failure for ${otherEmail}`}, NULL)`;
    const [job] = await api<{ id: string }[]>`
      INSERT INTO data_manager.jobs (kind, status, triggered_by)
      VALUES ('erasure-fixture', 'ok', ${`api:user:${userId}`}) RETURNING id`;
    const [cronJob] = await api<{ id: string }[]>`
      INSERT INTO data_manager.jobs (kind, status, triggered_by)
      VALUES ('erasure-fixture', 'ok', 'cron:data-manager-cron') RETURNING id`;
    await api`INSERT INTO admin_action_reauthentication (actor_id, starting_session_id, purpose,
        target_id, nonce_digest, expires_at)
      VALUES (${otherId}, 'session', 'account.verify', ${userId}, ${`nonce-a-${suffix}`}, now() + interval '5 minutes'),
             (${otherId}, 'session', 'account.verify', ${otherId}, ${`nonce-b-${suffix}`}, now() + interval '5 minutes')`;

    await api`DELETE FROM "user" WHERE id = ${userId}`;

    expect(
      await api`SELECT state, account_state, user_id, actor_user_id, version
        FROM data_subject_request WHERE id = ${request.id}`,
    ).toEqual([
      {
        state: "in_progress",
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
      (await api`SELECT id FROM verification WHERE id LIKE ${`v-%-${suffix}`} ORDER BY id`).map(
        (row) => row.id,
      ),
    ).toEqual([`v-kept-${suffix}`]);
    expect(
      await api`SELECT updated_by FROM system_settings WHERE key = ${`setting-${suffix}`}`,
    ).toEqual([{ updated_by: null }]);
    expect(
      await api`SELECT updated_by FROM system_secret WHERE key = ${`secret-${suffix}`}`,
    ).toEqual([{ updated_by: null }]);
    expect(
      await api`SELECT actor_id, target_id, target_user_id, details, ip_address, user_agent
        FROM admin_audit_log WHERE id = ${audit?.id ?? ""}`,
    ).toEqual([
      {
        actor_id: null,
        target_id: null,
        target_user_id: null,
        details: null,
        ip_address: null,
        user_agent: null,
      },
    ]);
    expect(
      await api`SELECT actor_id, target_id, target_user_id FROM admin_audit_log
        WHERE id = ${targetAudit?.id ?? ""}`,
    ).toEqual([{ actor_id: otherId, target_id: null, target_user_id: null }]);
    expect(
      await api`SELECT actor_id, details, ip_address FROM admin_audit_log
        WHERE id = ${mention?.id ?? ""}`,
    ).toEqual([{ actor_id: otherId, details: null, ip_address: "192.0.2.2" }]);
    expect(
      await count(
        api`SELECT count(*)::int AS n FROM app_logs WHERE source = ${`erased-${suffix}`}`,
      ),
    ).toBe(0);
    expect(
      await count(api`SELECT count(*)::int AS n FROM app_logs WHERE source = ${`kept-${suffix}`}`),
    ).toBe(1);
    expect(
      await api`SELECT id, triggered_by FROM data_manager.jobs
        WHERE id IN (${job?.id ?? ""}, ${cronJob?.id ?? ""}) ORDER BY triggered_by NULLS FIRST`,
    ).toEqual([
      { id: job?.id, triggered_by: null },
      { id: cronJob?.id, triggered_by: "cron:data-manager-cron" },
    ]);
    expect(
      await api`SELECT target_id FROM admin_action_reauthentication WHERE actor_id = ${otherId}`,
    ).toEqual([{ target_id: otherId }]);
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
      await api`INSERT INTO app_logs (level, source, msg, metadata)
        VALUES ('info', ${tag}, ${`${name}: ${text}`}, NULL)`;
      await api`INSERT INTO admin_audit_log (action, details)
        VALUES (${`${tag}:${name}`}, ${JSON.stringify({ note: text })}::jsonb)`;
    }

    await api`DELETE FROM "user" WHERE id = ${userId}`;

    const remainingLogs = await api<{ msg: string }[]>`
      SELECT msg FROM app_logs WHERE source = ${tag} ORDER BY msg`;
    expect(remainingLogs.map((row) => row.msg.split(":")[0])).toEqual([
      "longerDomain",
      "longerLocalPart",
    ]);
    const audits = await api<{ action: string; scrubbed: boolean }[]>`
      SELECT action, details IS NULL AS scrubbed FROM admin_audit_log
      WHERE action LIKE ${`${tag}:%`} ORDER BY action`;
    expect(
      Object.fromEntries(audits.map((row) => [row.action.split(":")[1], row.scrubbed])),
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

  it("runs the erasure trigger as the deleting role, with a pinned search path", async () => {
    const [definition] = await api<{ owner: string; definer: boolean; config: string[] }[]>`
      SELECT pg_get_userbyid(proowner) AS owner, prosecdef AS definer, proconfig AS config
      FROM pg_proc WHERE proname = 'openmapx_erase_user_residue'`;
    expect(definition).toEqual({
      owner: "openmapx_api",
      definer: false,
      config: ["search_path=public, pg_temp"],
    });
    expect(
      await api`SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.user'::regclass AND NOT tgisinternal ORDER BY tgname`,
    ).toEqual([{ tgname: "openmapx_admin_capacity" }, { tgname: "openmapx_erase_user_residue" }]);
  });
});
