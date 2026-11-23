/** Non-secret exact platform intent retained for actor-bound confirmation. */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export const platformConfigurationPreview = pgTable(
  "platform_configuration_preview",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: text("actor_id").notNull(),
    operationKey: text("operation_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    previewFingerprint: text("preview_fingerprint").notNull(),
    authPolicyRevision: text("auth_policy_revision").notNull(),
    sourceRevision: uuid("source_revision").notNull(),
    expectedCurrentRevisionId: text("expected_current_revision_id"),
    preview: jsonb("preview").notNull(),
    consumedByJobId: uuid("consumed_by_job_id"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "platform_configuration_preview_actor_id_fkey",
      columns: [t.actorId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    uniqueIndex("platform_configuration_preview_actor_id_operation_key_key").on(
      t.actorId,
      t.operationKey,
    ),
    uniqueIndex("platform_configuration_preview_preview_fingerprint_key").on(t.previewFingerprint),
    index("platform_configuration_preview_expires_at_idx").on(t.expiresAt),
    check(
      "platform_configuration_preview_bounds_check",
      sql`length(${t.operationKey}) between 1 and 128 and ${t.requestFingerprint} ~ '^[a-f0-9]{64}$' and ${t.previewFingerprint} ~ '^[a-f0-9]{64}$' and ${t.authPolicyRevision} ~ '^[a-f0-9]{64}$' and octet_length(${t.preview}::text) <= 131072 and jsonb_typeof(${t.preview}) = 'object' and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes' and ((${t.consumedAt} is null) = (${t.consumedByJobId} is null)) and (${t.retiredAt} is null or (${t.consumedAt} is not null and ${t.retiredAt} >= ${t.consumedAt}))`,
    ),
  ],
);
