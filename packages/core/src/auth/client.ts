import { passkeyClient } from "@better-auth/passkey/client";
import {
  adminClient,
  emailOTPClient,
  genericOAuthClient,
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
      genericOAuthClient(),
      twoFactorClient(),
      emailOTPClient(),
      adminClient(),
    ],
  });
}

type FullAuthClient = ReturnType<typeof _buildClient>;

let _authClient: FullAuthClient | null = null;

export function initAuth(config: AuthConfig): void {
  _authClient = createAuthClient({
    baseURL: config.baseURL,
    basePath: "/api/auth",
    plugins: [
      (config.passkeyPlugin ?? passkeyClient()) as ReturnType<typeof passkeyClient>,
      genericOAuthClient(),
      twoFactorClient(),
      emailOTPClient(),
      adminClient(),
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
