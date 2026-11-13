import { REQUEST_STATES, type RequestState } from "@openmapx/core/privacy";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { session, user } from "./auth-schema";

export { REQUEST_STATES, type RequestState };
export const REQUEST_KINDS = ["access", "portability", "access_and_portability"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];
export const REQUEST_CHANNELS = [
  "self_service",
  "email",
  "post",
  "representative",
  "internal",
] as const;
export type RequestChannel = (typeof REQUEST_CHANNELS)[number];
/** How the requester's identity was established: a freshly signed-in account
 * session for self-service, or an operator's manual check for assisted cases. */
export const IDENTITY_METHODS = ["account_session", "manual"] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];
export const TASK_STATES = ["open", "resolved"] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const PRIVACY_SUBJECT_NOTIFICATION_TEMPLATES = [
  "acknowledgement",
  "waiting_on_requester",
  "extension",
  "completed",
  "refused",
] as const;
export const PRIVACY_ADMIN_NOTIFICATION_TEMPLATES = [
  "admin_new_request",
  "admin_deadline",
] as const;
export const PRIVACY_NOTIFICATION_TEMPLATES = [
  ...PRIVACY_SUBJECT_NOTIFICATION_TEMPLATES,
  ...PRIVACY_ADMIN_NOTIFICATION_TEMPLATES,
] as const;
export type PrivacyNotificationTemplate = (typeof PRIVACY_NOTIFICATION_TEMPLATES)[number];
export const PRIVACY_NOTIFICATION_CHANNELS = ["email"] as const;
export type PrivacyNotificationChannel = (typeof PRIVACY_NOTIFICATION_CHANNELS)[number];
export const PRIVACY_NOTIFICATION_STATES = [
  "pending",
  "sending",
  "sent",
  "retryable",
  "failed",
  "canceled",
] as const;
export type PrivacyNotificationState = (typeof PRIVACY_NOTIFICATION_STATES)[number];

export const dataSubjectRequest = pgTable(
  "data_subject_request",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    kind: text("kind").$type<RequestKind>().notNull(),
    channel: text("channel").$type<RequestChannel>().notNull(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    actorUserId: text("actor_user_id").references(() => user.id, { onDelete: "set null" }),
    actorSessionId: text("actor_session_id").references(() => session.id, { onDelete: "set null" }),
    /** Assisted requests only: the locator value, encrypted with OPENMAPX_SECRETS_KEY. */
    encryptedLocator: text("encrypted_locator"),
    locatorType: text("locator_type").notNull().default("user_id"),
    accountState: text("account_state").notNull().default("current"),
    locale: text("locale").notNull().default("en"),
    timeZone: text("time_zone").notNull().default("UTC"),
    state: text("state").$type<RequestState>().notNull().default("open"),
    version: integer("version").notNull().default(1),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
    preservationAt: timestamp("preservation_at", { withTimezone: true }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    extension: jsonb("extension").$type<Record<string, unknown> | null>(),
    identityMethod: text("identity_method").$type<IdentityMethod>(),
    identityVerifiedAt: timestamp("identity_verified_at", { withTimezone: true }),
    refusalCode: text("refusal_code"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "data_subject_request_kind_check",
      sql`${table.kind} in ('access', 'portability', 'access_and_portability')`,
    ),
    check(
      "data_subject_request_channel_check",
      sql`${table.channel} in ('self_service', 'email', 'post', 'representative', 'internal')`,
    ),
    check(
      "data_subject_request_state_check",
      sql`${table.state} in ('open', 'in_progress', 'waiting_on_requester', 'completed', 'refused')`,
    ),
    check("data_subject_request_version_check", sql`${table.version} > 0`),
    check(
      "data_subject_request_locator_type_check",
      sql`${table.locatorType} in ('user_id', 'email', 'username', 'erasure_reference', 'other_reference')`,
    ),
    check(
      "data_subject_request_account_state_check",
      sql`${table.accountState} in ('current', 'inaccessible', 'deleted', 'unknown')`,
    ),
    check(
      "data_subject_request_identity_check",
      sql`(${table.identityMethod} is null and ${table.identityVerifiedAt} is null) or (${table.identityMethod} in ('account_session', 'manual') and ${table.identityVerifiedAt} is not null)`,
    ),
    index("data_subject_request_user_state_idx").on(table.userId, table.state),
    index("data_subject_request_due_idx").on(table.state, table.dueAt),
    uniqueIndex("data_subject_request_active_user_kind_idx")
      .on(table.userId, table.kind)
      .where(
        sql`${table.userId} is not null and ${table.state} in ('open', 'in_progress', 'waiting_on_requester')`,
      ),
  ],
);

export const dataSubjectRequestEvent = pgTable(
  "data_subject_request_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorId: text("actor_id"),
    payloadVersion: integer("payload_version").notNull().default(1),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Stable mutation key; null is allowed for informational events. */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("data_subject_request_event_payload_version_check", sql`${table.payloadVersion} > 0`),
    index("data_subject_request_event_request_idx").on(table.requestId, table.createdAt),
    uniqueIndex("data_subject_request_event_idempotency_idx")
      .on(table.requestId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/** One operator-held source per request. The operator checks it outside the
 * system and resolves the task with a reason code. */
export const dataSubjectRequestTask = pgTable(
  "data_subject_request_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    registrationId: text("registration_id").notNull(),
    source: text("source").notNull(),
    status: text("status").$type<TaskState>().notNull().default("open"),
    publicCode: text("public_code"),
    resolutionCode: text("resolution_code"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("data_subject_request_task_request_registration_idx").on(
      table.requestId,
      table.registrationId,
    ),
    index("data_subject_request_task_status_idx").on(table.status),
    check("data_subject_request_task_status_check", sql`${table.status} in ('open', 'resolved')`),
  ],
);

export const dataSubjectRequestPreservation = pgTable(
  "data_subject_request_preservation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    registrationId: text("registration_id").notNull(),
    sourceCutoffAt: timestamp("source_cutoff_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    status: text("status").notNull().default("held"),
    outcomeCode: text("outcome_code"),
  },
  (table) => [
    uniqueIndex("data_subject_request_preservation_request_registration_idx").on(
      table.requestId,
      table.registrationId,
    ),
    index("data_subject_request_preservation_locator_idx").on(table.registrationId, table.status),
  ],
);

/** Durable, minimal notification outbox for statutory case updates.  The
 * recipient is resolved from the current subject row when dispatched; raw
 * email addresses, URLs and archive identifiers are never persisted here. */
export const dataSubjectRequestNotification = pgTable(
  "data_subject_request_notification",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id").references(() => user.id, { onDelete: "set null" }),
    template: text("template").$type<PrivacyNotificationTemplate>().notNull(),
    channel: text("channel").$type<PrivacyNotificationChannel>().notNull().default("email"),
    locale: text("locale").notNull().default("en"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    state: text("state").$type<PrivacyNotificationState>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("data_subject_request_notification_event_idx").on(
      table.requestId,
      table.template,
      table.channel,
      table.recipientUserId,
    ),
    index("data_subject_request_notification_state_idx").on(table.state, table.nextAttemptAt),
    index("data_subject_request_notification_recipient_idx").on(
      table.recipientUserId,
      table.createdAt,
    ),
    check(
      "data_subject_request_notification_template_check",
      sql`${table.template} in ('acknowledgement', 'waiting_on_requester', 'extension', 'completed', 'refused', 'admin_new_request', 'admin_deadline')`,
    ),
    check("data_subject_request_notification_channel_check", sql`${table.channel} in ('email')`),
    check(
      "data_subject_request_notification_state_check",
      sql`${table.state} in ('pending', 'sending', 'sent', 'retryable', 'failed', 'canceled')`,
    ),
    check("data_subject_request_notification_attempts_check", sql`${table.attempts} >= 0`),
  ],
);
