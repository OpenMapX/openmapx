import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { symmetricDecrypt } from "better-auth/crypto";
import { eq } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  account,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  session,
  sessionAuthAssurance,
  twoFactor,
  user,
} from "./db/schema";
import { authRoute } from "./routes/auth";
import { createMigratedPostgresFixture } from "./test/postgres-fixture";

const describeDatabase = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const BASE_URL = "http://localhost:3001";
const REDIRECT_URI = "https://timeline.example.test/users/auth/openmapx/callback";
const PASSWORD = "fixture-password-1234";
const SECRET = randomBytes(48).toString("base64url");

describeDatabase("production authentication on migrated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createMigratedPostgresFixture>>;
  let auth: typeof import("./auth")["auth"];
  let server: FastifyInstance;
  const mail: { to: string; text: string }[] = [];

  beforeAll(async () => {
    fixture = await createMigratedPostgresFixture();
    vi.stubEnv("BETTER_AUTH_URL", BASE_URL);
    vi.stubEnv("BETTER_AUTH_SECRET", SECRET);
    vi.stubEnv("CORS_ORIGIN", "http://localhost:3000");
    vi.stubEnv("OSM_API_URL", "https://osm-fixture.example.test");
    vi.stubEnv("OSM_WEB_URL", "https://osm-fixture.example.test");
    vi.stubEnv(
      "OSM_DISCOVERY_URL",
      "https://osm-fixture.example.test/.well-known/openid-configuration",
    );
    vi.doMock("./db", () => ({ db: fixture.db, sql: fixture.sql }));
    vi.doMock("./utils/email", () => ({
      sendMail: async (message: { to: string; text: string }) => {
        mail.push(message);
      },
    }));
    // No public provider or mail request is needed for these local protocols.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url === "https://osm-fixture.example.test/.well-known/openid-configuration") {
          return Response.json({
            issuer: "https://osm-fixture.example.test",
            authorization_endpoint: "https://osm-fixture.example.test/oauth2/authorize",
            token_endpoint: "https://osm-fixture.example.test/oauth2/token",
          });
        }
        throw new Error("External network forbidden in auth fixture");
      }),
    );
    ({ auth } = await import("./auth"));
    server = Fastify();
    await server.register(authRoute, {
      authHandler: auth.handler,
      authUiOrigin: "http://localhost:3000",
    });
    await server.ready();
  }, 90_000);

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      try {
        await fixture?.stop();
      } finally {
        vi.doUnmock("./db");
        vi.doUnmock("./utils/email");
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
      }
    }
  });

  async function request(path: string, body?: Record<string, unknown>, cookie = "") {
    return server.inject({
      method: body ? "POST" : "GET",
      url: path,
      headers: {
        host: "localhost:3001",
        origin: "http://localhost:3000",
        cookie,
        "user-agent": "auth-postgres-fixture",
      },
      ...(body ? { payload: body } : {}),
    });
  }

  function cookies(response: Awaited<ReturnType<typeof request>>) {
    return response.cookies
      .filter((cookie) => cookie.value)
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  async function sessions(userId: string) {
    return fixture.db.select().from(session).where(eq(session.userId, userId));
  }
  async function assurances(userId: string) {
    return fixture.db
      .select()
      .from(sessionAuthAssurance)
      .where(eq(sessionAuthAssurance.userId, userId));
  }

  async function verifiedUser(email: string) {
    const signup = await request("/api/auth/sign-up/email", {
      email,
      name: "Fixture User",
      password: PASSWORD,
    });
    expect(signup.statusCode, signup.body).toBe(200);
    const userId = signup.json().user.id as string;
    expect(await sessions(userId)).toHaveLength(0);
    expect(await assurances(userId)).toHaveLength(0);
    const rejected = await request("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(rejected.statusCode, rejected.body).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await sessions(userId)).toHaveLength(0);
    expect(await assurances(userId)).toHaveLength(0);
    const verificationMail = mail.find((message) => message.to === email);
    expect(verificationMail).toBeDefined();
    const url = verificationMail?.text.match(
      /http:\/\/localhost:3001\/api\/auth\/verify-email\?\S+/,
    )?.[0];
    if (!url) throw new Error("Missing verification URL in captured production mail");
    const target = new URL(url);
    const verified = await request(`${target.pathname}${target.search}`);
    expect([200, 302], verified.body).toContain(verified.statusCode);
    const signout = await request("/api/auth/sign-out", {}, cookies(verified));
    expect(signout.statusCode, signout.body).toBe(200);
    const signin = await request("/api/auth/sign-in/email", { email, password: PASSWORD });
    expect(signin.statusCode, signin.body).toBe(200);
    return { userId, cookie: cookies(signin) };
  }

  it("requires email verification, stores password assurance and projects the session through the bridge", async () => {
    const email = "password-fixture@example.test";
    const { userId, cookie } = await verifiedUser(email);
    const [storedUser] = await fixture.db.select().from(user).where(eq(user.id, userId));
    expect(storedUser).toMatchObject({ email, emailVerified: true });
    const [credential] = await fixture.db.select().from(account).where(eq(account.userId, userId));
    expect(credential).toMatchObject({ providerId: "credential", accountId: userId });
    expect(credential?.password).toBeTruthy();
    expect(credential?.password).not.toBe(PASSWORD);
    const [storedSession] = await sessions(userId);
    expect(storedSession).toBeDefined();
    expect(await assurances(userId)).toEqual([
      expect.objectContaining({
        sessionId: storedSession?.id,
        userId,
        method: "password",
        authenticatedAt: expect.any(Date),
      }),
    ]);
    const projected = await request("/api/auth/get-session", undefined, cookie);
    expect(projected.statusCode).toBe(200);
    expect(projected.headers["cache-control"]).toContain("no-store");
    expect(projected.json()).toMatchObject({
      user: { id: userId },
      session: { id: storedSession?.id, userId },
    });
    for (const field of ["token", "ipAddress", "userAgent"])
      expect(projected.json().session).not.toHaveProperty(field);
    const rejected = await request("/api/auth/sign-in/email", {
      email,
      password: "wrong-password",
    });
    expect(rejected.statusCode).toBe(401);
    expect(await sessions(userId)).toHaveLength(1);
    expect(await assurances(userId)).toHaveLength(1);
  });

  it("grants TOTP and recovery assurance only after completing real MFA", async () => {
    const email = "mfa-fixture@example.test";
    const { userId, cookie } = await verifiedUser(email);
    const enabled = await request("/api/auth/two-factor/enable", { password: PASSWORD }, cookie);
    expect(enabled.statusCode, enabled.body).toBe(200);
    const backupCode = enabled.json().backupCodes[0] as string;
    const [factor] = await fixture.db.select().from(twoFactor).where(eq(twoFactor.userId, userId));
    if (!factor) throw new Error("MFA did not persist enrollment");
    const secret = await symmetricDecrypt({ key: SECRET, data: factor.secret });
    const code = (await auth.api.generateTOTP({ body: { secret } })).code;
    const enrolled = await request("/api/auth/two-factor/verify-totp", { code }, cookie);
    expect(enrolled.statusCode, enrolled.body).toBe(200);
    const enrollmentCookie = cookies(enrolled) || cookie;
    expect(
      (await fixture.db.select().from(user).where(eq(user.id, userId)))[0]?.twoFactorEnabled,
    ).toBe(true);
    await request("/api/auth/sign-out", {}, enrollmentCookie);

    for (const method of ["totp", "backup-code"] as const) {
      const signin = await request("/api/auth/sign-in/email", { email, password: PASSWORD });
      expect(signin.statusCode, signin.body).toBe(200);
      expect(signin.json()).toMatchObject({ twoFactorRedirect: true });
      expect(await sessions(userId)).toHaveLength(0);
      expect(await assurances(userId)).toHaveLength(0);
      const challengeCookie = cookies(signin);
      const invalid = await request(
        `/api/auth/two-factor/verify-${method}`,
        { code: "invalid-code" },
        challengeCookie,
      );
      expect(invalid.statusCode).toBeGreaterThanOrEqual(400);
      expect(await sessions(userId)).toHaveLength(0);
      expect(await assurances(userId)).toHaveLength(0);
      const valid = await request(
        `/api/auth/two-factor/verify-${method}`,
        {
          code:
            method === "totp"
              ? (await auth.api.generateTOTP({ body: { secret } })).code
              : backupCode,
        },
        challengeCookie,
      );
      expect(valid.statusCode, valid.body).toBe(200);
      const [completed] = await sessions(userId);
      expect(completed).toBeDefined();
      expect(await assurances(userId)).toEqual([
        expect.objectContaining({
          sessionId: completed?.id,
          userId,
          method: method === "totp" ? "password_totp" : "password_recovery",
        }),
      ]);
      await request("/api/auth/sign-out", {}, cookies(valid));
    }
  });
  it("persists managed OIDC consent and signed PKCE tokens while rejecting invalid and reused codes", async () => {
    const email = "oidc-fixture@example.test";
    const { userId, cookie } = await verifiedUser(email);
    // Administrator provisioning is a fixture input; client creation and all
    // subsequent protocol state still go through the production endpoints.
    await fixture.db.update(user).set({ role: "admin" }).where(eq(user.id, userId));
    const client = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie }),
      body: {
        client_name: "Disposable managed service",
        redirect_uris: [REDIRECT_URI],
        scope: "openid profile email",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        require_pkce: true,
        skip_consent: false,
      },
    });
    const clientSecret = client.client_secret;
    if (!clientSecret) throw new Error("Missing one-time managed client secret");
    const [storedClient] = await fixture.db
      .select()
      .from(oauthClient)
      .where(eq(oauthClient.clientId, client.client_id));
    expect(storedClient).toMatchObject({
      userId: null,
      referenceId: "openmapx-managed-services",
      requirePKCE: true,
      skipConsent: false,
    });
    expect(storedClient?.clientSecret).toBe(
      createHash("sha256").update(clientSecret).digest("base64url"),
    );
    const [activeSession] = await sessions(userId);
    const verifier = randomBytes(48).toString("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email",
      state: "fixture-state",
      nonce: "fixture-nonce",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    });
    const authorization = await request(`/api/auth/oauth2/authorize?${query}`, undefined, cookie);
    expect(authorization.statusCode, authorization.body).toBe(302);
    const consentPage = new URL(String(authorization.headers.location), BASE_URL);
    expect(consentPage.pathname).toBe("/auth/oidc/consent");
    expect(consentPage.searchParams.get("sig")).toBeTruthy();
    const consent = await request(
      "/api/auth/oauth2/consent",
      { accept: true, oauth_query: consentPage.searchParams.toString() },
      cookie,
    );
    expect(consent.statusCode, consent.body).toBe(200);
    const callback = new URL(consent.json().url);
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("fixture-state");
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();
    const [storedConsent] = await fixture.db
      .select()
      .from(oauthConsent)
      .where(eq(oauthConsent.clientId, client.client_id));
    expect(storedConsent).toMatchObject({ userId, scopes: ["openid", "profile", "email"] });

    const exchange = async (authorizationCode: string, codeVerifier: string) =>
      server.inject({
        method: "POST",
        url: "/api/auth/oauth2/token",
        headers: {
          host: "localhost:3001",
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${client.client_id}:${clientSecret}`).toString("base64")}`,
        },
        payload: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: REDIRECT_URI,
          code_verifier: codeVerifier,
        }).toString(),
      });
    const wrongVerifier = await exchange(code ?? "", `${verifier}-wrong`);
    expect(wrongVerifier.statusCode, wrongVerifier.body).toBe(401);
    expect(wrongVerifier.json()).toMatchObject({ error: "invalid_request" });
    expect(
      await fixture.db
        .select()
        .from(oauthAccessToken)
        .where(eq(oauthAccessToken.clientId, client.client_id)),
    ).toHaveLength(0);

    // A failed verifier consumes its authorization code in the installed
    // provider; obtain another authorization after the real consent is saved.
    const authorized = await request(`/api/auth/oauth2/authorize?${query}`, undefined, cookie);
    expect(authorized.statusCode, authorized.body).toBe(302);
    const validCode = new URL(String(authorized.headers.location)).searchParams.get("code");
    if (!validCode) throw new Error("Missing authorization code after consent");
    const token = await exchange(validCode, verifier);
    expect(token.statusCode, token.body).toBe(200);
    expect(token.headers["cache-control"]).toContain("no-store");
    const tokens = token.json() as { access_token: string; id_token: string };
    const [persistedToken] = await fixture.db
      .select()
      .from(oauthAccessToken)
      .where(eq(oauthAccessToken.clientId, client.client_id));
    expect(persistedToken).toMatchObject({
      userId,
      sessionId: activeSession?.id,
      scopes: ["openid", "profile", "email"],
    });
    expect(persistedToken?.token).toBe(
      createHash("sha256").update(tokens.access_token).digest("base64url"),
    );
    const keys = await request("/api/auth/jwks");
    expect(keys.statusCode, keys.body).toBe(200);
    const [encodedHeader, encodedClaims, encodedSignature] = tokens.id_token.split(".");
    if (!encodedHeader || !encodedClaims || !encodedSignature)
      throw new Error("Missing signed ID token");
    const header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString());
    expect(header.alg).toBe("EdDSA");
    const key = keys.json().keys.find((candidate: { kid: string }) => candidate.kid === header.kid);
    expect(key).toBeDefined();
    const publicKey = createPublicKey({ key, format: "jwk" });
    const signature = Buffer.from(encodedSignature, "base64url");
    expect(
      verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}`), publicKey, signature),
    ).toBe(true);
    expect(
      verify(null, Buffer.from(`${encodedHeader}.${encodedClaims}tampered`), publicKey, signature),
    ).toBe(false);
    const claims = JSON.parse(Buffer.from(encodedClaims, "base64url").toString());
    expect(claims).toMatchObject({
      iss: `${BASE_URL}/api/auth`,
      aud: client.client_id,
      sub: userId,
      nonce: "fixture-nonce",
    });
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    const userInfo = await server.inject({
      method: "GET",
      url: "/api/auth/oauth2/userinfo",
      headers: { host: "localhost:3001", authorization: `Bearer ${tokens.access_token}` },
    });
    expect(userInfo.statusCode, userInfo.body).toBe(200);
    expect(userInfo.json()).toMatchObject({
      sub: userId,
      email,
      email_verified: true,
      name: "Fixture User",
    });
    const reused = await exchange(validCode, verifier);
    expect(reused.statusCode, reused.body).toBeGreaterThanOrEqual(400);
    expect(reused.json()).toHaveProperty("error");
    const unknown = await exchange("invalid-authorization-code", verifier);
    expect(unknown.statusCode, unknown.body).toBeGreaterThanOrEqual(400);
    expect(unknown.json()).toHaveProperty("error");
  });
});
