import { randomBytes, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { account, user } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("audited account provisioning and assisted recovery", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
    auth: typeof import("../auth")["auth"];
  const mail = vi.fn();
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(48).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("../utils/email", () => ({ sendMail: mail }));
    mail.mockResolvedValue(undefined);
    ({ auth } = await import("../auth"));
  }, 90000);
  afterEach(async () => {
    const { accountMailOutbox } = await import("../db/schema");
    await fixture.db
      .update(accountMailOutbox)
      .set({ state: "failed", ciphertext: null, iv: null, tag: null, finishedAt: new Date() })
      .where(eq(accountMailOutbox.state, "queued"));
    mail.mockClear();
    mail.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    await fixture?.stop();
    vi.doUnmock("../db");
    vi.doUnmock("../utils/email");
    vi.unstubAllEnvs();
  });
  async function actor() {
    const email = `admin-${randomUUID()}@example.test`,
      created = await auth.api.createUser({
        body: {
          name: "Synthetic administrator",
          email,
          password: "synthetic-admin-password",
          role: "admin",
        },
      });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
    const login = await auth.api.signInEmail({
      body: { email, password: "synthetic-admin-password" },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: login.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    });
    const session = await auth.api.getSession({ headers });
    if (!session) throw Error("No actual administrator session");
    return { id: created.user.id, sessionId: session.session.id, headers, email };
  }
  it("rejects direct Better Auth admin password replacement without action-bound reauthentication", async () => {
    const admin = await actor(),
      target = await auth.api.createUser({
        body: {
          name: "Synthetic subject",
          email: `subject-${randomUUID()}@example.test`,
          password: "synthetic-original-password",
        },
      });
    const before = await fixture.db
      .select()
      .from(account)
      .where(eq(account.userId, target.user.id));
    await expect(
      auth.api.setUserPassword({
        headers: admin.headers,
        body: { userId: target.user.id, newPassword: "synthetic-new-password" },
      }),
    ).rejects.toThrow();
    expect(
      await fixture.db.select().from(account).where(eq(account.userId, target.user.id)),
    ).toEqual(before);
  });
  it("queues separate verification/setup messages once and never retains the supplied password", async () => {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox");
    const input = {
      name: "Invited synthetic subject",
      email: `invite-${randomUUID()}@example.test`,
      role: "user" as const,
      password: "synthetic-supplied-password",
      sendInvitation: true,
      idempotencyKey: randomUUID(),
      actor: admin,
    };
    const created = await provisionAccount(input);
    expect(created).toMatchObject({
      created: true,
      verificationDelivery: "queued",
      passwordSetupDelivery: "queued",
    });
    await dispatchAccountMailQueue();
    expect(mail).toHaveBeenCalledTimes(2);
    expect(
      mail.mock.calls.some((call) => String(call[0]?.subject).startsWith("Set your password")),
    ).toBe(true);
    const replay = await provisionAccount(input);
    expect(replay).toMatchObject({
      userId: created.userId,
      verificationDelivery: "sent",
      passwordSetupDelivery: "sent",
    });
    expect(await fixture.db.select().from(user).where(eq(user.email, input.email))).toHaveLength(1);
    expect(mail).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mail.mock.calls)).not.toContain(input.password);
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, created.userId)))[0]?.emailVerified,
    ).toBe(false);
  });
  it("leaves an acceptance-then-disconnect unknown and does not resend on replay", async () => {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox");
    mail.mockRejectedValue(Error("synthetic lost provider response"));
    const input = {
      name: "Unknown mail subject",
      email: `unknown-${randomUUID()}@example.test`,
      role: "user" as const,
      sendInvitation: true,
      idempotencyKey: randomUUID(),
      actor: admin,
    };
    const created = await provisionAccount(input);
    await dispatchAccountMailQueue();
    expect(mail).toHaveBeenCalledTimes(2);
    const replay = await provisionAccount(input);
    expect(replay).toMatchObject({
      userId: created.userId,
      verificationDelivery: "unknown",
      passwordSetupDelivery: "unknown",
    });
    await dispatchAccountMailQueue();
    expect(mail).toHaveBeenCalledTimes(2);
  });
  it("requires setup when no initial password is supplied and distinguishes known refusal", async () => {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox"),
      { MailDeliveryRefusedError } = await import("../utils/mail-outcome");
    mail.mockRejectedValue(new MailDeliveryRefusedError());
    const input = {
      name: "Setup subject",
      email: `setup-${randomUUID()}@example.test`,
      role: "user" as const,
      sendInvitation: false,
      idempotencyKey: randomUUID(),
      actor: admin,
    };
    const result = await provisionAccount(input);
    expect(result).toMatchObject({
      verificationDelivery: "queued",
      passwordSetupDelivery: "queued",
    });
    await dispatchAccountMailQueue();
    expect(await provisionAccount(input)).toMatchObject({
      verificationDelivery: "failed",
      passwordSetupDelivery: "failed",
    });
  });

  async function proofFor(
    admin: Awaited<ReturnType<typeof actor>>,
    purpose: "account.verify" | "account.password.set" | "account.invite",
    targetId: string,
  ) {
    const { AdminActionReauthentication } = await import("./admin-reauthentication"),
      service = new AdminActionReauthentication(fixture.db),
      started = await service.start({
        actorId: admin.id,
        startingSessionId: admin.sessionId,
        purpose,
        targetId,
      });
    const login = await auth.api.signInEmail({
        body: { email: admin.email, password: "synthetic-admin-password" },
        returnHeaders: true,
      }),
      headers = new Headers({
        cookie: login.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; "),
      }),
      fresh = await auth.api.getSession({ headers });
    if (!fresh) throw Error("No fresh session");
    const { getSessionAuthAssurance } = await import("../privacy/session-assurance"),
      assurance = await getSessionAuthAssurance(fresh.session.id, fixture.db);
    if (!assurance) throw Error("No actual login assurance");
    await service.complete({
      challengeId: started.challengeId,
      nonce: started.nonce,
      session: {
        id: fresh.session.id,
        userId: admin.id,
        method: assurance.method,
        authenticatedAt: assurance.authenticatedAt,
        mfaConfigured: false,
      },
    });
    return {
      actor: { ...admin, headers, sessionId: fresh.session.id },
      proof: { challengeId: started.challengeId, nonce: started.nonce },
    };
  }
  it("verifies only the current expected email with a consumed proof, revokes sessions and audits once", async () => {
    const admin = await actor(),
      { provisionAccount, assistedAccountAction } = await import("./account-provisioning"),
      target = await provisionAccount({
        name: "Verification subject",
        email: `verify-${randomUUID()}@example.test`,
        role: "user",
        password: "synthetic-original-password",
        sendInvitation: false,
        idempotencyKey: randomUUID(),
        actor: admin,
      });
    const grant = await proofFor(admin, "account.verify", target.userId),
      key = randomUUID();
    await expect(
      assistedAccountAction({
        ...grant,
        action: "verify",
        userId: target.userId,
        idempotencyKey: key,
        body: {
          confirmed: true,
          reasonCode: "identity_verified_out_of_band",
          expectedEmail: "changed@example.test",
        },
      }),
    ).rejects.toThrow();
    const subject = (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0];
    if (!subject) throw Error("Missing subject");
    const result = await assistedAccountAction({
      ...grant,
      action: "verify",
      userId: target.userId,
      idempotencyKey: key,
      body: {
        confirmed: true,
        reasonCode: "identity_verified_out_of_band",
        expectedEmail: subject.email,
      },
    });
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0]?.emailVerified,
    ).toBe(true);
    expect(
      await assistedAccountAction({
        ...grant,
        action: "verify",
        userId: target.userId,
        idempotencyKey: key,
        body: {
          confirmed: true,
          reasonCode: "identity_verified_out_of_band",
          expectedEmail: subject.email,
        },
      }),
    ).toEqual(result);
    const { adminAuditLog } = await import("../db/schema");
    expect(
      await fixture.db
        .select()
        .from(adminAuditLog)
        .where(
          and(eq(adminAuditLog.action, "user.verify"), eq(adminAuditLog.targetId, target.userId)),
        ),
    ).toHaveLength(1);
  });
  it("rolls back the assisted flag, receipt and consumed proof when the strict audit write fails", async () => {
    const admin = await actor(),
      { provisionAccount, assistedAccountAction } = await import("./account-provisioning"),
      { adminActionReauthentication, accountActionReceipt, adminAuditLog } = await import(
        "../db/schema"
      ),
      target = await provisionAccount({
        name: "Audit rollback subject",
        email: `audit-${randomUUID()}@example.test`,
        role: "user",
        password: "synthetic-original-password",
        sendInvitation: false,
        idempotencyKey: randomUUID(),
        actor: admin,
      }),
      grant = await proofFor(admin, "account.verify", target.userId),
      subject = (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0],
      input = {
        ...grant,
        action: "verify" as const,
        userId: target.userId,
        idempotencyKey: randomUUID(),
        body: {
          confirmed: true,
          reasonCode: "identity_verified_out_of_band",
          expectedEmail: subject!.email,
        },
      };
    await fixture.sql.unsafe(
      "create function reject_assisted_audit() returns trigger language plpgsql as $$begin if NEW.action='user.verify' then raise exception 'synthetic strict audit refusal'; end if; return NEW; end$$",
    );
    await fixture.sql.unsafe(
      "create trigger reject_assisted_audit before insert on admin_audit_log for each row execute function reject_assisted_audit()",
    );
    try {
      await expect(assistedAccountAction(input)).rejects.toThrow();
    } finally {
      await fixture.sql.unsafe("drop trigger reject_assisted_audit on admin_audit_log");
      await fixture.sql.unsafe("drop function reject_assisted_audit()");
    }
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0]?.emailVerified,
    ).toBe(false);
    expect(
      (
        await fixture.db
          .select()
          .from(adminActionReauthentication)
          .where(eq(adminActionReauthentication.id, grant.proof.challengeId))
      )[0]?.consumedAt,
    ).toBeNull();
    expect(
      await fixture.db
        .select()
        .from(accountActionReceipt)
        .where(
          and(
            eq(accountActionReceipt.targetId, target.userId),
            eq(accountActionReceipt.action, "verify"),
          ),
        ),
    ).toHaveLength(0);
    await assistedAccountAction(input);
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0]?.emailVerified,
    ).toBe(true);
    expect(
      await fixture.db
        .select()
        .from(adminAuditLog)
        .where(
          and(eq(adminAuditLog.targetId, target.userId), eq(adminAuditLog.action, "user.verify")),
        ),
    ).toHaveLength(1);
  }, 30000);
  it("sets a password through the exact consumed action while keeping email unverified", async () => {
    const admin = await actor(),
      { provisionAccount, assistedAccountAction } = await import("./account-provisioning"),
      target = await provisionAccount({
        name: "Password subject",
        email: `password-${randomUUID()}@example.test`,
        role: "user",
        password: "synthetic-original-password",
        sendInvitation: false,
        idempotencyKey: randomUUID(),
        actor: admin,
      }),
      grant = await proofFor(admin, "account.password.set", target.userId),
      input = {
        ...grant,
        action: "password" as const,
        userId: target.userId,
        idempotencyKey: randomUUID(),
        body: {
          confirmed: true,
          reasonCode: "account_recovery",
          password: "synthetic-recovered-password",
        },
      };
    await assistedAccountAction(input);
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0]?.emailVerified,
    ).toBe(false);
    const credential = (
        await fixture.db.select().from(account).where(eq(account.userId, target.userId))
      )[0],
      { verifyPassword } = await import("better-auth/crypto");
    expect(
      await verifyPassword({ hash: credential?.password ?? "", password: input.body.password }),
    ).toBe(true);
    await assistedAccountAction(input);
    const { adminAuditLog } = await import("../db/schema");
    expect(
      await fixture.db
        .select()
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.action, "user.password.set"),
            eq(adminAuditLog.targetId, target.userId),
          ),
        ),
    ).toHaveLength(1);
  });

  it("does not send a queued credential link after its recipient email changed", async () => {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox"),
      result = await provisionAccount({
        name: "Changed email subject",
        email: `before-${randomUUID()}@example.test`,
        role: "user",
        sendInvitation: true,
        idempotencyKey: randomUUID(),
        actor: admin,
      });
    await fixture.db
      .update(user)
      .set({ email: `after-${randomUUID()}@example.test` })
      .where(eq(user.id, result.userId));
    mail.mockClear();
    await dispatchAccountMailQueue();
    expect(mail).not.toHaveBeenCalled();
  });

  async function issuedSetup() {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      input = {
        name: "Reset link subject",
        email: `link-${randomUUID()}@example.test`,
        role: "user" as const,
        password: "synthetic-original-password",
        sendInvitation: true,
        idempotencyKey: randomUUID(),
        actor: admin,
      },
      target = await provisionAccount(input),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox");
    mail.mockClear();
    await dispatchAccountMailQueue();
    const message = mail.mock.calls
        .map(
          (call) => call[0] as { subject: string; text: string; disclosure?: { userId: string } },
        )
        .find(
          (value) =>
            value.subject.startsWith("Set your password") &&
            value.disclosure?.userId === target.userId,
        ),
      link = message?.text.match(/https?:\/\/\S+/)?.[0];
    if (!link) throw Error("Missing actual setup link");
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
    if (!token) throw Error("Missing actual issued token");
    return { admin, target, input, token };
  }
  it("revokes actual stale sessions after one-use password reset without verifying email", async () => {
    const { target, input, token } = await issuedSetup();
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, target.userId));
    const signin = await auth.api.signInEmail({
        body: { email: input.email, password: input.password },
        returnHeaders: true,
      }),
      headers = new Headers({
        cookie: signin.headers
          .getSetCookie()
          .map((v) => v.split(";")[0])
          .join("; "),
      });
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "synthetic-reset-password" } }),
    ).resolves.toMatchObject({ status: true });
    expect(await auth.api.getSession({ headers })).toBeNull();
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "synthetic-second-password" } }),
    ).rejects.toThrow();
  }, 30000);
  it("refuses an actually expired setup token without changing the credential", async () => {
    const { target, token } = await issuedSetup(),
      { verification } = await import("../db/schema"),
      before = await fixture.db.select().from(account).where(eq(account.userId, target.userId));
    await fixture.db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.identifier, `reset-password:${token}`));
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "synthetic-expired-reset-password" } }),
    ).rejects.toThrow();
    expect(
      await fixture.db.select().from(account).where(eq(account.userId, target.userId)),
    ).toEqual(before);
  }, 30000);
  it("rolls back token consumption when actual credential publication fails", async () => {
    const { target, token } = await issuedSetup();
    await fixture.sql`create schema account_reset_fixture`;
    await fixture.sql`create table account_reset_fixture.blocked_target(user_id text not null)`;
    await fixture.sql`insert into account_reset_fixture.blocked_target values (${target.userId})`;
    await fixture.sql.unsafe(
      "create function account_reset_fixture.reject_update() returns trigger language plpgsql as $$begin if exists(select 1 from account_reset_fixture.blocked_target where user_id=OLD.user_id) then raise exception 'synthetic password publication refusal'; end if; return NEW; end$$",
    );
    await fixture.sql.unsafe(
      "create trigger account_reset_fixture_refusal before update on account for each row execute function account_reset_fixture.reject_update()",
    );
    try {
      await expect(
        auth.api.resetPassword({ body: { token, newPassword: "synthetic-reset-password" } }),
      ).rejects.toThrow();
    } finally {
      await fixture.sql.unsafe("drop trigger account_reset_fixture_refusal on account");
      await fixture.sql.unsafe("drop schema account_reset_fixture cascade");
    }
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "synthetic-reset-password" } }),
    ).resolves.toMatchObject({ status: true });
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, target.userId)))[0]?.emailVerified,
    ).toBe(false);
  }, 30000);

  it("resends with fresh issued tokens and enforces the actual per-target mail limit", async () => {
    let { admin, target, token } = await issuedSetup();
    const { assistedAccountAction } = await import("./account-provisioning");
    for (let i = 0; i < 2; i++) {
      const grant = await proofFor(admin, "account.invite", target.userId);
      admin = grant.actor;
      await assistedAccountAction({
        ...grant,
        action: "invitation",
        userId: target.userId,
        body: { confirmed: true },
        idempotencyKey: randomUUID(),
      });
    }
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "synthetic-old-token-password" } }),
    ).rejects.toThrow();
    const grant = await proofFor(admin, "account.invite", target.userId);
    await expect(
      assistedAccountAction({
        ...grant,
        action: "invitation",
        userId: target.userId,
        body: { confirmed: true },
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MAIL_RATE_LIMITED" });
    const { AdminActionReauthentication } = await import("./admin-reauthentication");
    await fixture.db.transaction((tx) =>
      new AdminActionReauthentication(fixture.db).check(
        {
          ...grant.proof,
          sessionId: grant.actor.sessionId,
          purpose: "account.invite",
          targetId: target.userId,
        },
        tx,
      ),
    );
  }, 30000);
  it("keeps a completed mail handoff unknown after actual SQL publication failure without sending again", async () => {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox"),
      { accountMailOutbox } = await import("../db/schema"),
      input = {
        name: "Publication gap subject",
        email: `gap-${randomUUID()}@example.test`,
        role: "user" as const,
        sendInvitation: true,
        idempotencyKey: randomUUID(),
        actor: admin,
      },
      target = await provisionAccount(input);
    await fixture.sql.unsafe(
      "create function account_mail_refuse_final() returns trigger language plpgsql as $$begin if NEW.state='sent' and OLD.kind='verification' then raise exception 'synthetic mail outcome publication failure'; end if; return NEW; end$$",
    );
    await fixture.sql.unsafe(
      "create trigger account_mail_refuse_final before update on account_mail_outbox for each row execute function account_mail_refuse_final()",
    );
    try {
      await expect(dispatchAccountMailQueue()).rejects.toThrow();
    } finally {
      await fixture.sql.unsafe("drop trigger account_mail_refuse_final on account_mail_outbox");
      await fixture.sql.unsafe("drop function account_mail_refuse_final()");
    }
    expect(mail).toHaveBeenCalledTimes(1);
    const [row] = await fixture.db
      .select()
      .from(accountMailOutbox)
      .where(
        and(
          eq(accountMailOutbox.userId, target.userId),
          eq(accountMailOutbox.kind, "verification"),
        ),
      );
    expect(row?.state).toBe("sending");
    await fixture.db
      .update(accountMailOutbox)
      .set({ attemptStartedAt: new Date(Date.now() - 61000) })
      .where(
        and(eq(accountMailOutbox.userId, target.userId), eq(accountMailOutbox.state, "sending")),
      );
    await dispatchAccountMailQueue();
    expect(mail).toHaveBeenCalledTimes(2);
    expect(await provisionAccount(input)).toMatchObject({
      verificationDelivery: "unknown",
      passwordSetupDelivery: "sent",
    });
    await dispatchAccountMailQueue();
    expect(mail).toHaveBeenCalledTimes(2);
  }, 30000);
  it("serves real registered account actions through the generated SDK and starts the real queue worker", async () => {
    const admin = await actor(),
      Fastify = (await import("fastify")).default,
      app = Fastify(),
      { createApiClient } = await import("@openmapx/core"),
      sdk = await import("@openmapx/core/api-admin-sdk");
    await app.register((await import("../routes/admin-accounts")).adminAccountsRoute, {
      prefix: "/api",
    });
    const origin = await app.listen({ port: 0, host: "127.0.0.1" }),
      client = createApiClient({ baseUrl: origin, credentials: "include" }),
      key = randomUUID(),
      body = {
        name: "SDK synthetic subject",
        email: `sdk-${randomUUID()}@example.test`,
        role: "user" as const,
        sendInvitation: true,
      };
    let stop: (() => Promise<void>) | undefined;
    try {
      const created = await sdk.createAdminAccount(
        body,
        { "idempotency-key": key },
        { client, headers: { cookie: admin.headers.get("cookie") ?? "" } },
      );
      expect(created.status).toBe(200);
      if (created.status !== 200) throw Error("Actual SDK creation failed");
      const observed = await sdk.getAdminAccountDelivery(created.data.userId, {
        client,
        headers: { cookie: admin.headers.get("cookie") ?? "" },
      });
      expect(observed.status).toBe(200);
      expect(observed.data).toMatchObject({
        latest: {
          action: "create",
          verificationDelivery: "queued",
          passwordSetupDelivery: "queued",
        },
      });
      expect(Object.keys(created.data).sort()).toEqual([
        "created",
        "passwordSetupDelivery",
        "userId",
        "verificationDelivery",
      ]);
      const duplicate = await sdk.createAdminAccount(
        body,
        { "idempotency-key": key },
        { client, headers: { cookie: admin.headers.get("cookie") ?? "" } },
      );
      expect(duplicate.status).toBe(200);
      if (duplicate.status !== 200) throw Error("Duplicate failed");
      expect(duplicate.data.userId).toBe(created.data.userId);
      const grant = await proofFor(admin, "account.verify", created.data.userId),
        verified = await sdk.verifyAdminAccount(
          created.data.userId,
          {
            confirmed: true,
            reasonCode: "identity_verified_out_of_band",
            expectedEmail: body.email,
          },
          {
            "idempotency-key": randomUUID(),
            "x-openmapx-reauth-challenge": grant.proof.challengeId,
          },
          {
            client,
            headers: {
              cookie: `${grant.actor.headers.get("cookie")}; __Host-openmapx-admin-reauth=${grant.proof.nonce.toString("base64url")}`,
            },
          },
        );
      expect(verified.status).toBe(200);
      stop = (await import("./account-mail-outbox")).startAccountMailWorker();
      for (let i = 0; i < 60 && mail.mock.calls.length < 2; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(mail).toHaveBeenCalledTimes(2);
      const delivered = await sdk.getAdminAccountDelivery(created.data.userId, {
        client,
        headers: { cookie: grant.actor.headers.get("cookie") ?? "" },
      });
      expect(delivered.status).toBe(200);
      expect(delivered.data).toMatchObject({
        latest: { action: "create", verificationDelivery: "sent", passwordSetupDelivery: "sent" },
      });
      const anonymous = await sdk.getAdminAccountDelivery(created.data.userId, { client });
      expect(anonymous.status).toBe(401);
    } finally {
      await stop?.();
      await app.close();
    }
  }, 30000);

  it("cascades encrypted mail on target erasure and never recreates a deleted account on replay", async () => {
    const admin = await actor(),
      { provisionAccount, accountDelivery } = await import("./account-provisioning"),
      { accountActionReceipt, accountMailOutbox } = await import("../db/schema"),
      input = {
        name: "Erased subject",
        email: `erased-${randomUUID()}@example.test`,
        role: "user" as const,
        sendInvitation: true,
        idempotencyKey: randomUUID(),
        actor: admin,
      },
      created = await provisionAccount(input);
    expect(
      await fixture.db
        .select()
        .from(accountMailOutbox)
        .where(eq(accountMailOutbox.userId, created.userId)),
    ).toHaveLength(2);
    await fixture.db.delete(user).where(eq(user.id, created.userId));
    expect(
      await fixture.db
        .select()
        .from(accountMailOutbox)
        .where(eq(accountMailOutbox.userId, created.userId)),
    ).toHaveLength(0);
    const { accountActionDigest } = await import("./account-mail-outbox");
    expect(
      (
        await fixture.db
          .select()
          .from(accountActionReceipt)
          .where(
            eq(
              accountActionReceipt.key,
              accountActionDigest(["key", admin.id, input.idempotencyKey]),
            ),
          )
      )[0]?.targetId,
    ).toBeNull();
    await expect(provisionAccount(input)).rejects.toMatchObject({
      code: "ACCOUNT_ACTION_NOT_AVAILABLE",
    });
    await expect(accountDelivery(admin, created.userId)).rejects.toMatchObject({
      code: "ACCOUNT_NOT_FOUND",
    });
    expect(await fixture.db.select().from(user).where(eq(user.email, input.email))).toHaveLength(0);
  });
  it("keeps role changes canonical and makes identical retries stable", async () => {
    const admin = await actor(),
      { provisionAccount, changeProvisionedAccountRole } = await import("./account-provisioning"),
      target = await provisionAccount({
        name: "Role subject",
        email: `role-${randomUUID()}@example.test`,
        role: "user",
        password: "synthetic-password",
        sendInvitation: false,
        idempotencyKey: randomUUID(),
        actor: admin,
      }),
      input = {
        actor: admin,
        userId: target.userId,
        idempotencyKey: randomUUID(),
        body: { role: "privacy_admin", expectedRole: "user" },
      };
    const first = await changeProvisionedAccountRole(input);
    expect(first).toEqual({ userId: target.userId, role: "privacy_admin", changed: true });
    expect(await changeProvisionedAccountRole(input)).toEqual(first);
    await expect(
      changeProvisionedAccountRole({
        ...input,
        body: { role: "admin", expectedRole: "privacy_admin" },
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_ACTION_CONFLICT" });
    const { adminAuditLog } = await import("../db/schema");
    expect(
      await fixture.db
        .select()
        .from(adminAuditLog)
        .where(
          and(
            eq(adminAuditLog.action, "user.role.change"),
            eq(adminAuditLog.targetId, target.userId),
          ),
        ),
    ).toHaveLength(1);
  }, 30000);
  it("enforces the actor quota before creating another user (seeded SQL history)", async () => {
    const admin = await actor(),
      { accountActionReceipt } = await import("../db/schema"),
      { accountActionDigest } = await import("./account-mail-outbox"),
      { provisionAccount } = await import("./account-provisioning");
    const subjects = Array.from({ length: 20 }, () => {
      const id = randomUUID();
      return {
        id,
        name: "Historical fixture subject",
        email: `history-${id}@example.test`,
        emailVerified: true,
        role: "user",
      };
    });
    await fixture.db.insert(user).values(subjects);
    await fixture.db.insert(accountActionReceipt).values(
      subjects.map((subject) => ({
        key: accountActionDigest(["fixture", subject.id]),
        actorId: admin.id,
        targetId: subject.id,
        action: "verification-email" as const,
        intentDigest: accountActionDigest([subject.id]),
        result: { created: false },
        mailRequested: true,
      })),
    );
    const email = `limited-${randomUUID()}@example.test`;
    await expect(
      provisionAccount({
        name: "Over quota subject",
        email,
        role: "user",
        sendInvitation: true,
        idempotencyKey: randomUUID(),
        actor: admin,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_MAIL_RATE_LIMITED" });
    expect(await fixture.db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
  }, 30000);
  it("expires old mail metadata while preserving delivery outcomes in the action receipt", async () => {
    const admin = await actor(),
      { provisionAccount } = await import("./account-provisioning"),
      { dispatchAccountMailQueue } = await import("./account-mail-outbox"),
      { accountMailOutbox } = await import("../db/schema"),
      input = {
        name: "Mail retention subject",
        email: `retention-${randomUUID()}@example.test`,
        role: "user" as const,
        sendInvitation: true,
        idempotencyKey: randomUUID(),
        actor: admin,
      },
      created = await provisionAccount(input);
    await dispatchAccountMailQueue();
    await fixture.db
      .update(accountMailOutbox)
      .set({ createdAt: new Date(Date.now() - 49 * 3600000) })
      .where(eq(accountMailOutbox.userId, created.userId));
    await dispatchAccountMailQueue();
    expect(
      await fixture.db
        .select()
        .from(accountMailOutbox)
        .where(eq(accountMailOutbox.userId, created.userId)),
    ).toHaveLength(0);
    expect(await provisionAccount(input)).toMatchObject({
      verificationDelivery: "sent",
      passwordSetupDelivery: "sent",
    });
  }, 30000);
});
