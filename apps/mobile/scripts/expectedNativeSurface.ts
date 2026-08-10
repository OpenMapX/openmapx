import { readMobileConfig } from "../config/mobileConfig.ts";
import type { ExpectedNativeSurface } from "./generatedNativeChecks.ts";

/**
 * The native surface a given build configuration must produce.
 *
 * Derived from the same validated build config the generation itself used, plus
 * the platform floors this release targets, so the assertion and the generation
 * can never drift apart.
 */
export function expectedNativeSurface(env: NodeJS.ProcessEnv): ExpectedNativeSurface {
  const mobile = readMobileConfig(env);
  return {
    release: mobile.release,
    appId: mobile.appId,
    scheme: mobile.scheme,
    webHost: mobile.webHost,
    usesCleartextOrigin:
      new URL(mobile.webOrigin).protocol === "http:" ||
      new URL(mobile.apiOrigin).protocol === "http:",
    hasAppleTeamId: Boolean(mobile.appleTeamId),
    // Expo SDK 57's floor, and the version the config plugin asserts.
    iosDeploymentTarget: "16.4",
    androidMinSdk: 24,
    // Google Play requires new apps and updates to target API 36 from
    // 31 August 2026; this release targets it now rather than at the deadline.
    androidCompileSdk: 36,
    androidTargetSdk: 36,
  };
}
