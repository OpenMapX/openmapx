/** Private encrypted transit credential proposals. Never exposed as admin-job payloads. */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export const transitCredentialPreview = pgTable(
  "transit_credential_preview",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorUserId: text("actor_user_id").notNull(),
    operationKey: text("operation_key").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    authorizationCiphertext: text("authorization_ciphertext"),
    authorizationIv: text("authorization_iv"),
    authorizationTag: text("authorization_tag"),
    authorizationKeyVersion: integer("authorization_key_version"),
    candidateId: uuid("candidate_id"),
    credentialsRevision: text("credentials_revision"),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "transit_credential_preview_actor_user_id_fkey",
      columns: [t.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    uniqueIndex("transit_credential_preview_actor_user_id_operation_key_key").on(
      t.actorUserId,
      t.operationKey,
    ),
    index("transit_credential_preview_expires_at_idx").on(t.expiresAt),
    check(
      "transit_credential_preview_bounds_check",
      sql`octet_length(${t.ciphertext}) <= 1500000 and length(${t.intentFingerprint}) = 64 and length(${t.iv}) = 16 and length(${t.tag}) = 24`,
    ),
    check(
      "transit_credential_preview_authorization_check",
      sql`(${t.authorizationCiphertext} is null and ${t.authorizationIv} is null and ${t.authorizationTag} is null and ${t.authorizationKeyVersion} is null) or (${t.authorizationCiphertext} is not null and ${t.authorizationIv} is not null and ${t.authorizationTag} is not null and ${t.authorizationKeyVersion} is not null)`,
    ),
  ],
);
