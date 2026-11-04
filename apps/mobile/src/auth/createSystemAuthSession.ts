import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomValues,
} from "expo-crypto";
import { openAuthSessionAsync } from "expo-web-browser";
import { encodeBase64Url } from "../bridge/base64";
import { SystemAuthSession } from "./SystemAuthSession";

/**
 * The system-browser sign-in, bound to the platform.
 *
 * `openAuthSessionAsync` uses `ASWebAuthenticationSession` on iOS and a Custom
 * Tab on Android, and resolves with the callback URL only when the operating
 * system routed the compiled scheme back to this app. Everything that decides
 * what is accepted stays in `SystemAuthSession`.
 */
export function createSystemAuthSession(config: {
  webOrigin: string;
  scheme: string;
}): SystemAuthSession {
  return new SystemAuthSession(
    {
      config,
      browser: {
        openAuthSessionAsync: async (url, redirectUrl) => {
          const result = await openAuthSessionAsync(url, redirectUrl);
          return result.type === "success" ? result.url : null;
        },
      },
      randomBytes: (length) => encodeBase64Url(getRandomValues(new Uint8Array(length))),
    },
    async (input) =>
      base64ToBase64Url(
        await digestStringAsync(CryptoDigestAlgorithm.SHA256, input, {
          encoding: CryptoEncoding.BASE64,
        }),
      ),
  );
}

/** RFC 7636 S256 sends the digest base64url-encoded without padding. */
export function base64ToBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
