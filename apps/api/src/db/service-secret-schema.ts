import { index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";

/**
 * Encrypted operator secrets for self-hosted *services* (the container track),
 * mirroring `integration_secret` for the in-process integration track. Values
 * are AES-256-GCM encrypted at rest with `OPENMAPX_SECRETS_KEY`; the render
 * step decrypts them into mounted secret files (Docker `secrets:`), never into
 * the container environment.
 */
export const serviceSecret = pgTable(
  "service_secret",
  {
    id: text("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    key: text("key").notNull(),
    ciphertext: text("ciphertext").notNull(),
    iv: text("iv").notNull(),
    tag: text("tag").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    updatedBy: text("updated_by").references(() => user.id, { onDelete: "set null" }),
  },
  (table) => [
    index("serviceSecret_serviceId_idx").on(table.serviceId),
    unique("serviceSecret_serviceId_key_unq").on(table.serviceId, table.key),
  ],
);
