import { randomBytes, randomUUID } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import * as sdk from "@openmapx/core/api-admin-sdk";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminActionReauthentication, sessionAuthAssurance, twoFactor, user } from "../db/schema";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const dbDescribe = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
dbDescribe("administrator proof through actual auth HTTP and generated SDK", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
    auth: typeof import("../auth")["auth"],
    app: ReturnType<typeof Fastify>,
    client: ReturnType<typeof createApiClient>;
  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    vi.stubEnv("BETTER_AUTH_SECRET", randomBytes(48).toString("base64url"));
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3001");
    vi.doMock("../db", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("../utils/email", () => ({ sendMail: async () => {} }));
    ({ auth } = await import("../auth"));
    app = Fastify();
    await app.register((await import("../routes/auth")).authRoute, {
      authHandler: auth.handler,
      authUiOrigin: "http://localhost:3000",
    });
    await app.register(
      (await import("../routes/admin-reauthentication")).adminReauthenticationRoute,
      { prefix: "/api" },
    );
    const origin = await app.listen({ port: 0, host: "127.0.0.1" });
    client = createApiClient({ baseUrl: origin, credentials: "include" });
  }, 90000);
  afterAll(async () => {
    await app?.close();
    await fixture?.stop();
    vi.doUnmock("../db");
    vi.doUnmock("../utils/email");
    vi.unstubAllEnvs();
  });
  const cookie = (headers: Headers) =>
    headers
      .getSetCookie()
      .map((v) => v.split(";")[0])
      .join("; ");
  async function account() {
    const email = `${randomUUID()}@example.test`,
      created = await auth.api.createUser({
        body: {
          name: "Synthetic admin",
          email,
          password: "synthetic-password-1234",
          role: "admin",
        },
      });
    await fixture.db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
    return created.user;
  }
  async function signin(email: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/sign-in/email",
      headers: { origin: "http://localhost:3000" },
      payload: { email, password: "synthetic-password-1234" },
    });
    expect(response.statusCode).toBe(200);
    const cookies = response.cookies
      .map((v: { name: string; value: string }) => `${v.name}=${v.value}`)
      .join("; ");
    return { cookies, body: response.json() };
  }
  it("keeps nonce HttpOnly, denies the old session and completes only after an actual new login", async () => {
    const actor = await account(),
      old = await signin(actor.email),
      key = randomUUID();
    const started = await sdk.startAdminReauthentication(
      { purpose: "account.verify", targetId: "synthetic-subject", restart: true },
      { "idempotency-key": key },
      { client, headers: { cookie: old.cookies } },
    );
    expect(started.status).toBe(200);
    if (started.status !== 200) throw Error("Start refused");
    const proofCookie = cookie(started.headers);
    expect(started.headers.get("set-cookie")).toMatch(/Secure; HttpOnly; SameSite=Strict/);
    expect(JSON.stringify(started.data)).not.toMatch(/nonce|token/);
    const oldResult = await sdk.completeAdminReauthentication(
      { challengeId: started.data.challengeId },
      { "idempotency-key": randomUUID() },
      { client, headers: { cookie: `${old.cookies}; ${proofCookie}` } },
    );
    expect(oldResult.status).toBe(409);
    const fresh = await signin(actor.email);
    const complete = await sdk.completeAdminReauthentication(
      { challengeId: started.data.challengeId },
      { "idempotency-key": randomUUID() },
      { client, headers: { cookie: `${fresh.cookies}; ${proofCookie}` } },
    );
    expect(complete.status).toBe(200);
    const [row] = await fixture.db
      .select()
      .from(adminActionReauthentication)
      .where(eq(adminActionReauthentication.id, started.data.challengeId));
    expect(row?.state).toBe("completed");
    expect(row?.completedMethod).toBe("password");
    const actualSession = await auth.api.getSession({
      headers: new Headers({ cookie: fresh.cookies }),
    });
    const [assurance] = await fixture.db
      .select()
      .from(sessionAuthAssurance)
      .where(eq(sessionAuthAssurance.sessionId, actualSession!.session.id));
    expect(assurance?.originIndependentPasswordLogin).toBe(true);
  });
  it("records factor-sign-in provenance only from an actual pending login, not enrollment", async () => {
    const actor = await account(),
      old = await signin(actor.email),
      headers = new Headers({ cookie: old.cookies });
    const enrolled = await auth.api.enableTwoFactor({
      headers,
      body: { password: "synthetic-password-1234" },
    });
    const [factor] = await fixture.db
      .select()
      .from(twoFactor)
      .where(eq(twoFactor.userId, actor.id));
    if (!factor || enrolled.method !== "totp") throw Error("Missing actual factor");
    const { symmetricDecrypt } = await import("better-auth/crypto"),
      secret = await symmetricDecrypt({
        key: process.env.BETTER_AUTH_SECRET!,
        data: factor.secret,
      });
    const before = await fixture.db
      .select()
      .from(sessionAuthAssurance)
      .where(eq(sessionAuthAssurance.userId, actor.id));
    await auth.api.verifyTOTP({
      headers,
      body: { code: (await auth.api.generateTOTP({ body: { secret } })).code },
    });
    const after = await fixture.db
      .select()
      .from(sessionAuthAssurance)
      .where(eq(sessionAuthAssurance.userId, actor.id));
    expect(after.filter((a) => !before.some((b) => b.sessionId === a.sessionId))).toHaveLength(1);
    for (const row of after.filter((a) => !before.some((b) => b.sessionId === a.sessionId)))
      expect(row.originIndependentPasswordLogin).toBe(false);
    const pending = await auth.api.signInEmail({
      body: { email: actor.email, password: "synthetic-password-1234" },
      returnHeaders: true,
    });
    expect(pending.response).toMatchObject({ twoFactorRedirect: true });
    const verified = await auth.api.verifyBackupCode({
      body: { code: enrolled.backupCodes[0] ?? "" },
      headers: new Headers({ cookie: cookie(pending.headers) }),
      returnHeaders: true,
    });
    const live = await auth.api.getSession({
      headers: new Headers({ cookie: cookie(verified.headers) }),
    });
    if (!live) throw Error("No actual fresh factor session");
    const [record] = await fixture.db
      .select()
      .from(sessionAuthAssurance)
      .where(eq(sessionAuthAssurance.sessionId, live.session.id));
    expect(record?.method).toBe("password_recovery");
    expect(record?.originIndependentPasswordLogin).toBe(true);
  });
  it("rate-limits by real actor and rejects synthetic loopback administration", async () => {
    const actor = await account(),
      login = await signin(actor.email);
    for (let i = 0; i < 5; i++) {
      const result = await sdk.startAdminReauthentication(
        { purpose: "account.verify", targetId: "synthetic-subject", restart: true },
        { "idempotency-key": randomUUID() },
        { client, headers: { cookie: login.cookies } },
      );
      expect(result.status).toBe(200);
    }
    const limited = await sdk.startAdminReauthentication(
      { purpose: "account.verify", targetId: "synthetic-subject", restart: true },
      { "idempotency-key": randomUUID() },
      { client, headers: { cookie: login.cookies } },
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/);
    const local = await app.inject({
      method: "POST",
      url: "/api/admin/reauth/start",
      headers: { "x-openmapx-local-admin": "", "idempotency-key": randomUUID() },
      payload: { purpose: "account.verify", targetId: "synthetic" },
    });
    expect(local.statusCode).toBe(403);
  });
});
