import { ACTIVE_REQUEST_STATES } from "@openmapx/core/privacy";
import { defaultLocale } from "@openmapx/i18n";
import { and, inArray, lte } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import { dataSubjectRequest, dataSubjectRequestNotification } from "../db/schema.js";
import { privacyAlertRecipients } from "./request-service.js";

/** An active request is due soon once its deadline is this close. */
export const DEADLINE_REMINDER_WINDOW_MS = 72 * 60 * 60 * 1_000;

/**
 * Queue one `admin_deadline` reminder per administrator for each active
 * request that is due soon or overdue. The outbox key includes the recipient,
 * so every administrator gets one reminder per request however often this
 * runs. The payload carries no subject content or identifiers.
 */
export async function schedulePrivacyDeadlineReminders(
  input: { database?: typeof defaultDb; now?: Date } = {},
): Promise<{ scheduled: number; recipients: number }> {
  const database = input.database ?? defaultDb;
  const now = input.now ?? new Date();
  const recipients = await privacyAlertRecipients(database, now);
  const requests = await database
    .select({ id: dataSubjectRequest.id })
    .from(dataSubjectRequest)
    .where(
      and(
        inArray(dataSubjectRequest.state, [...ACTIVE_REQUEST_STATES]),
        lte(dataSubjectRequest.dueAt, new Date(now.getTime() + DEADLINE_REMINDER_WINDOW_MS)),
      ),
    )
    .limit(50_000);
  let scheduled = 0;
  for (const request of requests) {
    if (!recipients.length) break;
    const inserted = await database
      .insert(dataSubjectRequestNotification)
      .values(
        recipients.map((recipientUserId) => ({
          requestId: request.id,
          recipientUserId,
          template: "admin_deadline" as const,
          channel: "email" as const,
          locale: defaultLocale,
          payload: {},
          state: "pending" as const,
          attempts: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing({
        target: [
          dataSubjectRequestNotification.requestId,
          dataSubjectRequestNotification.template,
          dataSubjectRequestNotification.channel,
          dataSubjectRequestNotification.recipientUserId,
        ],
      })
      .returning({ id: dataSubjectRequestNotification.id });
    scheduled += inserted.length;
  }
  return { scheduled, recipients: recipients.length };
}
