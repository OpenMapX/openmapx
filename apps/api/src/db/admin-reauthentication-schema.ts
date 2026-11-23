import type { AdminReauthPurpose } from "@openmapx/core/api-contracts";
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
import type { SessionAuthMethod } from "./privacy-auth-schema";

type ReauthenticationState = "pending" | "completed" | "consumed" | "superseded" | "expired";
export const adminActionReauthentication = pgTable(
  "admin_action_reauthentication",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    actorId: text("actor_id").notNull(),
    startingSessionId: text("starting_session_id").notNull(),
    purpose: text("purpose").$type<AdminReauthPurpose>().notNull(),
    targetId: text("target_id").notNull(),
    intentFingerprint: text("intent_fingerprint"),
    nonceDigest: text("nonce_digest").notNull(),
    requestKey: text("request_key"),
    authPolicyRevision: text("auth_policy_revision"),
    state: text("state").$type<ReauthenticationState>().default("pending").notNull(),
    completedSessionId: text("completed_session_id"),
    completedMethod: text("completed_method").$type<SessionAuthMethod>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "admin_action_reauthentication_actor_id_fkey",
      columns: [t.actorId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    check(
      "admin_action_reauthentication_state_check",
      sql`${t.state} in ('pending','completed','consumed','superseded','expired')`,
    ),
    check(
      "admin_action_reauthentication_purpose_check",
      sql`${t.purpose} in ('account.verify','account.password.set','account.reset.send','account.invite','credentials.export','credentials.import','transit.credentials','platform.domain.apply','privacy.export')`,
    ),
    check(
      "admin_action_reauthentication_completed_method_check",
      sql`${t.completedMethod} in ('password','password_totp','password_recovery','passkey','federated')`,
    ),
    index("admin_action_reauthentication_actor_id_expires_at_idx").on(t.actorId, t.expiresAt),
    index("admin_action_reauthentication_expires_at_idx").on(t.expiresAt),
    uniqueIndex("admin_action_reauthentication_actor_id_request_key_key").on(
      t.actorId,
      t.requestKey,
    ),
  ],
);
