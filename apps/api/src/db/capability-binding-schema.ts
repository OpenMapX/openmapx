import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const capabilityBinding = pgTable(
  "capability_binding",
  {
    integrationId: text("integration_id").notNull(),
    capability: text("capability").notNull(),
    serviceId: text("service_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "capability_binding_pkey", columns: [t.integrationId, t.capability] }),
  ],
);

export type CapabilityBindingRow = typeof capabilityBinding.$inferSelect;
