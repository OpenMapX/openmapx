import { calculateSubjectRequestDueAt } from "./deadline";
export function privacyCaseProjection(row: Record<string, unknown>) {
  return {
    id: row.id,
    originalDueAt: calculateSubjectRequestDueAt(
      new Date(row.receivedAt as string),
      String(row.timeZone),
    ),
    kind: row.kind,
    channel: row.channel,
    state: row.state,
    userId: row.userId,
    locale: row.locale,
    timeZone: row.timeZone,
    receivedAt: row.receivedAt,
    registeredAt: row.registeredAt,
    dueAt: row.dueAt,
    extension: row.extension,
    identityState: row.identityState,
    locatorType: row.locatorType,
    accountState: row.accountState,
    refusalCode: row.refusalCode,
    deliveryState: row.deliveryState,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function privacyAttachmentProjection(row: Record<string, unknown>) {
  return Object.fromEntries(
    [
      "id",
      "purpose",
      "filename",
      "mediaType",
      "plaintextBytes",
      "expiresAt",
      "rightsReviewState",
      "metadata",
      "createdAt",
    ]
      .filter((k) => row[k] !== undefined)
      .map((k) => [k, row[k]]),
  );
}
