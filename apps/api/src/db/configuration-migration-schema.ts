/** Encrypted, actor-bound configuration and credential migration previews. */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const configurationMigrationPreview = pgTable(
  "configuration_migration_preview",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedByJobId: text("consumed_by_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("configuration_migration_preview_actor_kind_idx").on(t.actorId, t.kind),
    index("configuration_migration_preview_expiry_idx").on(t.expiresAt),
    check(
      "configuration_migration_preview_bounds",
      sql`${t.kind} in ('migration','credentials') and length(${t.id}) = 36 and ${t.intentFingerprint} ~ '^[a-f0-9]{64}$' and octet_length(${t.ciphertext}) <= 1572864 and length(${t.iv}) = 16 and length(${t.tag}) = 24 and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes' and (${t.consumedByJobId} is null or length(${t.consumedByJobId}) = 36)`,
    ),
  ],
);
