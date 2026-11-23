/** Encrypted, actor-bound configuration and credential migration previews. */
import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

export const configurationMigrationPreview = pgTable(
  "configuration_migration_preview",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: text("actor_id").notNull(),
    kind: text("kind").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedByJobId: uuid("consumed_by_job_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "configuration_migration_preview_actor_id_fkey",
      columns: [t.actorId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    index("configuration_migration_preview_actor_id_kind_idx").on(t.actorId, t.kind),
    index("configuration_migration_preview_expires_at_idx").on(t.expiresAt),
    check(
      "configuration_migration_preview_bounds_check",
      sql`${t.kind} in ('migration','credentials') and ${t.intentFingerprint} ~ '^[a-f0-9]{64}$' and octet_length(${t.ciphertext}) <= 1572864 and length(${t.iv}) = 16 and length(${t.tag}) = 24 and ${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`,
    ),
  ],
);
