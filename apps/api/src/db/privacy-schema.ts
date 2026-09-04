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

export const REQUEST_STATES = [
  "received",
  "identity_pending",
  "preserving",
  "collecting",
  "pending_processor",
  "operator_review",
  "assembling",
  "ready",
  "delivered",
  "artifact_expired",
  "clarification_needed",
  "withdrawn",
  "refused",
  "closed",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
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
export const TASK_STATES = [
  "pending",
  "running",
  "complete",
  "not_applicable",
  "retryable",
  "operator_review",
  "canceled",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const ARTIFACT_STATES = [
  "assembling",
  "ready",
  "revoked",
  "expired",
  "deleted",
  "failed",
] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];
export const PRIVACY_NOTIFICATION_TEMPLATES = [
  "acknowledgement",
  "clarification",
  "extension",
  "ready",
  "delivered",
  "closed",
  "refused",
  "escalation_due_soon",
  "escalation_overdue",
  "escalation_identity",
  "escalation_extension",
  "escalation_stuck",
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
    encryptedLocator: text("encrypted_locator").notNull(),
    locatorDigest: text("locator_digest").notNull(),
    locatorType: text("locator_type").notNull().default("user_id"),
    accountState: text("account_state").notNull().default("current"),
    locale: text("locale").notNull().default("en"),
    timeZone: text("time_zone").notNull().default("UTC"),
    state: text("state").$type<RequestState>().notNull().default("received"),
    version: integer("version").notNull().default(1),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    registeredAt: timestamp("registered_at", { withTimezone: true }).defaultNow().notNull(),
    preservationAt: timestamp("preservation_at", { withTimezone: true }),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    extension: jsonb("extension").$type<Record<string, unknown> | null>(),
    identityState: text("identity_state").notNull().default("pending"),
    refusalCode: text("refusal_code"),
    refusalReason: text("refusal_reason"),
    deliveryState: text("delivery_state").notNull().default("not_delivered"),
    withdrawalAt: timestamp("withdrawal_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    /** Authenticated encrypted envelope; plaintext operator notes are never persisted. */
    protectedNotesEnvelope: text("protected_notes_envelope"),
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
      sql`${table.state} in ('received', 'identity_pending', 'preserving', 'collecting', 'pending_processor', 'operator_review', 'assembling', 'ready', 'delivered', 'artifact_expired', 'clarification_needed', 'withdrawn', 'refused', 'closed')`,
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
    index("data_subject_request_user_state_idx").on(table.userId, table.state),
    index("data_subject_request_due_idx").on(table.state, table.dueAt),
    index("data_subject_request_locator_digest_idx").on(table.locatorDigest),
    uniqueIndex("data_subject_request_active_user_kind_idx")
      .on(table.userId, table.kind)
      .where(
        sql`${table.userId} is not null and ${table.state} not in ('withdrawn', 'refused', 'closed', 'delivered', 'artifact_expired')`,
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

export const dataSubjectRequestTask = pgTable(
  "data_subject_request_task",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    taskKey: text("task_key").notNull(),
    registrationId: text("registration_id").notNull(),
    collectorId: text("collector_id"),
    collectorVersion: integer("collector_version"),
    source: text("source").notNull(),
    required: integer("required").notNull().default(1),
    status: text("status").$type<TaskState>().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    assignedTo: text("assigned_to").references(() => user.id, { onDelete: "set null" }),
    cutoffAt: timestamp("cutoff_at", { withTimezone: true }),
    collectedAt: timestamp("collected_at", { withTimezone: true }),
    recordCount: integer("record_count"),
    publicCode: text("public_code"),
    encryptedDetail: text("encrypted_detail"),
    exceptionCode: text("exception_code"),
    redactionCode: text("redaction_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("data_subject_request_task_request_key_idx").on(table.requestId, table.taskKey),
    index("data_subject_request_task_status_idx").on(table.status, table.nextAttemptAt),
    index("data_subject_request_task_registration_idx").on(table.registrationId),
    check("data_subject_request_task_attempts_check", sql`${table.attempts} >= 0`),
    check("data_subject_request_task_required_check", sql`${table.required} in (0, 1)`),
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
    locatorDigest: text("locator_digest").notNull(),
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
    index("data_subject_request_preservation_locator_idx").on(
      table.registrationId,
      table.locatorDigest,
      table.status,
    ),
  ],
);

/** Receipt-side safe projections for short-lived sources. Ciphertext lives in
 * the private privacy blob store; this row is the durable integrity/key
 * boundary and contains no source records or usable credentials. */
export const dataSubjectRequestSourceSnapshot = pgTable(
  "data_subject_request_source_snapshot",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    registrationId: text("registration_id").notNull(),
    state: text("state").notNull().default("captured"),
    format: text("format").notNull().default("subject-record-jsonl-v1"),
    storageKey: text("storage_key").notNull().unique(),
    recordCount: integer("record_count").notNull(),
    plaintextBytes: integer("plaintext_bytes").notNull(),
    encryptedBytes: integer("encrypted_bytes").notNull(),
    plaintextSha256: text("plaintext_sha256").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    cipherVersion: integer("cipher_version").notNull().default(1),
    aadVersion: integer("aad_version").notNull().default(1),
    iv: text("iv").notNull(),
    tag: text("tag"),
    wrappedDek: text("wrapped_dek"),
    masterKeyVersion: integer("master_key_version"),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deleteAttempts: integer("delete_attempts").notNull().default(0),
    lastDeleteAttemptAt: timestamp("last_delete_attempt_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("data_subject_request_source_snapshot_request_registration_idx").on(
      table.requestId,
      table.registrationId,
    ),
    index("data_subject_request_source_snapshot_expiry_idx").on(table.state, table.expiresAt),
    check(
      "data_subject_request_source_snapshot_state_check",
      sql`${table.state} in ('captured', 'delete_failed', 'deleted')`,
    ),
    check(
      "data_subject_request_source_snapshot_format_check",
      sql`${table.format} = 'subject-record-jsonl-v1'`,
    ),
    check(
      "data_subject_request_source_snapshot_counts_check",
      sql`${table.recordCount} >= 0 and ${table.plaintextBytes} >= 0 and ${table.encryptedBytes} >= 0 and ${table.deleteAttempts} >= 0 and ${table.deleteAttempts} <= 5`,
    ),
  ],
);

export const dataExportArtifact = pgTable(
  "data_export_artifact",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    generationId: uuid("generation_id").defaultRandom().notNull(),
    state: text("state").$type<ArtifactState>().notNull().default("assembling"),
    storageKey: text("storage_key").notNull().unique(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull().default("application/zip"),
    plaintextBytes: integer("plaintext_bytes"),
    encryptedBytes: integer("encrypted_bytes"),
    plaintextSha256: text("plaintext_sha256"),
    ciphertextSha256: text("ciphertext_sha256"),
    cipherVersion: integer("cipher_version").notNull().default(1),
    aadVersion: integer("aad_version").notNull().default(1),
    iv: text("iv").notNull(),
    tag: text("tag"),
    wrappedDek: text("wrapped_dek"),
    masterKeyVersion: integer("master_key_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    readyAt: timestamp("ready_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    downloadCount: integer("download_count").notNull().default(0),
  },
  (table) => [
    index("data_export_artifact_request_state_idx").on(table.requestId, table.state),
    index("data_export_artifact_expiry_idx").on(table.state, table.expiresAt),
    check("data_export_artifact_download_count_check", sql`${table.downloadCount} >= 0`),
  ],
);

export const dataSubjectRequestAttachment = pgTable(
  "data_subject_request_attachment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    encryptedBytes: integer("encrypted_bytes").notNull(),
    plaintextBytes: integer("plaintext_bytes").notNull(),
    plaintextSha256: text("plaintext_sha256").notNull(),
    ciphertextSha256: text("ciphertext_sha256").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag"),
    wrappedDek: text("wrapped_dek"),
    masterKeyVersion: integer("master_key_version"),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    rightsReviewState: text("rights_review_state").notNull().default("pending"),
    /** Bounded provenance/redaction metadata; never store supplement contents. */
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("data_subject_request_attachment_request_idx").on(table.requestId, table.purpose),
    index("data_subject_request_attachment_expiry_idx").on(table.expiresAt),
    check(
      "data_subject_request_attachment_purpose_check",
      sql`${table.purpose} in ('identity_evidence', 'representative_authority', 'processor_response', 'operator_supplement')`,
    ),
  ],
);

/** Identity is recorded per party so subject verification never implies that a
 * representative is verified or authorized to receive the response. Contact
 * values remain encrypted; list/detail APIs expose only bounded state. */
export const dataSubjectRequestIdentity = pgTable(
  "data_subject_request_identity",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    party: text("party").notNull(),
    contactEnvelope: text("contact_envelope"),
    contactDigest: text("contact_digest"),
    state: text("state").notNull().default("pending"),
    method: text("method"),
    reasonableDoubtCode: text("reasonable_doubt_code"),
    evidenceAttachmentId: uuid("evidence_attachment_id").references(
      () => dataSubjectRequestAttachment.id,
      { onDelete: "set null" },
    ),
    authorityState: text("authority_state").notNull().default("not_applicable"),
    authorityAttachmentId: uuid("authority_attachment_id").references(
      () => dataSubjectRequestAttachment.id,
      { onDelete: "set null" },
    ),
    deliveryAuthorized: integer("delivery_authorized").notNull().default(0),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    verifiedBy: text("verified_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("data_subject_request_identity_party_idx").on(table.requestId, table.party),
    index("data_subject_request_identity_state_idx").on(table.state, table.authorityState),
    check(
      "data_subject_request_identity_party_check",
      sql`${table.party} in ('subject', 'representative')`,
    ),
    check(
      "data_subject_request_identity_state_check",
      sql`${table.state} in ('pending', 'verified', 'failed', 'clarification')`,
    ),
    check(
      "data_subject_request_identity_method_check",
      sql`${table.method} is null or ${table.method} in ('account_login', 'verified_email_challenge', 'exceptional_evidence')`,
    ),
    check(
      "data_subject_request_identity_authority_check",
      sql`${table.authorityState} in ('not_applicable', 'pending', 'approved', 'rejected')`,
    ),
    check(
      "data_subject_request_identity_delivery_check",
      sql`${table.deliveryAuthorized} in (0, 1) and (${table.deliveryAuthorized} = 0 or (${table.party} = 'representative' and ${table.authorityState} = 'approved' and ${table.state} = 'verified'))`,
    ),
  ],
);

/** One short-lived email proof attempt.  The recipient and code are never
 * persisted in plaintext; the row is also the atomic consume boundary. */
export const dataSubjectRequestEmailChallenge = pgTable(
  "data_subject_request_email_challenge",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => dataSubjectRequestIdentity.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull().default("identity_verification"),
    party: text("party").notNull(),
    recipientSource: text("recipient_source").notNull(),
    locale: text("locale").notNull().default("en"),
    recipientEnvelope: text("recipient_envelope").notNull(),
    recipientDigest: text("recipient_digest").notNull(),
    codeDigest: text("code_digest"),
    codeKeyVersion: integer("code_key_version"),
    state: text("state").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    maxDeliveryAttempts: integer("max_delivery_attempts").notNull().default(5),
    deliveryLeaseId: uuid("delivery_lease_id"),
    nextDeliveryAttemptAt: timestamp("next_delivery_attempt_at", { withTimezone: true }),
    lastDeliveryErrorCode: text("last_delivery_error_code"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("data_subject_request_email_challenge_request_idx").on(table.requestId, table.createdAt),
    index("data_subject_request_email_challenge_identity_idx").on(
      table.identityId,
      table.createdAt,
    ),
    index("data_subject_request_email_challenge_delivery_idx").on(
      table.state,
      table.nextDeliveryAttemptAt,
    ),
    index("data_subject_request_email_challenge_expiry_idx").on(table.expiresAt),
    uniqueIndex("data_subject_request_email_challenge_active_identity_idx")
      .on(table.identityId)
      .where(sql`${table.state} in ('queued', 'sending', 'issued', 'retryable')`),
    check(
      "data_subject_request_email_challenge_purpose_check",
      sql`${table.purpose} = 'identity_verification'`,
    ),
    check(
      "data_subject_request_email_challenge_party_check",
      sql`${table.party} in ('subject', 'representative')`,
    ),
    check(
      "data_subject_request_email_challenge_recipient_source_check",
      sql`${table.recipientSource} in ('live_account', 'request_locator', 'representative_contact')`,
    ),
    check(
      "data_subject_request_email_challenge_state_check",
      sql`${table.state} in ('queued', 'sending', 'issued', 'retryable', 'failed', 'revoked', 'consumed', 'expired')`,
    ),
    check(
      "data_subject_request_email_challenge_attempts_check",
      sql`${table.attempts} >= 0 and ${table.maxAttempts} > 0 and ${table.attempts} <= ${table.maxAttempts}`,
    ),
    check(
      "data_subject_request_email_challenge_delivery_attempts_check",
      sql`${table.deliveryAttempts} >= 0 and ${table.maxDeliveryAttempts} > 0 and ${table.deliveryAttempts} <= ${table.maxDeliveryAttempts}`,
    ),
    check(
      "data_subject_request_email_challenge_code_check",
      sql`(${table.codeDigest} is null and ${table.codeKeyVersion} is null) or (${table.codeDigest} is not null and ${table.codeKeyVersion} > 0)`,
    ),
  ],
);

/** Immutable, case-scoped decision for one retained snapshot family.  The
 * backup path, image and command are deliberately not persisted here; the
 * trusted ops inventory is re-resolved at execution time. */
export const dataSubjectRequestBackupReview = pgTable(
  "data_subject_request_backup_review",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    backupId: text("backup_id").notNull(),
    manifestDigest: text("manifest_digest").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    platformVersion: text("platform_version").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code").notNull(),
    reviewedBy: text("reviewed_by").references(() => user.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("data_subject_request_backup_review_request_backup_idx").on(
      table.requestId,
      table.backupId,
    ),
    index("data_subject_request_backup_review_manifest_idx").on(table.manifestDigest),
    check(
      "data_subject_request_backup_review_decision_check",
      sql`${table.decision} in ('not_applicable', 'no_material_difference', 'extract', 'unavailable')`,
    ),
  ],
);

/** Immutable human release approval.  Findings are represented by a digest,
 * never as free-form legal or security notes in the case database. */
export const dataSubjectRequestApproval = pgTable(
  "data_subject_request_approval",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(),
    version: text("version").notNull(),
    approverUserId: text("approver_user_id").references(() => user.id, { onDelete: "set null" }),
    approverRole: text("approver_role").notNull(),
    decision: text("decision").notNull(),
    findingsDigest: text("findings_digest"),
    /** Transport idempotency key; nullable for approvals written before this
     * field was introduced, but mandatory at the route boundary for new
     * records. */
    idempotencyKey: text("idempotency_key"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("data_subject_request_approval_scope_idx").on(
      table.scope,
      table.version,
      table.expiresAt,
    ),
    uniqueIndex("data_subject_request_approval_idempotency_idx")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    check(
      "data_subject_request_approval_scope_check",
      sql`${table.scope} in ('legal-content', 'dsar-process', 'security-review')`,
    ),
    check(
      "data_subject_request_approval_decision_check",
      sql`${table.decision} in ('approved', 'rejected')`,
    ),
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
    ),
    index("data_subject_request_notification_state_idx").on(table.state, table.nextAttemptAt),
    index("data_subject_request_notification_recipient_idx").on(
      table.recipientUserId,
      table.createdAt,
    ),
    check(
      "data_subject_request_notification_template_check",
      sql`${table.template} in ('acknowledgement', 'clarification', 'extension', 'ready', 'delivered', 'closed', 'refused', 'escalation_due_soon', 'escalation_overdue', 'escalation_identity', 'escalation_extension', 'escalation_stuck')`,
    ),
    check("data_subject_request_notification_channel_check", sql`${table.channel} in ('email')`),
    check(
      "data_subject_request_notification_state_check",
      sql`${table.state} in ('pending', 'sending', 'sent', 'retryable', 'failed', 'canceled')`,
    ),
    check("data_subject_request_notification_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

// Descriptive aliases used by integrations and evidence tooling.
export const dataExportBackupReview = dataSubjectRequestBackupReview;
export const dataPrivacyApproval = dataSubjectRequestApproval;
