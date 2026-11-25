import {
  PRIVACY_ACTOR_KINDS,
  PRIVACY_EVENT_TYPES,
  type PrivacyActorKind,
  type PrivacyEventType,
  REQUEST_STATUSES,
  type RequestStatus,
  SUBJECT_DATA_SOURCES,
  type SubjectDataSource,
} from "@openmapx/core/privacy";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
import { oneOf } from "./closed-value-check";

export { REQUEST_STATUSES, type RequestStatus };

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
export const TASK_STATUSES = ["open", "resolved"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
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
export const PRIVACY_NOTIFICATION_STATUSES = [
  "pending",
  "sending",
  "sent",
  "retryable",
  "failed",
  "canceled",
] as const;
export type PrivacyNotificationStatus = (typeof PRIVACY_NOTIFICATION_STATUSES)[number];

/** One open case per account and kind; registering a second raises this index. */
export const ACTIVE_REQUEST_KIND_KEY = "data_subject_request_user_id_kind_active_key";
/** One event per case and mutation key; replaying a mutation raises this index. */
export const REQUEST_EVENT_IDEMPOTENCY_KEY =
  "data_subject_request_event_request_id_idempotency_key_key";

export const dataSubjectRequest = pgTable(
  "data_subject_request",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    kind: text("kind").$type<RequestKind>().notNull(),
    channel: text("channel").$type<RequestChannel>().notNull(),
    userId: text("user_id"),
    actorUserId: text("actor_user_id"),
    actorSessionId: text("actor_session_id"),
    /** Assisted requests only: the locator value, encrypted with the API's secrets key. */
    locatorCiphertext: text("locator_ciphertext"),
    locatorIv: text("locator_iv"),
    locatorTag: text("locator_tag"),
    locatorKeyVersion: integer("locator_key_version"),
    locatorType: text("locator_type").notNull().default("user_id"),
    accountState: text("account_state").notNull().default("current"),
    locale: text("locale").notNull().default("en"),
    timeZone: text("time_zone").notNull().default("UTC"),
    status: text("status").$type<RequestStatus>().notNull().default("open"),
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
    foreignKey({
      name: "data_subject_request_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "data_subject_request_actor_user_id_fkey",
      columns: [table.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "data_subject_request_actor_session_id_fkey",
      columns: [table.actorSessionId],
      foreignColumns: [session.id],
    }).onDelete("set null"),
    check(
      "data_subject_request_kind_check",
      sql`${table.kind} in ('access', 'portability', 'access_and_portability')`,
    ),
    check(
      "data_subject_request_channel_check",
      sql`${table.channel} in ('self_service', 'email', 'post', 'representative', 'internal')`,
    ),
    check("data_subject_request_status_check", oneOf(table.status, REQUEST_STATUSES)),
    check(
      "data_subject_request_locator_ciphertext_check",
      sql`(${table.locatorCiphertext} is null and ${table.locatorIv} is null and ${table.locatorTag} is null and ${table.locatorKeyVersion} is null) or (${table.locatorCiphertext} is not null and ${table.locatorIv} is not null and ${table.locatorTag} is not null and ${table.locatorKeyVersion} is not null)`,
    ),
    check("data_subject_request_version_check", sql`${table.version} > 0`),
    check(
      "data_subject_request_locator_type_check",
      sql`${table.locatorType} in ('user_id', 'email', 'erasure_reference', 'other_reference')`,
    ),
    check(
      "data_subject_request_account_state_check",
      sql`${table.accountState} in ('current', 'inaccessible', 'deleted', 'unknown')`,
    ),
    check(
      "data_subject_request_identity_check",
      sql`(${table.identityMethod} is null and ${table.identityVerifiedAt} is null) or (${table.identityMethod} in ('account_session', 'manual') and ${table.identityVerifiedAt} is not null)`,
    ),
    index("data_subject_request_user_id_status_idx").on(table.userId, table.status),
    index("data_subject_request_status_due_at_idx").on(table.status, table.dueAt),
    index("data_subject_request_actor_user_id_idx").on(table.actorUserId),
    index("data_subject_request_actor_session_id_idx").on(table.actorSessionId),
    uniqueIndex(ACTIVE_REQUEST_KIND_KEY)
      .on(table.userId, table.kind)
      .where(
        sql`${table.userId} is not null and ${table.status} in ('open', 'in_progress', 'waiting_on_requester')`,
      ),
  ],
);

export const dataSubjectRequestEvent = pgTable(
  "data_subject_request_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    requestId: uuid("request_id").notNull(),
    eventType: text("event_type").$type<PrivacyEventType>().notNull(),
    actorKind: text("actor_kind").$type<PrivacyActorKind>().notNull(),
    /** The acting account; null for system actors and after the
     * account is deleted. `actor_kind` still says who acted. */
    actorUserId: text("actor_user_id"),
    payloadVersion: integer("payload_version").notNull().default(1),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    /** Stable mutation key; null is allowed for informational events. */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "data_subject_request_event_request_id_fkey",
      columns: [table.requestId],
      foreignColumns: [dataSubjectRequest.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "data_subject_request_event_actor_user_id_fkey",
      columns: [table.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    check("data_subject_request_event_payload_version_check", sql`${table.payloadVersion} > 0`),
    check(
      "data_subject_request_event_event_type_check",
      oneOf(table.eventType, PRIVACY_EVENT_TYPES),
    ),
    check(
      "data_subject_request_event_actor_kind_check",
      oneOf(table.actorKind, PRIVACY_ACTOR_KINDS),
    ),
    index("data_subject_request_event_request_id_created_at_idx").on(
      table.requestId,
      table.createdAt,
    ),
    index("data_subject_request_event_actor_user_id_idx").on(table.actorUserId),
    uniqueIndex(REQUEST_EVENT_IDEMPOTENCY_KEY)
      .on(table.requestId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
  ],
);

/** One operator-held source per request. The operator checks it outside the
 * system and resolves the task with a reason code. */
export const dataSubjectRequestTask = pgTable(
  "data_subject_request_task",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    requestId: uuid("request_id").notNull(),
    registrationId: text("registration_id").notNull(),
    source: text("source").$type<SubjectDataSource>().notNull(),
    status: text("status").$type<TaskStatus>().notNull().default("open"),
    publicCode: text("public_code"),
    resolutionCode: text("resolution_code"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "data_subject_request_task_request_id_fkey",
      columns: [table.requestId],
      foreignColumns: [dataSubjectRequest.id],
    }).onDelete("cascade"),
    uniqueIndex("data_subject_request_task_request_id_registration_id_key").on(
      table.requestId,
      table.registrationId,
    ),
    index("data_subject_request_task_status_idx").on(table.status),
    check("data_subject_request_task_status_check", sql`${table.status} in ('open', 'resolved')`),
    check("data_subject_request_task_source_check", oneOf(table.source, SUBJECT_DATA_SOURCES)),
  ],
);

export const dataSubjectRequestPreservation = pgTable(
  "data_subject_request_preservation",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    requestId: uuid("request_id").notNull(),
    registrationId: text("registration_id").notNull(),
    sourceCutoffAt: timestamp("source_cutoff_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    status: text("status").notNull().default("held"),
    outcomeCode: text("outcome_code"),
  },
  (table) => [
    foreignKey({
      name: "data_subject_request_preservation_request_id_fkey",
      columns: [table.requestId],
      foreignColumns: [dataSubjectRequest.id],
    }).onDelete("cascade"),
    uniqueIndex("data_subject_request_preservation_request_registration_key").on(
      table.requestId,
      table.registrationId,
    ),
    index("data_subject_request_preservation_registration_id_status_idx").on(
      table.registrationId,
      table.status,
    ),
    check(
      "data_subject_request_preservation_status_check",
      sql`${table.status} in ('held', 'source_capture_pending', 'action_required', 'captured', 'released')`,
    ),
  ],
);

/** Durable, minimal notification outbox for statutory case updates.  The
 * recipient is resolved from the current subject row when dispatched; raw
 * email addresses, URLs and archive identifiers are never persisted here. */
export const dataSubjectRequestNotification = pgTable(
  "data_subject_request_notification",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    requestId: uuid("request_id").notNull(),
    recipientUserId: text("recipient_user_id"),
    template: text("template").$type<PrivacyNotificationTemplate>().notNull(),
    channel: text("channel").$type<PrivacyNotificationChannel>().notNull().default("email"),
    locale: text("locale").notNull().default("en"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<PrivacyNotificationStatus>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    lastErrorCode: text("last_error_code"),
    /** Tells repeated occurrences of one template apart: the request
     * version a transition or extension produced, or the deadline a
     * reminder is for. Empty for templates sent once per request. */
    occurrenceKey: text("occurrence_key").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "data_subject_request_notification_request_id_fkey",
      columns: [table.requestId],
      foreignColumns: [dataSubjectRequest.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "data_subject_request_notification_recipient_user_id_fkey",
      columns: [table.recipientUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    // One delivery of a template per case, channel, recipient and occurrence.
    // Nulls stay distinct: deleting several alerted administrators nulls each
    // of their recipient ids, and those alerts must not collide. Every insert
    // names a live recipient, so a null never needs deduplicating.
    uniqueIndex("data_subject_request_notification_delivery_key").on(
      table.requestId,
      table.template,
      table.channel,
      table.recipientUserId,
      table.occurrenceKey,
    ),
    index("data_subject_request_notification_status_next_attempt_at_idx").on(
      table.status,
      table.nextAttemptAt,
    ),
    index("data_subject_request_notification_recipient_created_at_idx").on(
      table.recipientUserId,
      table.createdAt,
    ),
    check(
      "data_subject_request_notification_template_check",
      sql`${table.template} in ('acknowledgement', 'waiting_on_requester', 'extension', 'completed', 'refused', 'admin_new_request', 'admin_deadline')`,
    ),
    check("data_subject_request_notification_channel_check", sql`${table.channel} in ('email')`),
    check(
      "data_subject_request_notification_status_check",
      oneOf(table.status, PRIVACY_NOTIFICATION_STATUSES),
    ),
    check("data_subject_request_notification_attempts_check", sql`${table.attempts} >= 0`),
  ],
);
