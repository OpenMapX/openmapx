import {
  ACCOUNT_ACTIONS,
  ACCOUNT_MAIL_KINDS,
  type AccountAction,
  type AccountMailKind,
  type AccountMailOutcome,
} from "@openmapx/core/api-contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
import { oneOf } from "./closed-value-check";

export type { AccountAction };
export const accountActionReceipt = pgTable(
  "account_action_receipt",
  {
    key: text("key").primaryKey(),
    actorUserId: text("actor_user_id"),
    targetUserId: text("target_user_id"),
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
      name: "account_action_receipt_actor_user_id_fkey",
      columns: [t.actorUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    foreignKey({
      name: "account_action_receipt_target_user_id_fkey",
      columns: [t.targetUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("account_action_receipt_actor_user_id_created_at_idx").on(t.actorUserId, t.createdAt),
    index("account_action_receipt_target_user_id_created_at_idx").on(t.targetUserId, t.createdAt),
    index("account_action_receipt_created_at_idx").on(t.createdAt),
    check("account_action_receipt_action_check", oneOf(t.action, ACCOUNT_ACTIONS)),
  ],
);
export const accountMailOutbox = pgTable(
  "account_mail_outbox",
  {
    id: uuid("id").primaryKey().default(sql`uuidv7()`),
    requestKey: text("request_key").notNull(),
    userId: text("user_id").notNull(),
    kind: text("kind").$type<AccountMailKind>().notNull(),
    status: text("status")
      .$type<Exclude<AccountMailOutcome, "not_requested"> | "sending">()
      .notNull()
      .default("queued"),
    ciphertext: text("ciphertext"),
    iv: text("iv"),
    tag: text("tag"),
    keyVersion: integer("key_version"),
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
    index("account_mail_outbox_status_created_at_idx").on(t.status, t.createdAt),
    index("account_mail_outbox_user_id_idx").on(t.userId),
    check(
      "account_mail_outbox_status_check",
      sql`${t.status} in ('queued','sending','sent','failed','unknown')`,
    ),
    check("account_mail_outbox_kind_check", oneOf(t.kind, ACCOUNT_MAIL_KINDS)),
    check(
      "account_mail_outbox_sealed_check",
      sql`(${t.ciphertext} is null and ${t.iv} is null and ${t.tag} is null and ${t.keyVersion} is null) or (${t.ciphertext} is not null and ${t.iv} is not null and ${t.tag} is not null and ${t.keyVersion} is not null)`,
    ),
  ],
);
