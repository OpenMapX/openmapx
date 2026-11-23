import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { session, user } from "./auth-schema";

export const SESSION_AUTH_METHODS = [
  "password",
  "password_totp",
  "password_recovery",
  "passkey",
  "federated",
] as const;
export type SessionAuthMethod = (typeof SESSION_AUTH_METHODS)[number];

export const sessionAuthAssurance = pgTable(
  "session_auth_assurance",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id"),
    method: text("method").$type<SessionAuthMethod>().notNull(),
    originIndependentPasswordLogin: boolean("origin_independent_password_login")
      .notNull()
      .default(false),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: "session_auth_assurance_session_id_fkey",
      columns: [table.sessionId],
      foreignColumns: [session.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "session_auth_assurance_user_id_fkey",
      columns: [table.userId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    check(
      "session_auth_assurance_method_check",
      sql`${table.method} in ('password', 'password_totp', 'password_recovery', 'passkey', 'federated')`,
    ),
    index("session_auth_assurance_user_id_authenticated_at_idx").on(
      table.userId,
      table.authenticatedAt,
    ),
  ],
);
