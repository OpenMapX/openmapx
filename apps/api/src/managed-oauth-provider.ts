import type { OAuthOptions } from "@better-auth/oauth-provider";

const MANAGED_SERVICE_CLIENT_REFERENCE = "openmapx-managed-services";

export const managedOAuthProviderOptions = {
  loginPage: "/auth/oidc/sign-in",
  consentPage: "/auth/oidc/consent",
  scopes: ["openid", "profile", "email"],
  clientRegistrationDefaultScopes: ["openid", "profile", "email"],
  clientReference: ({ user }) =>
    user?.role === "admin" ? MANAGED_SERVICE_CLIENT_REFERENCE : undefined,
  clientPrivileges: async ({ user }) => user?.role === "admin",
} satisfies OAuthOptions;
