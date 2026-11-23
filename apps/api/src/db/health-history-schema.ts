import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const healthHistory = pgTable(
  "health_history",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    serviceId: text("service_id").notNull(),
    status: text("status").notNull(),
    responseTime: integer("response_time"), // ms
    error: text("error"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "health_history_status_check",
      sql`${table.status} in ('healthy','degraded','unhealthy','error')`,
    ),
    index("health_history_service_id_checked_at_idx").on(table.serviceId, table.checkedAt),
    // Retention prunes by age across every service.
    index("health_history_checked_at_idx").on(table.checkedAt),
  ],
);
