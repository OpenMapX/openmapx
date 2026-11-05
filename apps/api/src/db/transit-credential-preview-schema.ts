/** Private encrypted transit credential proposals. Never exposed as admin-job payloads. */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export const transitCredentialPreview = pgTable(
  "transit_credential_preview",
  {
    id: uuid("id").primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    operationKey: text("operation_key").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    authorizationCiphertext: text("authorization_ciphertext"),
    authorizationIv: text("authorization_iv"),
    authorizationTag: text("authorization_tag"),
    candidateId: uuid("candidate_id"),
    credentialsRevision: text("credentials_revision"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("transit_credential_preview_actor_key_uq").on(t.actorId, t.operationKey),
    index("transit_credential_preview_expiry_idx").on(t.expiresAt),
    check(
      "transit_credential_preview_bounds",
      sql`octet_length(${t.ciphertext}) <= 1500000 and length(${t.intentFingerprint}) = 64 and length(${t.iv}) = 16 and length(${t.tag}) = 24`,
    ),
  ],
);
