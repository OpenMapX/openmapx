import {
  CryptoDigestAlgorithm,
  CryptoEncoding,
  digestStringAsync,
  getRandomValues,
} from "expo-crypto";
import { openAuthSessionAsync } from "expo-web-browser";
import { Platform } from "react-native";
import { encodeBase64Url } from "../bridge/base64";
import { SystemAuthSession } from "./SystemAuthSession";
import { supportsVerifiedAuthCallback } from "./verifiedCallbackSupport";

/**
 * The system-browser sign-in, bound to the platform.
 *
 * `openAuthSessionAsync` uses `ASWebAuthenticationSession` on iOS and a Custom
 * Tab on Android. The callback is a verified HTTPS link on the compiled
 * origin: iOS matches it inside the session (`preferUniversalLinks`, which
 * needs the associated domain), and Android receives it as an App Link.
 * Everything that decides what is accepted stays in `SystemAuthSession`.
 */
export function createSystemAuthSession(config: { webOrigin: string }): SystemAuthSession {
  return new SystemAuthSession(
    {
      config,
      browser: {
        openAuthSessionAsync: async (url, redirectUrl) => {
          // Only iOS reads this option; Android passes its options to the Custom Tab.
          const result = await openAuthSessionAsync(
            url,
            redirectUrl,
            Platform.OS === "ios" ? { preferUniversalLinks: true } : {},
          );
          return result.type === "success" ? result.url : null;
        },
      },
      randomBytes: (length) => encodeBase64Url(getRandomValues(new Uint8Array(length))),
      supportsVerifiedCallback: () => supportsVerifiedAuthCallback(Platform.OS, Platform.Version),
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
