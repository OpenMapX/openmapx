import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const healthHistory = pgTable(
  "health_history",
  {
    id: serial("id").primaryKey(),
    serviceId: text("service_id").notNull(),
    status: text("status").notNull(), // healthy | unhealthy | degraded | error
    responseTime: integer("response_time"), // ms
    error: text("error"),
    checkedAt: timestamp("checked_at").defaultNow().notNull(),
  },
  (table) => [index("healthHistory_serviceId_checkedAt_idx").on(table.serviceId, table.checkedAt)],
);
