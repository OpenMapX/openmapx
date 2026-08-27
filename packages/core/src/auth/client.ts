// Type-only, and deliberately unused at runtime. `oauthProviderClient()`
// contributes these types to the inferred client shape, but they live in an
// internal chunk file that TypeScript cannot name when it writes a declaration
// (TS2883). Importing them from the package root — where they are publicly
// exported — gives the emitter a nameable path for `@openmapx/core` itself.
import type {
  AuthServerMetadata,
  OAuthClient,
  OAuthConsent,
  OAuthOptions,
  OIDCMetadata,
  Scope,
} from "@better-auth/oauth-provider";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";
import {
  adminClient,
  emailOTPClient,
  oneTimeTokenClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

export interface AuthConfig {
  baseURL: string;
  platformPlugins?: unknown[];
  /** Override the default passkeyClient() — e.g. with expoPasskeyClient() on native. */
  passkeyPlugin?: unknown;
}

/** Helper used only for its return type — captures the full plugin-augmented shape. */
function _buildClient(baseURL: string) {
  return createAuthClient({
    baseURL,
    basePath: "/api/auth",
    plugins: [
      passkeyClient(),
      oauthProviderClient(),
      twoFactorClient(),
      emailOTPClient(),
      adminClient(),
      oneTimeTokenClient(),
    ],
  });
}

/**
 * Keeps the type-only import above from being elided, which is what makes the
 * imported names reachable from this module's emitted declaration.
 */
type _OAuthProviderTypeAnchor = [
  AuthServerMetadata,
  OAuthClient,
  OAuthConsent,
  OAuthOptions,
  OIDCMetadata,
  Scope,
];

type FullAuthClient = ReturnType<typeof _buildClient>;

let _authClient: FullAuthClient | null = null;

export function initAuth(config: AuthConfig): void {
  _authClient = createAuthClient({
    baseURL: config.baseURL,
    basePath: "/api/auth",
    plugins: [
      (config.passkeyPlugin ?? passkeyClient()) as ReturnType<typeof passkeyClient>,
      oauthProviderClient(),
      twoFactorClient(),
      emailOTPClient(),
      adminClient(),
      oneTimeTokenClient(),
      ...((config.platformPlugins as []) ?? []),
    ],
  }) as FullAuthClient;
}

function getAuthClient(): FullAuthClient {
  if (!_authClient) {
    initAuth({
      baseURL:
        typeof window !== "undefined"
          ? (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001")
          : "http://127.0.0.1:3001",
    });
  }
  return _authClient as FullAuthClient;
}

export const authClient = new Proxy({} as FullAuthClient, {
  get(_, prop) {
    return (getAuthClient() as Record<string | symbol, unknown>)[prop];
  },
});

export type Session = FullAuthClient["$Infer"]["Session"];
export type User = Session["user"];
