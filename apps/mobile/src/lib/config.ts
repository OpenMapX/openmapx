import { expoClient } from "@better-auth/expo/client";
import { authClient, configureApiClient, configureStorage, initAuth } from "@openmapx/core";
import { expoPasskeyClient } from "expo-better-auth-passkey";
import * as SecureStore from "expo-secure-store";
import { mmkvStorageAdapter } from "./storage";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3001";

export function initPlatform(): void {
  configureStorage(mmkvStorageAdapter);

  // Auth must be initialised before configureApiClient so that
  // the header interceptor can call authClient.getCookie().
  initAuth({
    baseURL: API_URL,
    passkeyPlugin: expoPasskeyClient(),
    platformPlugins: [
      expoClient({
        scheme: "openmapx",
        storagePrefix: "openmapx",
        storage: SecureStore,
      }),
    ],
  });

  configureApiClient({
    baseUrl: API_URL,
    credentials: "omit",
    headerInterceptor: (): Record<string, string> => {
      try {
        const cookies = (
          authClient as Record<string, unknown> & { getCookie?: () => string }
        ).getCookie?.();
        if (cookies) return { Cookie: cookies };
      } catch {
        // Ignore errors when cookie is not available
      }
      return {};
    },
  });
}
