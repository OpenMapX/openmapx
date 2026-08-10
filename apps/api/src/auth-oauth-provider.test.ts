import { readFileSync } from "node:fs";
import { getTableColumns } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const ORIGINAL_SECRET = process.env.BETTER_AUTH_SECRET;

function policyIdentity(id: string, role: string) {
  const createdAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    user: {
      id,
      role,
      name: id,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt,
      updatedAt: createdAt,
    },
    session: {
      id: `session-${id}`,
      userId: id,
      token: `fixture-${id}`,
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date("2026-01-02T00:00:00.000Z"),
    },
  };
}

beforeAll(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "test-secret-at-least-thirty-two-characters");
});

afterAll(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_SECRET !== undefined) process.env.BETTER_AUTH_SECRET = ORIGINAL_SECRET;
});

describe("managed OAuth provider policy", () => {
  it("pins the server and shared client Better Auth families to exact 1.6.25 manifests and lock entries", () => {
    const apiManifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const coreManifest = JSON.parse(
      readFileSync(new URL("../../../packages/core/package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    const packageLock = readFileSync(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8");
    const apiLock = packageLock.split("\n  apps/api:")[1]?.split("\n  apps/web:")[0] ?? "";
    const coreLock = packageLock.split("\n  packages/core:")[1]?.split("\n  packages/")[0] ?? "";
    const apiPackages = [
      "@better-auth/core",
      "@better-auth/expo",
      "@better-auth/i18n",
      "@better-auth/oauth-provider",
      "@better-auth/passkey",
      "better-auth",
    ];
    const corePackages = [
      "@better-auth/core",
      "@better-auth/oauth-provider",
      "@better-auth/passkey",
      "better-auth",
    ];

    for (const packageName of apiPackages) {
      expect(apiManifest.dependencies[packageName]).toBe("1.6.25");
      const lockName = packageName.startsWith("@") ? `'${packageName}'` : packageName;
      expect(apiLock).toContain(`${lockName}:\n        specifier: 1.6.25`);
    }
    for (const packageName of corePackages) {
      expect(coreManifest.dependencies[packageName]).toBe("1.6.25");
      const lockName = packageName.startsWith("@") ? `'${packageName}'` : packageName;
      expect(coreLock).toContain(`${lockName}:\n        specifier: 1.6.25`);
    }
    expect(apiLock.match(/version: 1\.6\.25\(@better-auth\/core@1\.6\.25/g)).toHaveLength(4);
    expect(coreLock.match(/version: 1\.6\.25\(@better-auth\/core@1\.6\.25/g)).toHaveLength(2);
    expect(apiLock).not.toContain("version: 1.6.25(@better-auth/core@1.6.26");
    expect(coreLock).not.toContain("version: 1.6.25(@better-auth/core@1.6.26");
  });

  it("exposes every provider table through the application Drizzle schema", async () => {
    const schema = await import("./db/schema");

    expect(Object.keys(schema)).toEqual(
      expect.arrayContaining([
        "jwks",
        "oauthClient",
        "oauthRefreshToken",
        "oauthAccessToken",
        "oauthConsent",
      ]),
    );
  });

  it("keeps the exact 1.6.25 two-factor lockout columns emitted by the pinned generator", async () => {
    const { twoFactor } = await import("./db/schema");
    const columns = getTableColumns(twoFactor);

    expect(columns.verified).toMatchObject({ hasDefault: true, default: true, notNull: false });
    expect(columns.failedVerificationCount).toMatchObject({
      hasDefault: true,
      default: 0,
      notNull: false,
    });
    expect(columns.lockedUntil).toMatchObject({ hasDefault: false, notNull: false });
    expect(columns).toEqual(
      expect.objectContaining({
        id: expect.anything(),
        secret: expect.anything(),
        userId: expect.anything(),
      }),
    );
  });

  it("uses the fixed OpenMapX OIDC pages and first-party scopes", async () => {
    const { managedOAuthProviderOptions } = await import("./managed-oauth-provider");

    expect(managedOAuthProviderOptions).toMatchObject({
      loginPage: "/auth/oidc/sign-in",
      consentPage: "/auth/oidc/consent",
      scopes: ["openid", "profile", "email"],
      clientRegistrationDefaultScopes: ["openid", "profile", "email"],
    });
  });

  it("does not enable public registration or a trusted-client cache", async () => {
    const { managedOAuthProviderOptions } = await import("./managed-oauth-provider");

    expect(managedOAuthProviderOptions).not.toHaveProperty(
      "allowUnauthenticatedClientRegistration",
    );
    expect(managedOAuthProviderOptions).not.toHaveProperty("allowDynamicClientRegistration");
    expect(managedOAuthProviderOptions).not.toHaveProperty("cachedTrustedClients");
    expect(managedOAuthProviderOptions).not.toHaveProperty("disableJwtPlugin");
    expect(managedOAuthProviderOptions).not.toHaveProperty("storeClientSecret");
  });

  it("assigns the managed-services reference only to authenticated administrators", async () => {
    const { managedOAuthProviderOptions } = await import("./managed-oauth-provider");
    const reference = managedOAuthProviderOptions.clientReference;

    await expect(Promise.resolve(reference(policyIdentity("admin", "admin")))).resolves.toBe(
      "openmapx-managed-services",
    );
    await expect(Promise.resolve(reference(policyIdentity("member", "user")))).resolves.toBe(
      undefined,
    );
    await expect(Promise.resolve(reference({}))).resolves.toBe(undefined);
  });

  it("denies every client action unless the current session is an administrator", async () => {
    const { managedOAuthProviderOptions } = await import("./managed-oauth-provider");
    const privileges = managedOAuthProviderOptions.clientPrivileges;
    const actions = ["create", "read", "update", "delete", "list", "rotate"] as const;

    for (const action of actions) {
      const base = { headers: new Headers(), action };
      await expect(
        privileges({
          ...base,
          ...policyIdentity("admin", "admin"),
        }),
      ).resolves.toBe(true);
      await expect(
        privileges({
          ...base,
          ...policyIdentity("member", "user"),
        }),
      ).resolves.toBe(false);
      await expect(privileges(base)).resolves.toBe(false);
    }
  });

  it("mounts the OAuth provider before the final custom-session projection", async () => {
    const { auth } = await import("./auth");
    const pluginIds = auth.options.plugins?.map((plugin) => plugin.id);

    expect(pluginIds).toContain("oauth-provider");
    expect(pluginIds).toContain("jwt");
    expect(pluginIds?.indexOf("jwt")).toBeLessThan(pluginIds?.indexOf("oauth-provider") ?? -1);
    expect(pluginIds?.at(-1)).toBe("custom-session");
    expect(pluginIds?.indexOf("oauth-provider")).toBeLessThan(
      pluginIds?.indexOf("custom-session") ?? -1,
    );
  });
});
