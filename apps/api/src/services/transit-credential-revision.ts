/** Randomized encrypted-row identity: every write draws a new IV, so the
 * ciphertext, IV and tag name that write. Never hash the plaintext map. */
import { createHash } from "node:crypto";
import { TRANSIT_CREDENTIALS_ABSENT_REVISION } from "@openmapx/core/ops";
export function transitCredentialRevision(
  row: { ciphertext: string; iv: string; tag: string } | undefined,
): string {
  if (!row) return TRANSIT_CREDENTIALS_ABSENT_REVISION;
  return createHash("sha256")
    .update(JSON.stringify(["transit-credentials-v1", row.ciphertext, row.iv, row.tag]))
    .digest("hex");
}
