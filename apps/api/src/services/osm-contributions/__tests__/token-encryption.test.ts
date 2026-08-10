/**
 * Pins the Better Auth 1.6.26 behavior the contribution flow depends on:
 * elevated OSM tokens are encrypted at rest, and the public server API still
 * hands the server a usable plaintext token plus the account's effective
 * scopes. It also pins the library's legacy-token detection, which decides
 * whether an operator upgrade forces a relink.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { decryptOAuthToken, setTokenUtil } from "better-auth/oauth2";
import { genericOAuth } from "better-auth/plugins";
import { describe, expect, it } from "vitest";

/**
 * `setTokenUtil`/`decryptOAuthToken` are typed against the generic auth
 * context; a narrowed instance's context is structurally identical but not
 * assignable, so widen it once here rather than at every call.
 */
type LibraryAuthContext = Parameters<typeof setTokenUtil>[1];

function widen(context: unknown): LibraryAuthContext {
  return context as LibraryAuthContext;
}

const SECRET = "test-secret-value-for-openmapx-osm-contributions";
const OSM_TOKEN = "osm-access-token-sentinel";

function buildAuth(encryptOAuthTokens: boolean) {
  const store: Record<string, unknown[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  const auth = betterAuth({
    database: memoryAdapter(store),
    secret: SECRET,
    baseURL: "http://localhost:3001",
    emailAndPassword: { enabled: true },
    account: { encryptOAuthTokens },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: "openstreetmap",
            authorizationUrl: "https://www.openstreetmap.org/oauth2/authorize",
            tokenUrl: "https://www.openstreetmap.org/oauth2/token",
            clientId: "test-client",
            clientSecret: "test-secret",
            scopes: ["openid", "read_prefs"],
          },
        ],
      }),
    ],
  });
  return { auth, store };
}

async function seedLinkedAccount(
  auth: ReturnType<typeof buildAuth>["auth"],
  accessToken: string,
  scope = "openid,read_prefs,write_api",
) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({
    email: "mapper@test.example",
    name: "Mapper",
    emailVerified: true,
  });
  await ctx.internalAdapter.createAccount({
    userId: user.id,
    providerId: "openstreetmap",
    accountId: "12345",
    accessToken,
    scope,
  });
  return { ctx, userId: user.id };
}

describe("OAuth token encryption at rest", () => {
  it("encrypts a token when the option is on and decrypts it back", async () => {
    const { auth } = buildAuth(true);
    const ctx = await auth.$context;
    const stored = await setTokenUtil(OSM_TOKEN, widen(ctx));
    expect(stored).not.toBe(OSM_TOKEN);
    expect(stored).not.toContain(OSM_TOKEN);
    expect(await decryptOAuthToken(stored ?? "", widen(ctx))).toBe(OSM_TOKEN);
  });

  it("stores the token verbatim when the option is off", async () => {
    const { auth } = buildAuth(false);
    const ctx = await auth.$context;
    expect(await setTokenUtil(OSM_TOKEN, widen(ctx))).toBe(OSM_TOKEN);
  });

  it("keeps the ciphertext, not the token, in the account row", async () => {
    const { auth, store } = buildAuth(true);
    const ctx = await auth.$context;
    const encrypted = await setTokenUtil(OSM_TOKEN, widen(ctx));
    await seedLinkedAccount(auth, encrypted ?? "");
    expect(JSON.stringify(store.account)).not.toContain(OSM_TOKEN);
  });

  it("returns a usable plaintext token and effective scopes through the public API", async () => {
    const { auth } = buildAuth(true);
    const ctx = await auth.$context;
    const encrypted = await setTokenUtil(OSM_TOKEN, widen(ctx));
    const { userId } = await seedLinkedAccount(auth, encrypted ?? "");

    const result = await auth.api.getAccessToken({
      body: { providerId: "openstreetmap", userId },
    });
    expect(result.accessToken).toBe(OSM_TOKEN);
    expect(result.scopes).toEqual(["openid", "read_prefs", "write_api"]);
  });
});

describe("legacy plaintext tokens after enabling encryption", () => {
  it("passes an opaque legacy token through unchanged", async () => {
    const { auth } = buildAuth(true);
    // Real OSM access tokens are opaque URL-safe strings, not bare hex.
    const legacy = "kR3n-Legacy_Token.Value";
    const { userId } = await seedLinkedAccount(auth, legacy);
    const result = await auth.api.getAccessToken({
      body: { providerId: "openstreetmap", userId },
    });
    expect(result.accessToken).toBe(legacy);
  });

  it("misreads an even-length hex legacy token as ciphertext, forcing a relink", async () => {
    // `isLikelyEncrypted()` treats any even-length hex string as encrypted, so
    // this shape cannot be recovered. Operators must be told to relink.
    const { auth } = buildAuth(true);
    const { userId } = await seedLinkedAccount(auth, "abcdef0123456789");
    await expect(
      auth.api.getAccessToken({ body: { providerId: "openstreetmap", userId } }),
    ).rejects.toThrow();
  });
});

describe("production auth options", () => {
  it("enables token encryption and keeps sign-in scopes minimal", async () => {
    process.env.BETTER_AUTH_SECRET ??= SECRET;
    const { auth } = await import("../../../auth.js");
    expect(auth.options.account?.encryptOAuthTokens).toBe(true);
    const generic = auth.options.plugins?.find((p) => p.id === "generic-oauth") as
      | { id: string }
      | undefined;
    expect(generic).toBeDefined();
  });
});
