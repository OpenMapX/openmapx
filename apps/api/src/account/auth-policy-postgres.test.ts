import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  account,
  authPolicyApplication,
  authPolicyState,
  session,
  systemSettings,
  user,
} from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("account policy through installed Better Auth", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
    auth: typeof import("../auth")["auth"];
  const mail: Array<{ to: string; text: string }> = [];
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(48).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("../utils/email", () => ({
      sendMail: async (message: { to: string; text: string }) => {
        mail.push(message);
      },
    }));
    await fixture.db.insert(systemSettings).values([
      { key: "emailVerificationRequired", value: false },
      { key: "twoFaEnabled", value: false },
      { key: "passwordMinLength", value: 40 },
    ]);
    ({ auth } = await import("../auth"));
  }, 90000);
  afterAll(async () => {
    await fixture?.stop();
    vi.doUnmock("../db");
    vi.doUnmock("../utils/email");
    vi.unstubAllEnvs();
  });
  it("rejects admin-created short passwords before either user or account persistence", async () => {
    const email = "short-policy@example.test";
    await expect(
      auth.api.createUser({ body: { name: "Synthetic", email, password: "short7!" } }),
    ).rejects.toThrow();
    expect(await fixture.db.select().from(user).where(eq(user.email, email))).toHaveLength(0);
    expect(await fixture.db.select().from(account)).toHaveLength(0);
  });
  it("forces admin-created accounts to remain unverified despite nested input", async () => {
    const created = await auth.api.createUser({
      body: {
        name: "Synthetic",
        email: "forced-policy@example.test",
        password: "long-enough-for-secure-default",
        data: { emailVerified: true },
      },
    });
    expect(created.user.emailVerified).toBe(false);
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, created.user.id)))[0]?.emailVerified,
    ).toBe(false);
  });
  it("serializes the policy and enforces actual account-session authorization", async () => {
    const Fastify = (await import("fastify")).default;
    const { adminAccountsRoute } = await import("../routes/admin-accounts");
    const app = Fastify();
    await app.register(adminAccountsRoute, { prefix: "/api" });
    await app.ready();
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      expect(
        (await app.inject({ method: "GET", url: "/api/admin/accounts/policy" })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/admin/accounts/policy",
            headers: { "x-openmapx-local-admin": "" },
          })
        ).statusCode,
      ).toBe(403);
      const actor = await auth.api.createUser({
        body: {
          name: "Policy reader",
          email: "policy-reader@example.test",
          password: "reader-password",
          role: "admin",
        },
      });
      await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, actor.user.id));
      const signin = await auth.api.signInEmail({
        body: { email: actor.user.email, password: "reader-password" },
        returnHeaders: true,
      });
      const cookie = signin.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; ");
      const result = await app.inject({
        method: "GET",
        url: "/api/admin/accounts/policy",
        headers: { cookie },
      });
      expect(result.statusCode, result.body).toBe(200);
      const { getAdminAuthPolicy } = await import("@openmapx/core/api-admin-sdk");
      const { createApiClient } = await import("@openmapx/core");
      const generated = await getAdminAuthPolicy({
        client: createApiClient({ baseUrl: address }),
        headers: { cookie },
      });
      expect(generated).toMatchObject({
        status: 200,
        data: { active: { activationVersion: 0 }, pending: { passwordMinLength: 40 } },
      });

      expect(result.json()).toMatchObject({
        active: { activationVersion: 0, emailVerificationRequired: true },
        pending: { passwordMinLength: 40 },
        ownership: { twoFaEnabled: "default" },
      });
      await fixture.db
        .update(user)
        .set({ role: "privacy_admin" })
        .where(eq(user.id, actor.user.id));
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/api/admin/accounts/policy",
            headers: { cookie },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
  it("pins one operation snapshot, explicitly activates atomically, and expires only newly issued sessions", async () => {
    const { loadAuthPolicy, authPolicyView, applyAuthPolicy } = await import("./auth-policy");
    const { withAuthOperation } = await import("../auth");
    const initial = await loadAuthPolicy();
    expect(initial).toMatchObject({
      activationVersion: 0,
      emailVerificationRequired: true,
      twoFaEnabled: true,
      passwordMinLength: 8,
      sessionDurationHours: 168,
    });
    expect((await authPolicyView()).pending.passwordMinLength).toBe(40);
    const admin = await auth.api.createUser({
      body: {
        name: "Synthetic admin",
        email: "policy-admin@example.test",
        password: "original-password",
        role: "admin",
      },
    });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, admin.user.id));
    const adminSignin = await auth.api.signInEmail({
      body: { email: admin.user.email, password: "original-password" },
      returnHeaders: true,
    });
    const cookie = adminSignin.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const enrolled = await auth.api.enableTwoFactor({
      headers: new Headers({ cookie }),
      body: { password: "original-password" },
    });
    const factor = (await fixture.db.select().from((await import("../db/schema")).twoFactor))[0];
    if (!factor) throw Error("No actual TOTP factor");
    const { symmetricDecrypt } = await import("better-auth/crypto");
    const totpSecret = await symmetricDecrypt({
      key: process.env.BETTER_AUTH_SECRET!,
      data: factor.secret,
    });
    await auth.api.verifyTOTP({
      headers: new Headers({ cookie }),
      body: { code: (await auth.api.generateTOTP({ body: { secret: totpSecret } })).code },
    });
    if (enrolled.method !== "totp") throw Error("Unexpected enrollment method");
    expect(enrolled.backupCodes.length).toBeGreaterThan(0);
    const subject = await auth.api.createUser({
      body: {
        name: "Unverified",
        email: "pending-policy@example.test",
        password: "original-password",
      },
    });
    let captured!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => {
        captured = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const old = withAuthOperation(async () => {
      captured();
      await gate;
      return auth.api.signInEmail({
        body: { email: subject.user.email, password: "original-password" },
      });
    });
    // Attach rejection observation before releasing the operation.
    const oldResult = old.then(
      () => "unexpected success",
      () => "verification required",
    );
    await entered;
    const settings = {
      emailVerificationRequired: false,
      sessionDurationHours: 1,
      twoFaEnabled: false,
      passwordMinLength: 12,
    };
    const request = {
      settings,
      expectedRevision: initial.revision,
      confirmed: true,
      idempotencyKey: "policy-activation-synthetic-0001",
    };
    const applied = await applyAuthPolicy(request, admin.user.id);
    release();
    expect(await oldResult).toBe("verification required");
    expect(await applyAuthPolicy(request, admin.user.id)).toEqual(applied);
    await expect(
      applyAuthPolicy(
        {
          ...request,
          settings: { ...settings, passwordMinLength: 7 },
          idempotencyKey: "policy-invalid-synthetic-0001",
        },
        admin.user.id,
      ),
    ).rejects.toThrow();
    expect(await loadAuthPolicy()).toEqual(applied);
    const issuedAt = Date.now();
    const signin = await auth.api.signInEmail({
      body: { email: subject.user.email, password: "original-password" },
      returnHeaders: true,
    });
    const issuedBefore = Date.now();
    expect(signin.response.user.id).toBe(subject.user.id);
    const challenge = await auth.api.signInEmail({
      body: { email: admin.user.email, password: "original-password" },
      returnHeaders: true,
    });
    expect(challenge.response).toMatchObject({ twoFactorRedirect: true });
    const challengeCookie = challenge.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await expect(
      auth.api.verifyBackupCode({
        headers: new Headers({ cookie: challengeCookie }),
        body: { code: enrolled.backupCodes[0] ?? "" },
      }),
    ).resolves.toHaveProperty("user");
    const ordinarySignin = await auth.api.signInEmail({
      body: { email: subject.user.email, password: "original-password" },
      returnHeaders: true,
    });
    const ordinaryCookie = ordinarySignin.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    await expect(
      auth.api.enableTwoFactor({
        headers: new Headers({
          cookie: signin.headers
            .getSetCookie()
            .map((v) => v.split(";")[0])
            .join("; "),
        }),
        body: { password: "original-password" },
      }),
    ).rejects.toThrow();
    const stored = (
      await fixture.db.select().from(session).where(eq(session.userId, subject.user.id))
    ).find((row) => row.token === signin.response.token);
    if (!stored) throw Error("Missing actual session");
    expect(stored.expiresAt.getTime()).toBeGreaterThanOrEqual(issuedAt + 3600000);
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(issuedBefore + 3600000);
    expect(signin.headers.getSetCookie().some((v) => /Max-Age=3600/i.test(v))).toBe(true);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 1800000);
      expect(
        await auth.api.getSession({ headers: new Headers({ cookie: ordinaryCookie }) }),
      ).not.toBeNull();
      expect(
        (await fixture.db.select().from(session).where(eq(session.id, stored.id)))[0]?.expiresAt,
      ).toEqual(stored.expiresAt);
    } finally {
      vi.useRealTimers();
    }
    await expect(
      auth.api.createUser({
        body: { name: "Short now", email: "short-active@example.test", password: "eleven-1234" },
      }),
    ).rejects.toThrow();
    const response = await auth.handler(
      new Request("http://localhost:3001/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Short HTTP",
          email: "http-short@example.test",
          password: "short",
        }),
      }),
    );
    expect(response.status).toBe(400);
    await applyAuthPolicy(
      {
        ...request,
        settings: { ...settings, sessionDurationHours: 8 },
        expectedRevision: applied.revision,
        idempotencyKey: "policy-activation-synthetic-0002",
      },
      admin.user.id,
    );
    expect(
      (await fixture.db.select().from(session).where(eq(session.id, stored.id)))[0]?.expiresAt,
    ).toEqual(stored.expiresAt);
  });
  it.each([false, true])(
    "email OTP reset preserves verification=%s through the installed endpoint",
    async (verified) => {
      const created = await auth.api.createUser({
        body: {
          name: "OTP reset",
          email: `reset-${verified}@example.test`,
          password: "original-password",
        },
      });
      if (verified)
        await fixture.db
          .update(user)
          .set({ emailVerified: true })
          .where(eq(user.id, created.user.id));
      const otp = await auth.api.createVerificationOTP({
        body: { email: created.user.email, type: "forget-password" },
      });
      await expect(
        auth.api.resetPasswordEmailOTP({
          body: { email: created.user.email, otp, password: "replacement-password" },
        }),
      ).resolves.toMatchObject({ success: true });
      expect(
        (await fixture.db.select().from(user).where(eq(user.id, created.user.id)))[0]
          ?.emailVerified,
      ).toBe(verified);
      await expect(
        auth.api.resetPasswordEmailOTP({
          body: { email: created.user.email, otp, password: "different-password" },
        }),
      ).rejects.toThrow();
    },
  );
  it("rolls back the entire activation when transactional audit persistence fails", async () => {
    const { loadAuthPolicy, applyAuthPolicy } = await import("./auth-policy");
    const [admin] = await fixture.db
      .select()
      .from(user)
      .where(eq(user.email, "policy-admin@example.test"));
    if (!admin) throw Error("Missing admin fixture");
    const before = await loadAuthPolicy(),
      rows = await fixture.db.select().from(authPolicyState),
      drafts = await fixture.db.select().from(systemSettings);
    await fixture.db.execute(
      sql`ALTER TABLE admin_audit_log ADD CONSTRAINT synthetic_policy_audit_failure CHECK (action <> 'auth.policy.apply') NOT VALID`,
    );
    try {
      await expect(
        applyAuthPolicy(
          {
            settings: {
              emailVerificationRequired: before.emailVerificationRequired,
              sessionDurationHours: before.sessionDurationHours,
              twoFaEnabled: before.twoFaEnabled,
              passwordMinLength: 24,
            },
            expectedRevision: before.revision,
            confirmed: true,
            idempotencyKey: "rollback-policy-synthetic-0001",
          },
          admin.id,
        ),
      ).rejects.toThrow();
      expect(await loadAuthPolicy()).toEqual(before);
      expect(await fixture.db.select().from(authPolicyState)).toEqual(rows);
      expect(await fixture.db.select().from(systemSettings)).toEqual(drafts);
      expect(
        await fixture.db
          .select()
          .from(authPolicyApplication)
          .where(eq(authPolicyApplication.key, "rollback-policy-synthetic-0001")),
      ).toHaveLength(0);
    } finally {
      await fixture.db.execute(
        sql`ALTER TABLE admin_audit_log DROP CONSTRAINT synthetic_policy_audit_failure`,
      );
    }
  });
  it("does not consume a reset OTP when the password transaction rolls back", async () => {
    const created = await auth.api.createUser({
      body: {
        name: "OTP transaction",
        email: "otp-transaction@example.test",
        password: "original-password",
      },
    });
    const otp = await auth.api.createVerificationOTP({
      body: { email: created.user.email, type: "forget-password" },
    });
    await fixture.db.execute(
      sql`ALTER TABLE account ADD CONSTRAINT synthetic_password_failure CHECK (provider_id <> 'credential') NOT VALID`,
    );
    try {
      await expect(
        auth.api.resetPasswordEmailOTP({
          body: { email: created.user.email, otp, password: "replacement-password" },
        }),
      ).rejects.toThrow();
    } finally {
      await fixture.db.execute(sql`ALTER TABLE account DROP CONSTRAINT synthetic_password_failure`);
    }
    await expect(
      auth.api.resetPasswordEmailOTP({
        body: { email: created.user.email, otp, password: "replacement-password" },
      }),
    ).resolves.toMatchObject({ success: true });
  });

  it("retains reset attempt lockout across rejected HTTP and server calls", async () => {
    const created = await auth.api.createUser({
      body: { name: "OTP budget", email: "otp-budget@example.test", password: "original-password" },
    });
    const otp = await auth.api.createVerificationOTP({
        body: { email: created.user.email, type: "forget-password" },
      }),
      wrong = otp === "000000" ? "999999" : "000000";
    const request = () =>
      new Request("http://localhost:3001/api/auth/email-otp/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: created.user.email,
          otp: wrong,
          password: "replacement-password",
        }),
      });
    expect((await auth.handler(request())).status).toBe(400);
    for (let i = 0; i < 2; i++)
      await expect(
        auth.api.resetPasswordEmailOTP({
          body: { email: created.user.email, otp: wrong, password: "replacement-password" },
        }),
      ).rejects.toMatchObject({ body: { code: "INVALID_OTP" } });
    await expect(
      auth.api.resetPasswordEmailOTP({
        body: { email: created.user.email, otp, password: "replacement-password" },
      }),
    ).rejects.toMatchObject({ body: { code: "TOO_MANY_ATTEMPTS" } });
  });

  it("enforces active password bounds on every installed password-writing endpoint", async () => {
    const person = await auth.api.createUser({
      body: {
        name: "Password bounds",
        email: "bounds-policy@example.test",
        password: "original-password",
        role: "admin",
      },
    });
    const signin = await auth.api.signInEmail({
      body: { email: person.user.email, password: "original-password" },
      returnHeaders: true,
    });
    const headers = new Headers({
      cookie: signin.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    });
    const [before] = await fixture.db
      .select()
      .from(account)
      .where(eq(account.userId, person.user.id));
    await auth.api.requestPasswordReset({ body: { email: person.user.email } });
    const token = mail
      .find((v) => v.to === person.user.email)
      ?.text.match(/\/reset-password\/([^?\s]+)/)?.[1];
    if (!token) throw Error("Missing synthetic reset mail token");
    for (const password of ["eleven-1234", "x".repeat(129)]) {
      await expect(
        auth.api.createUser({
          body: { name: "Invalid", email: "invalid-bound@example.test", password },
        }),
      ).rejects.toThrow();
      await expect(
        auth.api.signUpEmail({
          body: { name: "Invalid", email: "invalid-signup@example.test", password },
        }),
      ).rejects.toThrow();
      await expect(
        auth.api.changePassword({
          headers,
          body: { currentPassword: "original-password", newPassword: password },
        }),
      ).rejects.toThrow();
      await expect(
        auth.api.setUserPassword({
          headers,
          body: { userId: person.user.id, newPassword: password },
        }),
      ).rejects.toThrow();
      await expect(
        auth.api.resetPassword({ body: { token, newPassword: password } }),
      ).rejects.toThrow();
      const otp = await auth.api.createVerificationOTP({
        body: { email: person.user.email, type: "forget-password" },
      });
      await expect(
        auth.api.resetPasswordEmailOTP({ body: { email: person.user.email, otp, password } }),
      ).rejects.toThrow();
    }
    expect(
      (await fixture.db.select().from(account).where(eq(account.userId, person.user.id)))[0]
        ?.password,
    ).toBe(before?.password);
    await expect(
      auth.api.resetPassword({ body: { token, newPassword: "valid-replacement-password" } }),
    ).resolves.toMatchObject({ status: true });
    const passwordless = await auth.api.createUser({
      body: { name: "Passwordless", email: "passwordless-policy@example.test" },
    });
    const otp = await auth.api.createVerificationOTP({
      body: { email: passwordless.user.email, type: "sign-in" },
    });
    const otpSession = await auth.api.signInEmailOTP({
      body: { email: passwordless.user.email, otp },
      returnHeaders: true,
    });
    const passwordlessHeaders = new Headers({
      cookie: otpSession.headers
        .getSetCookie()
        .map((v) => v.split(";")[0])
        .join("; "),
    });
    await expect(
      auth.api.setPassword({ headers: passwordlessHeaders, body: { newPassword: "short" } }),
    ).rejects.toThrow();
    await expect(
      auth.api.setPassword({
        headers: passwordlessHeaders,
        body: { newPassword: "x".repeat(129) },
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.setPassword({
        headers: passwordlessHeaders,
        body: { newPassword: "valid-new-password" },
      }),
    ).resolves.toMatchObject({ status: true });
  });
  it("does not overwrite concurrent genuine verification during an OTP reset", async () => {
    const created = await auth.api.createUser({
      body: {
        name: "Verification race",
        email: "verify-race@example.test",
        password: "original-password",
      },
    });
    const reset = await auth.api.createVerificationOTP({
        body: { email: created.user.email, type: "forget-password" },
      }),
      verification = await auth.api.createVerificationOTP({
        body: { email: created.user.email, type: "email-verification" },
      });
    await Promise.all([
      auth.api.resetPasswordEmailOTP({
        body: { email: created.user.email, otp: reset, password: "replacement-password" },
      }),
      auth.api.verifyEmailOTP({ body: { email: created.user.email, otp: verification } }),
    ]);
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, created.user.id)))[0]?.emailVerified,
    ).toBe(true);
  });

  it("discloses active host ownership and fails closed on malformed active environment policy", async () => {
    const { loadAuthPolicy, authPolicyView } = await import("./auth-policy"),
      original = process.env.AUTH_EMAIL_VERIFICATION;
    try {
      vi.stubEnv("AUTH_EMAIL_VERIFICATION", "true");
      expect((await authPolicyView()).ownership.emailVerificationRequired).toBe("env");
      expect((await loadAuthPolicy()).emailVerificationRequired).toBe(true);
      vi.stubEnv("AUTH_EMAIL_VERIFICATION", "not-a-boolean");
      await expect(loadAuthPolicy()).rejects.toMatchObject({ code: "AUTH_POLICY_INVALID" });
      const response = await auth.handler(
        new Request("http://localhost:3001/api/auth/get-session"),
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "AUTH_POLICY_INVALID" });
    } finally {
      vi.stubEnv("AUTH_EMAIL_VERIFICATION", original);
    }
  });
  it("activates and replays the exact policy through the generated SDK and real admin HTTP guard", async () => {
    const { loadAuthPolicy } = await import("./auth-policy"),
      before = await loadAuthPolicy();
    const actor = await auth.api.createUser({
      body: {
        name: "HTTP activation",
        email: "http-activation@example.test",
        password: "original-password",
        role: "admin",
      },
    });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, actor.user.id));
    const signin = await auth.api.signInEmail({
      body: { email: actor.user.email, password: "original-password" },
      returnHeaders: true,
    });
    const cookie = signin.headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
    const app = (await import("fastify")).default();
    await app.register((await import("../routes/admin-accounts")).adminAccountsRoute, {
      prefix: "/api",
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { applyAdminAuthPolicy } = await import("@openmapx/core/api-admin-sdk"),
        { createApiClient } = await import("@openmapx/core");
      const options = { client: createApiClient({ baseUrl: address }), headers: { cookie } },
        input = {
          settings: {
            emailVerificationRequired: before.emailVerificationRequired,
            twoFaEnabled: before.twoFaEnabled,
            passwordMinLength: before.passwordMinLength,
            sessionDurationHours: 9,
          },
          expectedRevision: before.revision,
          confirmed: true as const,
          idempotencyKey: "policy-http-activation-synthetic-0001",
        };
      const response = await applyAdminAuthPolicy(input, options);
      expect(response).toMatchObject({
        status: 200,
        data: {
          activationVersion: 1,
          appliesTo: "new_auth_operations",
          active: { sessionDurationHours: 9 },
        },
      });
      expect(await applyAdminAuthPolicy(input, options)).toMatchObject({ status: 429 });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + 11000);
        expect(await applyAdminAuthPolicy(input, options)).toMatchObject({
          status: 200,
          data: response.data,
        });
      } finally {
        vi.useRealTimers();
      }
      expect((await loadAuthPolicy()).sessionDurationHours).toBe(9);
    } finally {
      await app.close();
    }
  });

  it("does not refresh a previously issued session after its original daily refresh threshold", async () => {
    const { loadAuthPolicy, applyAuthPolicy } = await import("./auth-policy");
    const actor = await auth.api.createUser({
      body: {
        name: "Absolute expiry",
        email: "absolute-expiry@example.test",
        password: "original-password",
        role: "admin",
      },
    });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, actor.user.id));
    const before = await loadAuthPolicy(),
      settings = {
        emailVerificationRequired: before.emailVerificationRequired,
        twoFaEnabled: before.twoFaEnabled,
        passwordMinLength: before.passwordMinLength,
        sessionDurationHours: 168,
      };
    const long = await applyAuthPolicy(
      {
        settings,
        expectedRevision: before.revision,
        confirmed: true,
        idempotencyKey: "absolute-long-policy-0001",
      },
      actor.user.id,
    );
    const signin = await auth.api.signInEmail({
      body: { email: actor.user.email, password: "original-password" },
      returnHeaders: true,
    });
    const stored = (
      await fixture.db.select().from(session).where(eq(session.userId, actor.user.id))
    ).find((v) => v.token === signin.response.token);
    if (!stored) throw Error("No original session");
    await applyAuthPolicy(
      {
        settings: { ...settings, sessionDurationHours: 1 },
        expectedRevision: long.revision,
        confirmed: true,
        idempotencyKey: "absolute-short-policy-0001",
      },
      actor.user.id,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 30 * 3600000);
      const value = await auth.api.getSession({
        headers: new Headers({
          cookie: signin.headers
            .getSetCookie()
            .map((v) => v.split(";")[0])
            .join("; "),
        }),
      });
      expect(value).not.toBeNull();
      expect(
        (await fixture.db.select().from(session).where(eq(session.id, stored.id)))[0]?.expiresAt,
      ).toEqual(stored.expiresAt);
    } finally {
      vi.useRealTimers();
    }
  });
});
