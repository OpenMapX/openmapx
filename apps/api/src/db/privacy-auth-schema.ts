import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { session, user } from "./auth-schema";
import { dataExportArtifact, dataSubjectRequest } from "./privacy-schema";

export const SESSION_AUTH_METHODS = [
  "password",
  "password_totp",
  "password_recovery",
  "passkey",
  "federated",
] as const;
export type SessionAuthMethod = (typeof SESSION_AUTH_METHODS)[number];
export const REAUTH_STATES = ["pending", "completed", "consumed", "superseded", "expired"] as const;
export type ReauthenticationState = (typeof REAUTH_STATES)[number];
export const REAUTH_CHANNELS = ["self_service", "assisted", "representative"] as const;
export type ReauthenticationChannel = (typeof REAUTH_CHANNELS)[number];

export const sessionAuthAssurance = pgTable(
  "session_auth_assurance",
  {
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    method: text("method").$type<SessionAuthMethod>().notNull(),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "session_auth_assurance_method_check",
      sql`${table.method} in ('password', 'password_totp', 'password_recovery', 'passkey', 'federated')`,
    ),
    index("session_auth_assurance_user_idx").on(table.userId, table.authenticatedAt),
  ],
);

export const dataExportReauthentication = pgTable(
  "data_export_reauthentication",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => dataSubjectRequest.id, { onDelete: "cascade" }),
    artifactId: uuid("artifact_id")
      .notNull()
      .references(() => dataExportArtifact.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    initiatingAdminUserId: text("initiating_admin_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    initiatingAdminSessionId: text("initiating_admin_session_id").references(() => session.id, {
      onDelete: "set null",
    }),
    deliveryChannel: text("delivery_channel")
      .$type<ReauthenticationChannel>()
      .notNull()
      .default("self_service"),
    startingSessionId: text("starting_session_id"),
    nonceDigest: text("nonce_digest").notNull(),
    state: text("state").$type<ReauthenticationState>().notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    completedSessionId: text("completed_session_id"),
    completedMethod: text("completed_method").$type<SessionAuthMethod>(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "data_export_reauthentication_state_check",
      sql`${table.state} in ('pending', 'completed', 'consumed', 'superseded', 'expired')`,
    ),
    check(
      "data_export_reauthentication_channel_check",
      sql`${table.deliveryChannel} in ('self_service', 'assisted', 'representative')`,
    ),
    check(
      "data_export_reauthentication_method_check",
      sql`${table.completedMethod} is null or ${table.completedMethod} in ('password', 'password_totp', 'password_recovery', 'passkey', 'federated')`,
    ),
    index("data_export_reauthentication_user_expiry_idx").on(table.userId, table.expiresAt),
    index("data_export_reauthentication_artifact_state_idx").on(table.artifactId, table.state),
    uniqueIndex("data_export_reauthentication_active_idx")
      .on(table.requestId, table.artifactId, table.userId)
      .where(sql`${table.state} in ('pending', 'completed')`),
  ],
);
