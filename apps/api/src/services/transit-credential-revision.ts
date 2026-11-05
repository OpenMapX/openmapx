/** Randomized encrypted-row identity; never hash the plaintext map. */
import { createHash } from "node:crypto";
import { TRANSIT_CREDENTIALS_ABSENT_REVISION } from "@openmapx/core/ops";
export function transitCredentialRevision(
  row: { id: string; ciphertext: string; iv: string; tag: string } | undefined,
): string {
  if (!row) return TRANSIT_CREDENTIALS_ABSENT_REVISION;
  return createHash("sha256")
    .update(JSON.stringify(["transit-credentials-v1", row.id, row.ciphertext, row.iv, row.tag]))
    .digest("hex");
}
