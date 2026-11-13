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
    identityMethod: row.identityMethod ?? null,
    identityVerifiedAt: row.identityVerifiedAt ?? null,
    locatorType: row.locatorType,
    accountState: row.accountState,
    refusalCode: row.refusalCode,
    completedAt: row.completedAt ?? null,
    closedAt: row.closedAt ?? null,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
