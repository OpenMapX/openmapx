import { defaultLocale, locales, resolveLocale } from "@openmapx/i18n";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import z from "zod/v4";
import { db as defaultDb } from "../db/index.js";
import {
  PRIVACY_NOTIFICATION_CHANNELS,
  type PRIVACY_NOTIFICATION_STATES,
  PRIVACY_NOTIFICATION_TEMPLATES,
  type PrivacyNotificationChannel,
  type PrivacyNotificationTemplate,
} from "../db/privacy-schema.js";
import { dataSubjectRequestNotification, user } from "../db/schema.js";
import { sendMail } from "../utils/email.js";
import { privacyRequestEmail } from "../utils/emailTemplates.js";

const code = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
export const privacyNotificationTemplateSchema = z.enum(PRIVACY_NOTIFICATION_TEMPLATES);
export const privacyNotificationChannelSchema = z.enum(PRIVACY_NOTIFICATION_CHANNELS);
export const privacyNotificationPayloadSchema = z
  .record(
    z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/),
    z.union([z.string().max(256), z.number(), z.boolean(), z.null()]),
  )
  .refine((value) => JSON.stringify(value).length <= 2_048, "notification payload is too large");

export const enqueuePrivacyNotificationSchema = z
  .object({
    requestId: z.uuid(),
    recipientUserId: z.string().min(1).max(256),
    template: privacyNotificationTemplateSchema,
    channel: privacyNotificationChannelSchema.default("email"),
    locale: z.enum(locales).default(defaultLocale),
    payload: privacyNotificationPayloadSchema.default({}),
  })
  .strict();
export type EnqueuePrivacyNotification = z.infer<typeof enqueuePrivacyNotificationSchema>;

export interface PrivacyNotificationRow {
  id: string;
  requestId: string;
  recipientUserId: string | null;
  template: PrivacyNotificationTemplate;
  channel: PrivacyNotificationChannel;
  locale: string;
  payload: Record<string, unknown>;
  state: (typeof PRIVACY_NOTIFICATION_STATES)[number];
  attempts: number;
  nextAttemptAt: Date | null;
  sentAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Insert an outbox item idempotently.  The unique (request, template,
 * channel) key means retries after a transaction commit cannot produce a
 * second statutory email. */
export async function enqueuePrivacyNotification(
  input: EnqueuePrivacyNotification,
  database: typeof defaultDb = defaultDb,
): Promise<PrivacyNotificationRow | null> {
  const value = enqueuePrivacyNotificationSchema.parse(input);
  const [row] = await database
    .insert(dataSubjectRequestNotification)
    .values({
      requestId: value.requestId,
      recipientUserId: value.recipientUserId,
      template: value.template,
      channel: value.channel,
      locale: value.locale,
      payload: value.payload,
      state: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        dataSubjectRequestNotification.requestId,
        dataSubjectRequestNotification.template,
        dataSubjectRequestNotification.channel,
      ],
    })
    .returning();
  return (row as PrivacyNotificationRow | undefined) ?? null;
}

/** Same as enqueuePrivacyNotification, but intended for a request transaction
 * so an acknowledgement can never be promised without a durable outbox row. */
export async function enqueuePrivacyNotificationInTransaction(
  transaction: typeof defaultDb,
  input: EnqueuePrivacyNotification,
): Promise<void> {
  const value = enqueuePrivacyNotificationSchema.parse(input);
  await transaction
    .insert(dataSubjectRequestNotification)
    .values({
      requestId: value.requestId,
      recipientUserId: value.recipientUserId,
      template: value.template,
      channel: value.channel,
      locale: value.locale,
      payload: value.payload,
      state: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        dataSubjectRequestNotification.requestId,
        dataSubjectRequestNotification.template,
        dataSubjectRequestNotification.channel,
      ],
    });
}

function safeErrorCode(error: unknown): string {
  const value = error instanceof Error ? error.name : "notification_delivery_failed";
  return code.safeParse(
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .slice(0, 128),
  ).success
    ? value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .slice(0, 128)
    : "notification_delivery_failed";
}

export interface PrivacyNotificationDispatcherOptions {
  database?: typeof defaultDb;
  now?: () => Date;
  batchSize?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  send?: typeof sendMail;
}

/**
 * Deliver a bounded batch from the durable outbox.  Claiming uses a compare-
 * and-set update, and only a generic template is sent after the subject email
 * is looked up.  No request ID, archive link or case payload is put in mail.
 */
export async function dispatchPrivacyNotifications(
  options: PrivacyNotificationDispatcherOptions = {},
): Promise<{ sent: number; retried: number; failed: number; canceled: number }> {
  const database = options.database ?? defaultDb;
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? 16;
  const maxAttempts = options.maxAttempts ?? 5;
  const retryDelayMs = options.retryDelayMs ?? 60_000;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20 ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs < 1 ||
    retryDelayMs > 86_400_000
  )
    throw new Error("invalid notification dispatcher bounds");
  let sent = 0;
  let retried = 0;
  let failed = 0;
  let canceled = 0;
  const candidates = await database
    .select({ id: dataSubjectRequestNotification.id })
    .from(dataSubjectRequestNotification)
    .where(
      and(
        or(
          eq(dataSubjectRequestNotification.state, "pending"),
          eq(dataSubjectRequestNotification.state, "retryable"),
        ),
        or(
          sql`${dataSubjectRequestNotification.nextAttemptAt} is null`,
          lte(dataSubjectRequestNotification.nextAttemptAt, now()),
        ),
      ),
    )
    .orderBy(asc(dataSubjectRequestNotification.createdAt))
    .limit(batchSize);
  for (const candidate of candidates) {
    const [claimed] = await database
      .update(dataSubjectRequestNotification)
      .set({
        state: "sending",
        attempts: sql`${dataSubjectRequestNotification.attempts} + 1`,
        updatedAt: now(),
      })
      .where(
        and(
          eq(dataSubjectRequestNotification.id, candidate.id),
          or(
            eq(dataSubjectRequestNotification.state, "pending"),
            eq(dataSubjectRequestNotification.state, "retryable"),
          ),
        ),
      )
      .returning();
    if (!claimed) continue;
    const [recipient] = await database
      .select({ email: user.email })
      .from(dataSubjectRequestNotification)
      .innerJoin(user, eq(dataSubjectRequestNotification.recipientUserId, user.id))
      .where(eq(dataSubjectRequestNotification.id, candidate.id))
      .limit(1);
    if (!claimed.recipientUserId || !recipient?.email || claimed.channel !== "email") {
      await database
        .update(dataSubjectRequestNotification)
        .set({ state: "canceled", lastErrorCode: "recipient-unavailable", updatedAt: now() })
        .where(
          and(
            eq(dataSubjectRequestNotification.id, candidate.id),
            eq(dataSubjectRequestNotification.state, "sending"),
          ),
        );
      canceled += 1;
      continue;
    }
    try {
      const mail = privacyRequestEmail(claimed.template, resolveLocale(claimed.locale));
      await (options.send ?? sendMail)({
        to: recipient.email,
        ...mail,
        disclosure: {
          userId: claimed.recipientUserId,
          operationCode: `privacy.notification.${claimed.template}`,
          categoryCode: "email-delivery",
          purposeCode: "communications",
          legalBasisCode: "legal-obligation",
          idempotencyKey: `privacy-notification-${claimed.id}`,
        },
      });
      await database
        .update(dataSubjectRequestNotification)
        .set({ state: "sent", sentAt: now(), lastErrorCode: null, updatedAt: now() })
        .where(
          and(
            eq(dataSubjectRequestNotification.id, candidate.id),
            eq(dataSubjectRequestNotification.state, "sending"),
          ),
        );
      sent += 1;
    } catch (error) {
      const errorCode = safeErrorCode(error);
      const terminal = claimed.attempts >= maxAttempts;
      await database
        .update(dataSubjectRequestNotification)
        .set({
          state: terminal ? "failed" : "retryable",
          nextAttemptAt: terminal
            ? null
            : new Date(now().getTime() + retryDelayMs * claimed.attempts),
          lastErrorCode: errorCode,
          updatedAt: now(),
        })
        .where(
          and(
            eq(dataSubjectRequestNotification.id, candidate.id),
            eq(dataSubjectRequestNotification.state, "sending"),
          ),
        );
      if (terminal) failed += 1;
      else retried += 1;
    }
  }
  return { sent, retried, failed, canceled };
}

export function createPrivacyNotificationWorker(
  options: PrivacyNotificationDispatcherOptions & { intervalMs?: number } = {},
): {
  start(): void;
  stop(): void;
  runOnce(): Promise<{ sent: number; retried: number; failed: number; canceled: number }>;
  health(): { healthy: boolean; lastRunAt: string | null; lastErrorCode: string | null };
} {
  const intervalMs = options.intervalMs ?? 5_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 250 || intervalMs > 3_600_000)
    throw new Error("invalid notification interval");
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let started = false;
  let lastRunAt: string | null = null;
  let lastErrorCode: string | null = null;
  const runOnce = async () => {
    if (running) return { sent: 0, retried: 0, failed: 0, canceled: 0 };
    running = true;
    try {
      const result = await dispatchPrivacyNotifications(options);
      lastRunAt = new Date().toISOString();
      lastErrorCode = result.failed > 0 ? "delivery-failures" : null;
      return result;
    } catch (error) {
      lastErrorCode =
        error instanceof Error
          ? error.name
              .toLowerCase()
              .replace(/[^a-z0-9._-]+/g, "-")
              .slice(0, 96) || "dispatch-failed"
          : "dispatch-failed";
      throw error;
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (timer) return;
      started = true;
      void runOnce();
      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      started = false;
    },
    runOnce,
    health() {
      const fresh =
        !!lastRunAt && Date.now() - Date.parse(lastRunAt) <= Math.max(intervalMs * 2, 1_000);
      return { healthy: started && fresh && !lastErrorCode, lastRunAt, lastErrorCode };
    },
  };
}

export type PrivacyNotificationRowType = PrivacyNotificationRow;
