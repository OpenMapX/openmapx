import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { serviceConfig } from "../db/schema.js";

/**
 * Atomically merge already-validated service configuration values.
 *
 * Validation belongs at the HTTP or provisioning boundary. The JSONB merge is
 * performed by PostgreSQL in the conflict update so concurrent writers never
 * replace keys that were committed after either writer began.
 */
export async function mergeServiceConfig(
  serviceId: string,
  updates: Record<string, unknown>,
): Promise<void> {
  await db
    .insert(serviceConfig)
    .values({ id: randomUUID(), serviceId, config: updates })
    .onConflictDoUpdate({
      target: serviceConfig.serviceId,
      set: {
        config: sql<
          Record<string, unknown>
        >`coalesce(${serviceConfig.config}, '{}'::jsonb) || excluded.${sql.identifier("config")}`,
        updatedAt: new Date(),
      },
    });
}
