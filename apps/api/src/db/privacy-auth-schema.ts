import { sql } from "drizzle-orm";
import { boolean, check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
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
    sessionId: text("session_id")
      .primaryKey()
      .references(() => session.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    method: text("method").$type<SessionAuthMethod>().notNull(),
    originIndependentPasswordLogin: boolean("origin_independent_password_login")
      .notNull()
      .default(false),
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
