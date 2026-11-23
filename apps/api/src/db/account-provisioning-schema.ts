import type { AccountMailOutcome } from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
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
    actorId: text("actor_id"),
    targetId: text("target_id"),
    action: text("action").$type<AccountAction>().notNull(),
    intentDigest: text("intent_digest").notNull(),
    result: jsonb("result").$type<{
      created: boolean;
      role?: "user" | "admin";
      changed?: boolean;
      verificationDelivery?: AccountMailOutcome;
      passwordSetupDelivery?: AccountMailOutcome;
    }>(),
    mailRequested: boolean("mail_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "account_action_receipt_actor_id_fkey",
      columns: [t.actorId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "account_action_receipt_target_id_fkey",
      columns: [t.targetId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("account_action_receipt_actor_id_created_at_idx").on(t.actorId, t.createdAt),
    index("account_action_receipt_target_id_created_at_idx").on(t.targetId, t.createdAt),
    check(
      "account_action_receipt_action_check",
      sql`${t.action} in ('create','invitation','verification-email','reset-password','verify','password','role')`,
    ),
  ],
);
export const accountMailOutbox = pgTable(
  "account_mail_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    requestKey: text("request_key").notNull(),
    userId: text("user_id").notNull(),
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
    foreignKey({
      name: "account_mail_outbox_request_key_fkey",
      columns: [t.requestKey],
      foreignColumns: [accountActionReceipt.key],
    }).onDelete("cascade"),
    foreignKey({
      name: "account_mail_outbox_user_id_fkey",
      columns: [t.userId],
      foreignColumns: [user.id],
    }).onDelete("cascade"),
    uniqueIndex("account_mail_outbox_request_key_kind_key").on(t.requestKey, t.kind),
    index("account_mail_outbox_state_created_at_idx").on(t.state, t.createdAt),
    index("account_mail_outbox_user_id_idx").on(t.userId),
    check(
      "account_mail_outbox_state_check",
      sql`${t.state} in ('queued','sending','sent','failed','unknown')`,
    ),
    check("account_mail_outbox_kind_check", sql`${t.kind} in ('verification','password_setup')`),
  ],
);
