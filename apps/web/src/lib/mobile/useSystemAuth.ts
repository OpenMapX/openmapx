"use client";

import { apiUrl, authClient } from "@openmapx/core";
import { useCallback } from "react";
import { useMobileRuntimeContext } from "./MobileRuntimeProvider";
import { readAuthResult, redeemSystemAuth } from "./systemAuth";

/**
 * Where each authentication operation is allowed to happen.
 *
 * The split is not about what is convenient; it is about what actually works and
 * what a store reviewer will accept.
 *
 * Email, password, email OTP, verification and TOTP stay in the WebView. They
 * are ordinary form posts to our own origin, they work fine embedded, and moving
 * them to the system browser would mean handing the user off for the most common
 * case.
 *
 * OAuth and passkeys do not stay. Providers increasingly refuse embedded user
 * agents outright, and platform authenticators are not available inside a
 * WebView at all — so an embedded attempt is not a degraded experience, it is a
 * broken one. RFC 8252 says the same thing about native apps generally.
 */

export type AuthOperation = "email-password" | "email-otp" | "two-factor" | "oauth" | "passkey";

export type AuthRoute =
  /** Runs here, in the page, as it always has. */
  | "in-page"
  /** Runs in the system browser, with a PKCE-bound handoff back. */
  | "system-browser"
  /**
   * Cannot be carried back by this shell. The user may still sign in on the
   * website, but must sign in again in the app afterwards — and the UI has to
   * say so rather than imply a transfer that will not happen.
   */
  | "external-browser-only"
  /** Not offered at all in this build. */
  | "unavailable";

export type SystemAuthOutcome = "ok" | "cancelled" | "failed" | "unsupported";

export interface SystemAuthRuntime {
  /** Where `operation` should run, given this runtime. */
  routeFor: (operation: AuthOperation) => AuthRoute;
  /**
   * Whether a third-party identity provider may be offered as a *primary* way
   * to create or enter an account.
   *
   * False in the installed iOS build. There, OSM and Mapillary are link/unlink
   * operations on an account the user already has — which is a different thing
   * from signing in with them, and is what the store guidelines actually permit.
   */
  thirdPartyPrimarySignIn: boolean;
  /** Runs one system-browser attempt end to end. */
  runSystemAuth: (
    purpose: "sign-in" | "link-provider" | "add-passkey",
  ) => Promise<SystemAuthOutcome>;
}

/** Operations that need a real browser when this page is inside the shell. */
const NEEDS_SYSTEM_BROWSER: ReadonlySet<AuthOperation> = new Set<AuthOperation>([
  "oauth",
  "passkey",
]);

export function useSystemAuth(): SystemAuthRuntime {
  const runtime = useMobileRuntimeContext();
  const platform = runtime.handshake?.platform ?? null;
  const canSystemAuth = runtime.state === "native-compatible" && runtime.client !== null;

  const routeFor = useCallback(
    (operation: AuthOperation): AuthRoute => {
      if (runtime.browserAuthority) return "in-page";
      if (!NEEDS_SYSTEM_BROWSER.has(operation)) return "in-page";
      // An iOS store build offers no third-party primary sign-in at all, so
      // there is nothing to route.
      if (operation === "oauth" && platform === "ios") return "unavailable";
      if (canSystemAuth) return "system-browser";
      // A v1 shell, or one that never negotiated. It cannot carry a session
      // back, and saying otherwise would be a promise the shell cannot keep.
      return "external-browser-only";
    },
    [runtime.browserAuthority, canSystemAuth, platform],
  );

  const runSystemAuth = useCallback(
    async (purpose: "sign-in" | "link-provider" | "add-passkey"): Promise<SystemAuthOutcome> => {
      const client = runtime.client;
      if (!client || runtime.state !== "native-compatible") return "unsupported";

      let opened: Awaited<ReturnType<typeof client.request>>;
      try {
        opened = await client.request(
          "auth.open",
          { requestId: `auth-${purpose}`, purpose },
          // A person is signing in on the other side of this, which takes as
          // long as it takes.
          { timeoutMs: 120_000 },
        );
      } catch {
        return "unsupported";
      }

      if (opened.type !== "auth.result") return "failed";
      const result = readAuthResult(opened.payload);
      if (!result) return "failed";
      if (result.status !== "ok") return result.status;

      const redeemed = await redeemSystemAuth(
        {
          callbackCode: result.callbackCode,
          state: result.state,
          codeVerifier: result.codeVerifier,
        },
        {
          // From the configured API client rather than a React context: the
          // auth dialog renders in places that have no EnvProvider, and an auth
          // control that throws on mount is worse than one that cannot route.
          apiBaseUrl: new URL(apiUrl("/api")).origin,
          verifyOneTimeToken: async (token) => {
            const { error } = await authClient.oneTimeToken.verify({ token });
            return !error;
          },
          refreshSession: async () => {
            await authClient.getSession();
          },
        },
      );
      return redeemed === "ok" ? "ok" : "failed";
    },
    [runtime.client, runtime.state],
  );

  return {
    routeFor,
    thirdPartyPrimarySignIn: runtime.browserAuthority || platform !== "ios",
    runSystemAuth,
  };
}
