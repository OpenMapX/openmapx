/** Randomized encrypted-row identity; never hash the plaintext map. */
import { createHash } from "node:crypto";
export function transitCredentialRevision(
  row: { id: string; ciphertext: string; iv: string; tag: string } | undefined,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        row
          ? ["transit-credentials-v1", row.id, row.ciphertext, row.iv, row.tag]
          : ["transit-credentials-v1", "absent"],
      ),
    )
    .digest("hex");
}
