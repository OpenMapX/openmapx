export const PRIVACY_ADMIN_RESUME_KEY = "openmapx.privacy.admin.delivery.v1";
export type PendingPrivacyAdminDelivery = {
  apiOrigin: string;
  actorId: string;
  requestId: string;
  artifactId: string;
  challengeId: string;
  expiresAt: string;
  channel: "assisted" | "representative";
};
const fields = [
  "apiOrigin",
  "actorId",
  "requestId",
  "artifactId",
  "challengeId",
  "expiresAt",
  "channel",
];
function parse(value: unknown): PendingPrivacyAdminDelivery | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== fields.length ||
    fields.some((k) => typeof record[k] !== "string")
  )
    return null;
  if (
    (record.apiOrigin as string).length > 2048 ||
    !(record.actorId as string).length ||
    (record.actorId as string).length > 256
  )
    return null;
  if (
    !["requestId", "artifactId", "challengeId"].every((k) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        record[k] as string,
      ),
    )
  )
    return null;
  if (
    !["assisted", "representative"].includes(record.channel as string) ||
    !Number.isFinite(Date.parse(record.expiresAt as string))
  )
    return null;
  return record as PendingPrivacyAdminDelivery;
}
export function clearPendingPrivacyAdminDelivery() {
  try {
    sessionStorage.removeItem(PRIVACY_ADMIN_RESUME_KEY);
  } catch {
    /* Storage may be unavailable. */
  }
}
export function savePendingPrivacyAdminDelivery(value: PendingPrivacyAdminDelivery) {
  const parsed = parse(value);
  if (!parsed) throw Error("Invalid privacy resume record");
  sessionStorage.setItem(PRIVACY_ADMIN_RESUME_KEY, JSON.stringify(parsed));
}
export function readPendingPrivacyAdminDelivery(
  apiOrigin: string,
  actorId: string,
  now = Date.now(),
): PendingPrivacyAdminDelivery | null {
  try {
    const stored = sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY);
    if (!stored) return null;
    const result = parse(JSON.parse(stored));
    if (
      !result ||
      result.apiOrigin !== apiOrigin ||
      result.actorId !== actorId ||
      Date.parse(result.expiresAt) <= now ||
      Date.parse(result.expiresAt) > now + 10 * 60000
    ) {
      clearPendingPrivacyAdminDelivery();
      return null;
    }
    return result;
  } catch {
    clearPendingPrivacyAdminDelivery();
    return null;
  }
}
