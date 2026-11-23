import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/** Unique per external operation; recording one twice raises this index. */
export const DATA_DISCLOSURE_EVENT_IDEMPOTENCY_KEY = "data_disclosure_event_idempotency_key_key";

/** Minimal account-linked recipient ledger; payloads and query content are intentionally absent. */
export const dataDisclosureEvent = pgTable(
  "data_disclosure_event",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    userId: text("user_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recipientId: text("recipient_id").notNull(),
    recipientName: text("recipient_name").notNull(),
    recipientRole: text("recipient_role").notNull(),
    recipientCountry: text("recipient_country"),
    recipientPrivacyUrl: text("recipient_privacy_url"),
    integrationId: text("integration_id"),
    operationCode: text("operation_code").notNull(),
    categoryCode: text("category_code").notNull(),
    purposeCode: text("purpose_code").notNull(),
    legalBasisCode: text("legal_basis_code").notNull(),
    transferSafeguardCode: text("transfer_safeguard_code"),
    externalReferenceDigest: text("external_reference_digest"),
    /** Stable external operation identifier; null for non-repeatable events. */
    idempotencyKey: text("idempotency_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "data_disclosure_event_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("data_disclosure_event_user_id_occurred_at_idx").on(table.userId, table.occurredAt),
    index("data_disclosure_event_recipient_id_occurred_at_idx").on(
      table.recipientId,
      table.occurredAt,
    ),
    index("data_disclosure_event_occurred_at_idx").on(table.occurredAt),
    uniqueIndex(DATA_DISCLOSURE_EVENT_IDEMPOTENCY_KEY)
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    check(
      "data_disclosure_event_code_check",
      sql`${table.recipientId} ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and ${table.operationCode} ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and ${table.categoryCode} ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and ${table.purposeCode} ~ '^[a-z0-9][a-z0-9._-]{0,127}$' and ${table.legalBasisCode} ~ '^[a-z0-9][a-z0-9._-]{0,127}$'`,
    ),
  ],
);

export type DataDisclosureEvent = typeof dataDisclosureEvent.$inferSelect;
