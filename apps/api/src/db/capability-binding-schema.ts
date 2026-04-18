import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

export const capabilityBinding = pgTable(
  "capability_binding",
  {
    integrationId: text("integration_id").notNull(),
    capability: text("capability").notNull(),
    serviceId: text("service_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.integrationId, t.capability] }),
    index("idx_capability_binding_service").on(t.serviceId),
  ],
);

export type CapabilityBindingRow = typeof capabilityBinding.$inferSelect;
