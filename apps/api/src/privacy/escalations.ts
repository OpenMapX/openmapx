import { defaultLocale } from "@openmapx/i18n";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db as defaultDb } from "../db/index.js";
import type { PrivacyNotificationTemplate } from "../db/privacy-schema.js";
import { dataSubjectRequest, dataSubjectRequestNotification, user } from "../db/schema.js";

const DUE_SOON_MS = 72 * 60 * 60 * 1_000;
const STUCK_MS = 15 * 60 * 1_000;
const ACTIVE_STATES = [
  "received",
  "identity_pending",
  "preserving",
  "collecting",
  "pending_processor",
  "operator_review",
  "assembling",
  "clarification_needed",
] as const;
const ESCALATION_TEMPLATES = [
  "escalation_due_soon",
  "escalation_overdue",
  "escalation_identity",
  "escalation_extension",
  "escalation_stuck",
] as const satisfies readonly PrivacyNotificationTemplate[];
export type PrivacyEscalationTemplate = (typeof ESCALATION_TEMPLATES)[number];

export interface PrivacyEscalationResult {
  scheduled: number;
  byTemplate: Readonly<Record<PrivacyEscalationTemplate, number>>;
  recipients: number;
}

function templatesForRequest(
  row: { state: string; dueAt: Date; updatedAt: Date; extension: unknown },
  now: number,
): PrivacyEscalationTemplate[] {
  const result: PrivacyEscalationTemplate[] = [];
  const due = row.dueAt.getTime();
  if (due <= now) result.push("escalation_overdue");
  else if (due <= now + DUE_SOON_MS) result.push("escalation_due_soon");
  if (["identity_pending", "clarification_needed"].includes(row.state))
    result.push("escalation_identity");
  if (row.extension && due <= now + DUE_SOON_MS) result.push("escalation_extension");
  if (
    ["collecting", "pending_processor", "assembling"].includes(row.state) &&
    now - row.updatedAt.getTime() >= STUCK_MS
  )
    result.push("escalation_stuck");
  return result;
}

function emptyCounts(): Record<PrivacyEscalationTemplate, number> {
  return Object.fromEntries(ESCALATION_TEMPLATES.map((template) => [template, 0])) as Record<
    PrivacyEscalationTemplate,
    number
  >;
}

/** Schedule privacy-safe escalation messages for the configured privacy
 * administrators.  The outbox unique key `(request, template, channel)` makes
 * repeated timer runs idempotent; payloads contain no subject content, IDs or
 * archive metadata. */
export async function schedulePrivacyEscalations(
  input: { database?: typeof defaultDb; now?: Date; recipientUserIds?: readonly string[] } = {},
): Promise<PrivacyEscalationResult> {
  const database = input.database ?? defaultDb;
  const now = input.now ?? new Date();
  const recipients = input.recipientUserIds
    ? [
        ...new Set(
          input.recipientUserIds.filter((value) =>
            /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value),
          ),
        ),
      ]
    : (
        await database
          .select({ id: user.id })
          .from(user)
          .where(
            and(
              or(eq(user.role, "admin"), eq(user.role, "privacy_admin")),
              or(isNull(user.banned), eq(user.banned, false)),
            ),
          )
      ).map((row) => row.id);
  const requests = await database
    .select({
      id: dataSubjectRequest.id,
      state: dataSubjectRequest.state,
      dueAt: dataSubjectRequest.dueAt,
      updatedAt: dataSubjectRequest.updatedAt,
      extension: dataSubjectRequest.extension,
    })
    .from(dataSubjectRequest)
    .where(
      sql`${dataSubjectRequest.state} in ('received', 'identity_pending', 'preserving', 'collecting', 'pending_processor', 'operator_review', 'assembling', 'clarification_needed')`,
    )
    .limit(50_000);
  const byTemplate = emptyCounts();
  let scheduled = 0;
  for (const request of requests) {
    for (const template of templatesForRequest(request, now.getTime())) {
      for (const recipientUserId of recipients) {
        const inserted = await database
          .insert(dataSubjectRequestNotification)
          .values({
            requestId: request.id,
            recipientUserId,
            template,
            channel: "email",
            locale: defaultLocale,
            payload: {},
            state: "pending",
            attempts: 0,
            nextAttemptAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({
            target: [
              dataSubjectRequestNotification.requestId,
              dataSubjectRequestNotification.template,
              dataSubjectRequestNotification.channel,
            ],
          })
          .returning({ id: dataSubjectRequestNotification.id });
        if (inserted[0]) {
          scheduled += 1;
          byTemplate[template] += 1;
        }
      }
    }
  }
  return { scheduled, byTemplate, recipients: recipients.length };
}

export function escalationTemplateNames(): readonly PrivacyEscalationTemplate[] {
  return ESCALATION_TEMPLATES;
}
