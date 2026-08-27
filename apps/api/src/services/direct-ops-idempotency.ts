import { createDurableOpsKey } from "./ops-client";

export const DIRECT_OPS_IDEMPOTENCY_HEADER = "idempotency-key";
const DIRECT_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export function parseDirectOpsIdempotency(value: unknown): string {
  if (typeof value !== "string" || !DIRECT_IDEMPOTENCY.test(value)) {
    throw new Error("Idempotency-Key must be a single 16-128 character caller-retained identifier");
  }
  return value;
}

/**
 * The effect and canonical payload are deliberately not part of this key.
 * The agent binds them to the key's stored fingerprint, so reusing one direct
 * intent for a different route/effect/payload produces a conflict rather than
 * silently creating a second destructive operation. Admin identity separates
 * equal caller values belonging to different users.
 */
export function createDirectAdminOpsKey(adminUserId: string, idempotencyValue: string): string {
  return createDurableOpsKey(
    "admin-route.direct-intent",
    `${adminUserId}\0${parseDirectOpsIdempotency(idempotencyValue)}`,
  );
}
