import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * Encrypted operator secrets for self-hosted *services* (the container track),
 * mirroring `integration_secret` for the in-process integration track. Values
 * are AES-256-GCM encrypted at rest with the API's secrets key; the render
 * step decrypts them into mounted secret files (Docker `secrets:`), never into
 * the container environment.
 */
export const serviceSecret = pgTable(
  "service_secret",
  {
    serviceId: text("service_id").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedByUserId: text("updated_by_user_id"),
  },
  (table) => [
    primaryKey({ name: "service_secret_pkey", columns: [table.serviceId, table.key] }),
    foreignKey({
      name: "service_secret_updated_by_user_id_fkey",
      columns: [table.updatedByUserId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("service_secret_updated_by_user_id_idx").on(table.updatedByUserId),
  ],
);
