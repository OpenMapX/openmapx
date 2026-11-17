import { createHmac, hkdfSync } from "node:crypto";
import { canonicalJson } from "@openmapx/core/ops";
import { resolveBetterAuthSecret } from "../auth-secret";

/**
 * A digest of a value the API alone stores and compares later. The value can
 * hold secrets, so the digest is keyed with a key derived from the API's own
 * secret for `purpose`.
 */
export function apiKeyedDigest(
  purpose: "immediate-configuration-intent" | "configuration-source",
  value: unknown,
): string {
  const key = Buffer.from(
    hkdfSync("sha256", resolveBetterAuthSecret(), "openmapx-admin-job-v1", purpose, 32),
  );
  return createHmac("sha256", key).update(canonicalJson(value)).digest("hex");
}
