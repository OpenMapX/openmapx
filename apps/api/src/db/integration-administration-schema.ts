import type { IntegrationApplyReceipt } from "@openmapx/core/api-contracts";
import { foreignKey, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
/** Retained across unbinding, so a delete/reinsert cannot restore an old CAS token. */
export const integrationBindingRevision = pgTable("integration_binding_revision", {
  integrationId: text("integration_id").primaryKey(),
  version: uuid("version").defaultRandom().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
/** Inserted in the same candidate transaction as the desired binding. */
export const integrationApplicationReceipt = pgTable(
  "integration_application_receipt",
  {
    operationId: text("operation_id").primaryKey(),
    actorId: text("actor_id"),
    integrationId: text("integration_id").notNull(),
    capability: text("capability").notNull(),
    serviceId: text("service_id"),
    candidateId: uuid("candidate_id").notNull(),
    intentDigest: text("intent_digest").notNull(),
    savedBindingRevision: text("saved_binding_revision").notNull(),
    result: jsonb("result").$type<IntegrationApplyReceipt>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: "integration_application_receipt_actor_id_fkey",
      columns: [t.actorId],
      foreignColumns: [user.id],
    }).onDelete("set null"),
    index("integration_application_receipt_integration_id_created_at_idx").on(
      t.integrationId,
      t.createdAt,
    ),
    index("integration_application_receipt_actor_id_idx").on(t.actorId),
    index("integration_application_receipt_created_at_idx").on(t.createdAt),
  ],
);
