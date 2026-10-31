import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, ne, sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  accountAdminGuard,
  adminAuditLog,
  adminJob,
  authPolicyApplication,
  authPolicyState,
  session,
  transitCredentialPreview,
  user,
} from "../db/schema";
import { authRoute } from "../routes/auth";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("atomic last administrator protection", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
    auth: typeof import("../auth")["auth"],
    app: ReturnType<typeof Fastify>,
    anchorId: string;
  let directory = "",
    journal = "";
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    directory = mkdtempSync(join(tmpdir(), "openmapx-account-guard-"));
    journal = join(directory, "erasure.jsonl");
    const keyFile = join(directory, "journal.key"),
      journalKey = randomBytes(32);
    writeFileSync(keyFile, journalKey.toString("base64url"), { mode: 0o444 });
    (await import("@openmapx/core/erasure-journal")).initializeErasureJournal(journal, journalKey);
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(48).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.stubEnv("ERASURE_JOURNAL_KEY_FILE", keyFile);
    vi.stubEnv("ERASURE_JOURNAL_KEY_UID", String(process.getuid?.() ?? 0));
    vi.stubEnv("ERASURE_JOURNAL_PATH", journal);
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("../utils/email", () => ({ sendMail: async () => {} }));
    ({ auth } = await import("../auth"));
    app = Fastify();
    await app.register(authRoute, {
      authHandler: auth.handler,
      authUiOrigin: "http://localhost:3000",
    });
    await app.ready();
    const anchor = await auth.api.createUser({
      body: {
        name: "Fixture anchor",
        email: "anchor-admin@example.test",
        password: "fixture-password-1234",
        role: "admin",
      },
    });
    anchorId = anchor.user.id;
  }, 90000);
  afterEach(async () => {
    if (!fixture || !anchorId) return;
    await fixture.db
      .update(user)
      .set({ role: "admin", banned: false })
      .where(eq(user.id, anchorId));
    await fixture.db.update(user).set({ role: "user", banned: false }).where(ne(user.id, anchorId));
  });
  afterAll(async () => {
    await app?.close();
    await fixture?.stop();
    rmSync(directory, { recursive: true, force: true });
    vi.doUnmock("../db");
    vi.doUnmock("../utils/email");
    vi.unstubAllEnvs();
  });
  async function actor(label: string, role: "admin" | "user" = "admin") {
    const created = await auth.api.createUser({
      body: {
        name: "Synthetic account",
        email: `${label}-${randomUUID()}@example.test`,
        password: "fixture-password-1234",
        role,
      },
    });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
    const signin = await auth.api.signInEmail({
      body: { email: created.user.email, password: "fixture-password-1234" },
      returnHeaders: true,
    });
    return {
      id: created.user.id,
      cookie: signin.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    };
  }
  const headers = (cookie: string) => ({
    host: "localhost:3001",
    origin: "http://localhost:3000",
    cookie,
    "idempotency-key": randomUUID(),
  });
  const active = () =>
    fixture.db
      .select()
      .from(user)
      .where(and(eq(user.role, "admin"), eq(user.banned, false)));

  it("persists a successful creation audit in the same transaction", async () => {
    const rows = await fixture.db
      .select()
      .from(adminAuditLog)
      .where(eq(adminAuditLog.action, "user.create"));
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0]?.details)).not.toContain("anchor-admin@example.test");
  });
  it("permits only one of two concurrent full admins to demote themselves", async () => {
    const a = await actor("a"),
      b = await actor("b");
    await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, anchorId));
    const results = await Promise.all(
      [a, b].map((person) =>
        app.inject({
          method: "POST",
          url: "/api/auth/admin/set-role",
          headers: headers(person.cookie),
          payload: { userId: person.id, role: "user" },
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await active()).toHaveLength(1);
  });
  it("rejects last-admin deletion before any journal request or cleanup", async () => {
    const a = await actor("last");
    await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, anchorId));
    const before = existsSync(journal) ? readFileSync(journal, "utf8") : "";
    const result = await app.inject({
      method: "POST",
      url: "/api/auth/delete-user",
      headers: headers(a.cookie),
      payload: { password: "fixture-password-1234" },
    });
    expect((existsSync(journal) ? readFileSync(journal, "utf8") : "").length).toBe(before.length);
    expect(result.statusCode).toBe(409);
    expect(result.json()).toMatchObject({ code: "LAST_ADMIN_REQUIRED" });
    expect(existsSync(journal) ? readFileSync(journal, "utf8") : "").toBe(before);
    expect(await active()).toHaveLength(1);
  });
  it("backs remote guards with a transactional SQL invariant", async () => {
    await expect(
      fixture.db.update(user).set({ role: "user" }).where(eq(user.id, anchorId)),
    ).rejects.toThrow();
    expect(await active()).toHaveLength(1);
  });
  it.each(["role", "banned", "emailVerified", "twoFactorEnabled", "email"])(
    "rejects generic admin updates of %s",
    async (field) => {
      const admin = await actor("writer"),
        target = await actor("target", "user");
      const value = field === "role" ? "admin" : field === "email" ? "changed@example.test" : true;
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/admin/update-user",
        headers: headers(admin.cookie),
        payload: { userId: target.id, data: { [field]: value } },
      });
      expect(response.statusCode).toBe(400);
    },
  );
  it.each([
    ["ban", "ban"],
    ["delete", "delete"],
    ["role", "ban"],
    ["delete", "role"],
  ] as const)("serializes concurrent %s/%s authority loss", async (first, second) => {
    const a = await actor("cross-a"),
      b = await actor("cross-b");
    await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, anchorId));
    const run = (who: typeof a, target: string, action: "ban" | "delete" | "role") =>
      app.inject({
        method: "POST",
        url: `/api/auth/admin/${action === "ban" ? "ban-user" : action === "delete" ? "remove-user" : "set-role"}`,
        headers: headers(who.cookie),
        payload: { userId: target, ...(action === "role" ? { role: "user" } : {}) },
      });
    const results = await Promise.all([run(a, b.id, first), run(b, a.id, second)]);
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(await active()).toHaveLength(1);
    expect((await fixture.db.select().from(accountAdminGuard))[0]?.activeCount).toBe(1);
  });
  it("rolls back role, sessions, counter and audit together on audit failure", async () => {
    const admin = await actor("audit-admin"),
      target = await actor("audit-target");
    const before = (await fixture.db.select().from(accountAdminGuard))[0]?.activeCount;
    await fixture.db.execute(
      sql`ALTER TABLE admin_audit_log ADD CONSTRAINT synthetic_role_audit_failure CHECK (action <> 'user.role.change') NOT VALID`,
    );
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/admin/set-role",
        headers: headers(admin.cookie),
        payload: { userId: target.id, role: "user" },
      });
      expect(result.statusCode).toBe(500);
      expect((await fixture.db.select().from(user).where(eq(user.id, target.id)))[0]?.role).toBe(
        "admin",
      );
      expect(
        await fixture.db.select().from(session).where(eq(session.userId, target.id)),
      ).not.toHaveLength(0);
      expect((await fixture.db.select().from(accountAdminGuard))[0]?.activeCount).toBe(before);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE admin_audit_log DROP CONSTRAINT synthetic_role_audit_failure`,
      );
    }
  });
  it("rolls back a ban when actual session revocation fails", async () => {
    const admin = await actor("ban-admin"),
      target = await actor("ban-target", "user");
    await fixture.db.execute(
      sql`CREATE FUNCTION synthetic_deny_session_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic session deletion failure'; END $$`,
    );
    await fixture.db.execute(
      sql`CREATE TRIGGER synthetic_session_failure BEFORE DELETE ON session FOR EACH ROW EXECUTE FUNCTION synthetic_deny_session_delete()`,
    );
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/admin/ban-user",
        headers: headers(admin.cookie),
        payload: { userId: target.id },
      });
      expect(result.statusCode).toBe(500);
      expect((await fixture.db.select().from(user).where(eq(user.id, target.id)))[0]?.banned).toBe(
        false,
      );
      expect(
        await fixture.db.select().from(session).where(eq(session.userId, target.id)),
      ).not.toHaveLength(0);
      expect(
        await fixture.db
          .select()
          .from(adminAuditLog)
          .where(and(eq(adminAuditLog.action, "user.ban"), eq(adminAuditLog.targetId, target.id))),
      ).toHaveLength(0);
    } finally {
      await fixture.db.execute(sql`DROP TRIGGER synthetic_session_failure ON session`);
      await fixture.db.execute(sql`DROP FUNCTION synthetic_deny_session_delete()`);
    }
  });
  it("keeps admitted erasure requests but never marks completion after database rollback", async () => {
    const admin = await actor("delete-admin"),
      target = await actor("delete-target", "user");
    const key = (await import("@openmapx/core/erasure-journal")).readErasureJournalKeyFile(
        join(directory, "journal.key"),
        process.getuid?.() ?? 0,
      ),
      read = (await import("@openmapx/core/erasure-journal")).readErasureJournal;
    const before = read(journal, key);
    await fixture.db.execute(
      sql`ALTER TABLE admin_audit_log ADD CONSTRAINT synthetic_delete_audit_failure CHECK (action <> 'user.delete') NOT VALID`,
    );
    try {
      const result = await app.inject({
        method: "POST",
        url: "/api/auth/admin/remove-user",
        headers: headers(admin.cookie),
        payload: { userId: target.id },
      });
      expect(result.statusCode).toBe(500);
      expect(await fixture.db.select().from(user).where(eq(user.id, target.id))).toHaveLength(1);
      const after = read(journal, key);
      expect(after.requests).toHaveLength(before.requests.length + 1);
      expect(after.completedReceiptIds.size).toBe(before.completedReceiptIds.size);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE admin_audit_log DROP CONSTRAINT synthetic_delete_audit_failure`,
      );
    }
  });
  it("de-links account policy attribution when an admitted ordinary account is erased", async () => {
    const admin = await actor("erase-admin"),
      target = await actor("erase-policy");
    const { loadAuthPolicy, applyAuthPolicy } = await import("./auth-policy"),
      before = await loadAuthPolicy();
    await applyAuthPolicy(
      {
        settings: {
          emailVerificationRequired: true,
          twoFaEnabled: true,
          passwordMinLength: 8,
          sessionDurationHours: 168,
        },
        expectedRevision: before.revision,
        confirmed: true,
        idempotencyKey: "synthetic-erasure-policy-0001",
      },
      target.id,
    );
    const [ownedApplication] = await fixture.db
      .select()
      .from(authPolicyApplication)
      .where(eq(authPolicyApplication.actorId, target.id));
    if (!ownedApplication) throw Error("Missing original policy application");
    const { streamOpenMapxRegistrationRecords } = await import("../privacy/openmapx-collectors");
    const records = [];
    for await (const row of streamOpenMapxRegistrationRecords("admin-audit-attribution", {
      userId: target.id,
      cutoffAt: new Date(),
      database: fixture.db,
    }))
      records.push(row);
    expect(records.some((row) => row.data.action === "auth.policy.current-owner")).toBe(true);
    await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, target.id));
    const result = await app.inject({
      method: "POST",
      url: "/api/auth/admin/remove-user",
      headers: headers(admin.cookie),
      payload: { userId: target.id },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect((await fixture.db.select().from(authPolicyState))[0]?.activatedBy).toBeNull();
    expect(
      (
        await fixture.db
          .select()
          .from(authPolicyApplication)
          .where(eq(authPolicyApplication.key, ownedApplication.key))
      )[0]?.actorId,
    ).toBeNull();
  });
  it("shares one role audit and version check across server API and the legacy privacy route", async () => {
    const admin = await actor("role-admin"),
      target = await actor("role-target", "user");
    const requestHeaders = new Headers(headers(admin.cookie));
    requestHeaders.set("x-openmapx-expected-role", "user");
    await auth.api.setRole({ headers: requestHeaders, body: { userId: target.id, role: "admin" } });
    await expect(
      auth.api.setRole({ headers: requestHeaders, body: { userId: target.id, role: "user" } }),
    ).rejects.toMatchObject({ statusCode: 409, body: { code: "ROLE_VERSION_CONFLICT" } });
    const own = await fixture.db
      .select()
      .from(adminAuditLog)
      .where(
        and(eq(adminAuditLog.targetId, target.id), eq(adminAuditLog.action, "user.role.change")),
      );
    expect(own).toHaveLength(1);
    expect(own[0]?.details).toMatchObject({ previousRole: "user", role: "admin" });
    expect(
      await fixture.db.select().from(session).where(eq(session.userId, target.id)),
    ).toHaveLength(0);
    const next = await actor("privacy-target", "user"),
      privacy = Fastify();
    await privacy.register((await import("../routes/privacy-roles")).privacyRolesRoute, {
      prefix: "/api",
      database: fixture.db,
    });
    await privacy.ready();
    try {
      const changed = await privacy.inject({
        method: "POST",
        url: `/api/privacy/admin/roles/${next.id}/grant`,
        headers: headers(admin.cookie),
        payload: {},
      });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(
        await fixture.db
          .select()
          .from(adminAuditLog)
          .where(
            and(eq(adminAuditLog.targetId, next.id), eq(adminAuditLog.action, "user.role.change")),
          ),
      ).toHaveLength(1);
      const denied = await privacy.inject({
        method: "POST",
        url: `/api/privacy/admin/roles/${target.id}/grant`,
        headers: headers(admin.cookie),
        payload: {},
      });
      expect(denied.statusCode).toBe(409);
    } finally {
      await privacy.close();
    }
  });
  it("preserves ordinary self-service deletion and commits its completion only after deletion", async () => {
    const target = await actor("self-service", "user"),
      before = (await fixture.db.select().from(accountAdminGuard))[0]?.activeCount;
    const result = await app.inject({
      method: "POST",
      url: "/api/auth/delete-user",
      headers: headers(target.cookie),
      payload: { password: "fixture-password-1234" },
    });
    expect(result.statusCode, result.body).toBe(200);
    expect(await fixture.db.select().from(user).where(eq(user.id, target.id))).toHaveLength(0);
    expect((await fixture.db.select().from(accountAdminGuard))[0]?.activeCount).toBe(before);
  });
  it("protects the last administrator through the installed deletion callback and its stored token", async () => {
    const target = await actor("callback-admin");
    await fixture.db.update(user).set({ role: "user" }).where(eq(user.id, anchorId));
    const token = randomBytes(24).toString("hex");
    await (await auth.$context).internalAdapter.createVerificationValue({
      identifier: `delete-account-${token}`,
      value: target.id,
      expiresAt: new Date(Date.now() + 3600000),
    });
    const before = readFileSync(journal, "utf8");
    const result = await app.inject({
      method: "GET",
      url: `/api/auth/delete-user/callback?token=${token}`,
      headers: headers(target.cookie),
    });
    expect(result.statusCode, result.body).toBe(409);
    expect(readFileSync(journal, "utf8")).toBe(before);
    expect(await active()).toHaveLength(1);
  });
  it("does not publish erasure completion when its owning outer account transaction rolls back", async () => {
    const admin = await actor("outer-admin"),
      target = await actor("outer-target", "user");
    const { readErasureJournal, readErasureJournalKeyFile } = await import(
        "@openmapx/core/erasure-journal"
      ),
      key = readErasureJournalKeyFile(join(directory, "journal.key"), process.getuid?.() ?? 0),
      before = readErasureJournal(journal, key);
    const { withAccountMutation } = await import("./account-mutations");
    await expect(
      withAccountMutation(
        { actorId: admin.id, targetId: target.id, action: "delete", mutationKey: randomUUID() },
        async () => {
          await auth.api.removeUser({
            headers: new Headers(headers(admin.cookie)),
            body: { userId: target.id },
          });
          throw Error("synthetic outer transaction rollback");
        },
      ),
    ).rejects.toThrow("synthetic outer transaction rollback");
    expect(await fixture.db.select().from(user).where(eq(user.id, target.id))).toHaveLength(1);
    const after = readErasureJournal(journal, key);
    expect(after.requests).toHaveLength(before.requests.length + 1);
    expect(after.completedReceiptIds.size).toBe(before.completedReceiptIds.size);
  });
  it("keeps a running administrator's private credential input until its operation settles", async () => {
    const owner = await actor("pending-credential-owner"),
      deleter = await actor("credential-eraser"),
      jobId = randomUUID(),
      previewId = randomUUID(),
      operationKey = `opk1_${randomUUID().replaceAll("-", "")}`;
    vi.stubEnv("OPENMAPX_SECRETS_KEY", "73".repeat(32));
    const { encrypt } = await import("../services/secrets"),
      encrypted = encrypt("synthetic private proposal");
    await fixture.db.insert(adminJob).values({
      id: jobId,
      type: "configuration.apply",
      status: "running",
      createdBy: owner.id,
      payload: { operationKey },
      result: { _immediateActorId: owner.id },
    });
    await fixture.db.insert(transitCredentialPreview).values({
      id: previewId,
      actorId: owner.id,
      operationKey,
      intentFingerprint: "a".repeat(64),
      ...encrypted,
      expiresAt: new Date(Date.now() + 600000),
    });
    const journalBefore = readFileSync(journal, "utf8"),
      response = await app.inject({
        method: "POST",
        url: "/api/auth/admin/remove-user",
        headers: headers(deleter.cookie),
        payload: { userId: owner.id },
      });
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("ADMIN_OPERATION_IN_PROGRESS");
    expect(readFileSync(journal, "utf8")).toBe(journalBefore);
    expect(await fixture.db.select().from(user).where(eq(user.id, owner.id))).toHaveLength(1);
    expect(
      await fixture.db
        .select()
        .from(transitCredentialPreview)
        .where(eq(transitCredentialPreview.id, previewId)),
    ).toHaveLength(1);
    await fixture.db
      .update(adminJob)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(adminJob.id, jobId));
    const settled = await app.inject({
      method: "POST",
      url: "/api/auth/admin/remove-user",
      headers: headers(deleter.cookie),
      payload: { userId: owner.id },
    });
    expect(settled.statusCode).toBe(200);
    expect(
      await fixture.db
        .select()
        .from(transitCredentialPreview)
        .where(eq(transitCredentialPreview.id, previewId)),
    ).toHaveLength(0);
  }, 30000);
});
