import { createHash } from "node:crypto";
import { oauthProvider } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, jwt } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import { managedOAuthProviderOptions } from "./managed-oauth-provider";

const BASE_URL = "http://localhost:3001";
const REDIRECT_URI = "https://timeline.example.test/users/auth/openmapx/callback";
const PASSWORD = "fixture-password-1234";

type MemoryRow = Record<string, unknown>;

function buildTestAuth() {
  const database: Record<string, MemoryRow[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    jwks: [],
    oauthClient: [],
    oauthAccessToken: [],
    oauthRefreshToken: [],
    oauthConsent: [],
  };
  const auth = betterAuth({
    database: memoryAdapter(database),
    baseURL: BASE_URL,
    secret: "oauth-provider-flow-test-secret-at-least-thirty-two-characters",
    emailAndPassword: { enabled: true, autoSignIn: true },
    plugins: [admin(), jwt(), oauthProvider(managedOAuthProviderOptions)],
  });
  return { auth, database };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";", 1)[0])
    .join("; ");
}

async function signUp(auth: ReturnType<typeof buildTestAuth>["auth"], email: string, name: string) {
  const response = await auth.api.signUpEmail({
    body: { email, name, password: PASSWORD },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const payload = (await response.clone().json()) as { user: { id: string } };
  return { cookie: cookieHeader(response), userId: payload.user.id };
}

function headersWithCookie(cookie: string) {
  return new Headers({ cookie });
}

function makePkce(label: string) {
  const verifier = `${label}-${"v".repeat(48)}`;
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function authorize(
  auth: ReturnType<typeof buildTestAuth>["auth"],
  input: {
    clientId: string;
    cookie: string;
    scope: string;
    state: string;
    challenge: string;
  },
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: REDIRECT_URI,
    scope: input.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie: input.cookie },
      redirect: "manual",
    }),
  );
}

async function exchangeCode(
  auth: ReturnType<typeof buildTestAuth>["auth"],
  input: { clientId: string; clientSecret: string; code: string; verifier: string },
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: REDIRECT_URI,
    code_verifier: input.verifier,
  });
  const credentials = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString("base64");
  return auth.handler(
    new Request(`${BASE_URL}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${credentials}`,
      },
      body,
    }),
  );
}

describe("OpenMapX OAuth provider protocol", () => {
  it("restricts every client-management action to administrators and hashes secrets at rest", async () => {
    const { auth, database } = buildTestAuth();
    const administrator = await signUp(auth, "admin@example.test", "Admin User");
    const member = await signUp(auth, "member@example.test", "Member User");
    const adminRow = database.user.find((row) => row.id === administrator.userId);
    expect(adminRow).toBeDefined();
    if (adminRow) adminRow.role = "admin";

    const memberCreate = await auth.api.adminCreateOAuthClient({
      headers: headersWithCookie(member.cookie),
      body: { redirect_uris: [REDIRECT_URI], client_name: "Forbidden client" },
      asResponse: true,
    });
    expect(memberCreate.status).toBe(401);

    const created = await auth.api.adminCreateOAuthClient({
      headers: headersWithCookie(administrator.cookie),
      body: {
        redirect_uris: [REDIRECT_URI],
        client_name: "Throwaway protocol client",
        client_uri: "https://timeline.example.test",
        scope: "openid profile email",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        require_pkce: true,
        skip_consent: true,
      },
    });
    const plaintextSecret = created.client_secret;
    expect(plaintextSecret).toEqual(expect.any(String));
    if (!plaintextSecret) throw new Error("Provider did not return the one-time client secret");
    const storedClient = database.oauthClient.find(
      (row) => row.clientId === created.client_id || row.client_id === created.client_id,
    );
    expect(storedClient).toBeDefined();
    const storedSecret = storedClient?.clientSecret ?? storedClient?.client_secret;
    expect(storedSecret).toEqual(expect.any(String));
    expect((storedSecret as string).length).toBeGreaterThan(0);
    expect(storedSecret).not.toBe(plaintextSecret);
    expect(storedSecret).toBe(createHash("sha256").update(plaintextSecret).digest("base64url"));
    expect(storedClient?.referenceId ?? storedClient?.reference_id).toBe(
      "openmapx-managed-services",
    );

    const memberHeaders = headersWithCookie(member.cookie);
    const deniedResponses = await Promise.all([
      auth.api.getOAuthClient({
        headers: memberHeaders,
        query: { client_id: created.client_id },
        asResponse: true,
      }),
      auth.api.getOAuthClients({ headers: memberHeaders, asResponse: true }),
      auth.api.adminUpdateOAuthClient({
        headers: memberHeaders,
        body: { client_id: created.client_id, update: { client_name: "Forbidden" } },
        asResponse: true,
      }),
      auth.api.rotateClientSecret({
        headers: memberHeaders,
        body: { client_id: created.client_id },
        asResponse: true,
      }),
      auth.api.deleteOAuthClient({
        headers: memberHeaders,
        body: { client_id: created.client_id },
        asResponse: true,
      }),
    ]);
    expect(deniedResponses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);

    const adminHeaders = headersWithCookie(administrator.cookie);
    await expect(auth.api.getOAuthClients({ headers: adminHeaders })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ client_id: created.client_id })]),
    );
    await expect(
      auth.api.adminUpdateOAuthClient({
        headers: adminHeaders,
        body: { client_id: created.client_id, update: { client_name: "Updated client" } },
      }),
    ).resolves.toMatchObject({ client_name: "Updated client" });
    const rotated = await auth.api.rotateClientSecret({
      headers: adminHeaders,
      body: { client_id: created.client_id },
    });
    expect(rotated.client_secret).toBeTruthy();
    expect(rotated.client_secret).not.toBe(plaintextSecret);
    await expect(
      auth.api.deleteOAuthClient({
        headers: adminHeaders,
        body: { client_id: created.client_id },
      }),
    ).resolves.toBeUndefined();
    expect(database.oauthClient).toHaveLength(0);
  });

  it("completes authorization-code + PKCE S256 and scopes stable OIDC claims", async () => {
    const { auth, database } = buildTestAuth();
    const administrator = await signUp(auth, "oidc-admin@example.test", "Ada Admin");
    const adminRow = database.user.find((row) => row.id === administrator.userId);
    if (adminRow) {
      adminRow.role = "admin";
      adminRow.image = "https://profiles.example.test/ada.jpg";
      adminRow.emailVerified = true;
    }
    const client = await auth.api.adminCreateOAuthClient({
      headers: headersWithCookie(administrator.cookie),
      body: {
        redirect_uris: [REDIRECT_URI],
        client_name: "Throwaway PKCE client",
        scope: "openid profile email",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        require_pkce: true,
        skip_consent: true,
      },
    });
    const clientSecret = client.client_secret;
    expect(clientSecret).toEqual(expect.any(String));
    if (!clientSecret) throw new Error("Provider did not return the one-time client secret");

    const rejectedPkce = makePkce("rejected-pkce");
    const rejectedAuthorization = await authorize(auth, {
      clientId: client.client_id,
      cookie: administrator.cookie,
      scope: "openid",
      state: "rejected-pkce",
      challenge: rejectedPkce.challenge,
    });
    const rejectedCallback = new URL(rejectedAuthorization.headers.get("location") ?? "");
    const rejectedCode = rejectedCallback.searchParams.get("code");
    expect(rejectedCode).toBeTruthy();
    const wrongVerifier = await exchangeCode(auth, {
      clientId: client.client_id,
      clientSecret,
      code: rejectedCode ?? "",
      verifier: `${rejectedPkce.verifier}-wrong`,
    });
    expect(wrongVerifier.status).toBe(401);
    await expect(wrongVerifier.json()).resolves.toMatchObject({ error: "invalid_request" });

    const runFlow = async (scope: string, state: string) => {
      const pkce = makePkce(state);
      const authorization = await authorize(auth, {
        clientId: client.client_id,
        cookie: administrator.cookie,
        scope,
        state,
        challenge: pkce.challenge,
      });
      expect(authorization.status).toBe(302);
      const callback = new URL(authorization.headers.get("location") ?? "");
      expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
      expect(callback.searchParams.get("state")).toBe(state);
      expect(callback.searchParams.get("iss")).toBe(`${BASE_URL}/api/auth`);
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();

      const token = await exchangeCode(auth, {
        clientId: client.client_id,
        clientSecret,
        code: code ?? "",
        verifier: pkce.verifier,
      });
      expect(token.status).toBe(200);
      const tokens = (await token.json()) as { access_token: string; id_token: string };
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.id_token).toBeTruthy();
      const userInfo = await auth.handler(
        new Request(`${BASE_URL}/api/auth/oauth2/userinfo`, {
          headers: { authorization: `Bearer ${tokens.access_token}` },
        }),
      );
      expect(userInfo.status).toBe(200);
      return (await userInfo.json()) as Record<string, unknown>;
    };

    const fullClaims = await runFlow("openid profile email", "full-claims");
    expect(fullClaims).toMatchObject({
      sub: administrator.userId,
      name: "Ada Admin",
      email: "oidc-admin@example.test",
      email_verified: true,
      picture: "https://profiles.example.test/ada.jpg",
    });
    const minimalClaims = await runFlow("openid", "minimal-claims");
    expect(minimalClaims).toEqual({ sub: administrator.userId });

    await auth.api.deleteOAuthClient({
      headers: headersWithCookie(administrator.cookie),
      body: { client_id: client.client_id },
    });
    expect(database.oauthClient).toHaveLength(0);
  });

  it("auto-continues once after email sign-in only with the provider-signed OAuth query", async () => {
    const { auth, database } = buildTestAuth();
    const administrator = await signUp(auth, "setup-admin@example.test", "Setup Admin");
    const adminRow = database.user.find((row) => row.id === administrator.userId);
    if (adminRow) adminRow.role = "admin";
    const client = await auth.api.adminCreateOAuthClient({
      headers: headersWithCookie(administrator.cookie),
      body: {
        redirect_uris: [REDIRECT_URI],
        client_name: "Throwaway continuation client",
        scope: "openid profile email",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
        require_pkce: true,
        skip_consent: true,
      },
    });
    await signUp(auth, "traveler@example.test", "Timeline Traveler");
    const pkce = makePkce("continuation");
    const unsignedAuthorization = await authorize(auth, {
      clientId: client.client_id,
      cookie: "",
      scope: "openid profile email",
      state: "continue-once",
      challenge: pkce.challenge,
    });
    expect(unsignedAuthorization.status).toBe(302);
    const loginPage = new URL(unsignedAuthorization.headers.get("location") ?? "", BASE_URL);
    expect(loginPage.pathname).toBe("/auth/oidc/sign-in");
    expect(loginPage.searchParams.get("sig")).toBeTruthy();

    const signIn = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", accept: "text/html" },
        body: JSON.stringify({
          email: "traveler@example.test",
          password: PASSWORD,
          oauth_query: loginPage.searchParams.toString(),
        }),
      }),
    );
    expect(signIn.status).toBe(302);
    const callback = new URL(signIn.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("continue-once");
    expect(callback.searchParams.get("code")).toBeTruthy();

    const rejected = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "traveler@example.test",
          password: PASSWORD,
          oauth_query: `redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&${loginPage.searchParams}`,
        }),
      }),
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).not.toContain("evil.example");

    await auth.api.deleteOAuthClient({
      headers: headersWithCookie(administrator.cookie),
      body: { client_id: client.client_id },
    });
    expect(database.oauthClient).toHaveLength(0);
  });
});
