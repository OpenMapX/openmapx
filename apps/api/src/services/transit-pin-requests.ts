/** Request identity only. These values authorize no principal, lease, parent or forward effect. */
import { createHash } from "node:crypto";
import { createControlRootOperationKey, parseControlRootOperationKey } from "@openmapx/core/ops";
export class TransitPinRequestConflict extends Error {}
export function transitPinRequestIdentity(actorId: string, key: unknown) {
  if (typeof key !== "string")
    throw new TransitPinRequestConflict("A single catalog request identity is required");
  let parsed: ReturnType<typeof parseControlRootOperationKey>;
  try {
    parsed = parseControlRootOperationKey(key);
  } catch {
    throw new TransitPinRequestConflict(
      "Refresh catalog review to create a supported request identity",
    );
  }
  const bytes = createHash("sha256")
    .update(`openmapx-admin-catalog-request-v1\0${actorId}\0${key}`)
    .digest();
  const hex = bytes.toString("hex");
  return {
    deadlineAt: parsed.notAfter,
    operationKey: createControlRootOperationKey({
      notAfter: parsed.notAfter,
      nonce: bytes.subarray(0, 16),
    }),
    proposalId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  };
}
