import { createHash } from "node:crypto";
import { RollingStreamBudget, type RollingStreamBudgetLease } from "@openmapx/core/server";
import { PrivacyRequestError } from "./errors.js";

/** Exports this API process prepares and streams at once, across all accounts. */
const MAX_CONCURRENT_EXPORTS = 4;

/**
 * Admission for self-service exports: one export per account at a time and a
 * small ceiling for the whole process. Collecting an account's data and
 * streaming the archive is the most expensive thing a signed-in person can
 * ask for, so a second export for the same account is refused while the first
 * is still running. A retry after an interrupted download is accepted as soon
 * as the earlier attempt has settled.
 *
 * The slots live in this process only. A restart frees them together with the
 * streams they guarded; with several API replicas each replica counts its own.
 * The byte budget of the underlying lease is unused.
 */
export function createPrivacyExportAdmission(
  maxConcurrent = MAX_CONCURRENT_EXPORTS,
): RollingStreamBudget {
  return new RollingStreamBudget({
    maxConcurrentPerKey: 1,
    maxConcurrentGlobal: maxConcurrent,
    maxBytesPerKey: Number.MAX_SAFE_INTEGER,
    windowMs: 60_000,
  });
}

export const privacyExportAdmission = createPrivacyExportAdmission();

/**
 * Take the export slot for an account, or throw the refusal the route maps to
 * its response: 409 `EXPORT_IN_PROGRESS` while the account already holds one,
 * 503 `PRIVACY_SERVICE_UNAVAILABLE` while the process is at its ceiling. The
 * account id is digested so the slot map holds no account identifier.
 */
export function acquireExportSlot(
  admission: RollingStreamBudget,
  userId: string,
): RollingStreamBudgetLease {
  const result = admission.tryAcquire(createHash("sha256").update(userId).digest("hex"));
  if (result.allowed) return result.lease;
  if (result.reason === "key-concurrency") throw new PrivacyRequestError("EXPORT_IN_PROGRESS", 409);
  throw new PrivacyRequestError("PRIVACY_SERVICE_UNAVAILABLE", 503);
}
