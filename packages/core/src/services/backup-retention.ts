/** Portable expiry is a ceiling: a later policy may shorten it, never extend it. */
const day = 24 * 60 * 60 * 1000;
export function backupRetentionExpiry(
  createdAt: string,
  retentionDays: number,
  expiresAt?: unknown,
): string {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 36500)
    throw Error("Backup retention days must be an integer between 1 and 36500");
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) throw Error("Backup creation timestamp is invalid");
  let expiry = created + retentionDays * day;
  if (expiresAt !== undefined) {
    if (typeof expiresAt !== "string") throw Error("Backup expiry is invalid");
    const stamped = Date.parse(expiresAt);
    if (!Number.isFinite(stamped) || stamped < created || stamped > created + 36500 * day)
      throw Error("Backup expiry is invalid");
    expiry = Math.min(expiry, stamped);
  }
  if (!Number.isFinite(new Date(expiry).getTime())) throw Error("Backup expiry is invalid");
  return new Date(expiry).toISOString();
}
