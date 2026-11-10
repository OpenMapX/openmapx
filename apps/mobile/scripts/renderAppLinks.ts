/**
 * Runs the well-known service's renderer, the same script the container runs
 * at start, so checks see exactly the files a deployment would serve.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PublicSigningIdentities } from "./storeLinks.ts";

export const APP_LINKS_SCRIPT = resolve(
  import.meta.dirname,
  "../../../services/well-known/config/app-links.sh",
);

export interface AppLinkSettings {
  MOBILE_APPLE_TEAM_ID?: string;
  MOBILE_IOS_BUNDLE_IDS?: string;
  MOBILE_ANDROID_PACKAGES?: string;
  MOBILE_ANDROID_CERT_SHA256?: string;
}

/** Renders both association files from service settings; throws with the script's message. */
export function renderAppLinks(settings: AppLinkSettings): { apple: string; assetlinks: string } {
  const out = mkdtempSync(join(tmpdir(), "openmapx-app-links-"));
  try {
    execFileSync("sh", [APP_LINKS_SCRIPT], {
      // Only the settings under test, never the caller's own MOBILE_* variables.
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OPENMAPX_APP_LINKS_DIR: out,
        ...settings,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    return {
      apple: readFileSync(join(out, "apple-app-site-association"), "utf8"),
      assetlinks: readFileSync(join(out, "assetlinks.json"), "utf8"),
    };
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new Error(stderr || "the app-links renderer failed");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** A bare 64-hex fingerprint in the colon-separated form assetlinks requires. */
function colonFingerprint(value: string): string {
  return /^[0-9a-f]{64}$/i.test(value) ? (value.match(/../g) ?? []).join(":") : value;
}

/**
 * The settings an operator would enter for the recorded public identities.
 * A platform whose identity has not been issued yet is left unset.
 */
export function settingsForIdentities(
  identities: PublicSigningIdentities,
  issued: { apple: boolean; google: boolean },
): AppLinkSettings {
  return {
    ...(issued.apple && {
      MOBILE_APPLE_TEAM_ID: identities.apple.teamId,
      MOBILE_IOS_BUNDLE_IDS: identities.apple.bundleIdentifier,
    }),
    ...(issued.google && {
      MOBILE_ANDROID_PACKAGES: identities.google.packageName,
      MOBILE_ANDROID_CERT_SHA256: colonFingerprint(identities.google.playAppSigningSha256),
    }),
  };
}
