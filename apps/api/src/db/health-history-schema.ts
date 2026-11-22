import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const healthHistory = pgTable(
  "health_history",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    serviceId: text("service_id").notNull(),
    status: text("status").notNull(), // healthy | unhealthy | degraded | error
    responseTime: integer("response_time"), // ms
    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("healthHistory_serviceId_checkedAt_idx").on(table.serviceId, table.checkedAt)],
);
