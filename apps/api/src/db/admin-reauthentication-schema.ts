import type { AdminReauthPurpose } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import type { ReauthenticationState, SessionAuthMethod } from "./privacy-auth-schema";
export const adminActionReauthentication = pgTable(
  "admin_action_reauthentication",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: text("actor_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
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
    check(
      "admin_reauth_state_check",
      sql`${t.state} in ('pending','completed','consumed','superseded','expired')`,
    ),
    check(
      "admin_reauth_purpose_check",
      sql`${t.purpose} in ('account.verify','account.password.set','account.reset.send','account.invite','credentials.export','credentials.import','transit.credentials','platform.domain.apply')`,
    ),
    index("admin_reauth_actor_expiry_idx").on(t.actorId, t.expiresAt),
    uniqueIndex("admin_reauth_request_uq").on(t.actorId, t.requestKey),
  ],
);
