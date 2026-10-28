import type { AccountMailOutcome } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export type AccountAction =
  | "create"
  | "invitation"
  | "verification-email"
  | "reset-password"
  | "verify"
  | "password"
  | "role";
export type AccountMailKind = "verification" | "password_setup";
export const accountActionReceipt = pgTable(
  "account_action_receipt",
  {
    key: text("key").primaryKey(),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    targetId: text("target_id").references(() => user.id, { onDelete: "set null" }),
    action: text("action").$type<AccountAction>().notNull(),
    intentDigest: text("intent_digest").notNull(),
    result: jsonb("result").$type<{
      created: boolean;
      role?: "user" | "admin" | "privacy_admin";
      changed?: boolean;
      verificationDelivery?: AccountMailOutcome;
      passwordSetupDelivery?: AccountMailOutcome;
    }>(),
    mailRequested: boolean("mail_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("account_action_actor_time_idx").on(t.actorId, t.createdAt),
    index("account_action_target_time_idx").on(t.targetId, t.createdAt),
  ],
);
export const accountMailOutbox = pgTable(
  "account_mail_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestKey: text("request_key")
      .notNull()
      .references(() => accountActionReceipt.key, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AccountMailKind>().notNull(),
    state: text("state")
      .$type<Exclude<AccountMailOutcome, "not_requested"> | "sending">()
      .notNull()
      .default("queued"),
    ciphertext: text("ciphertext"),
    iv: text("iv"),
    tag: text("tag"),
    attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("account_mail_action_kind_uq").on(t.requestKey, t.kind),
    index("account_mail_pending_idx").on(t.state, t.createdAt),
    check(
      "account_mail_state_check",
      sql`${t.state} in ('queued','sending','sent','failed','unknown')`,
    ),
    check("account_mail_kind_check", sql`${t.kind} in ('verification','password_setup')`),
  ],
);
