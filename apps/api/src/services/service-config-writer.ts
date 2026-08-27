import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
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

export async function readStoredServiceConfig(
  serviceId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ config: serviceConfig.config })
    .from(serviceConfig)
    .where(eq(serviceConfig.serviceId, serviceId))
    .limit(1);
  return (row?.config as Record<string, unknown> | undefined) ?? null;
}

export async function restoreStoredServiceConfig(
  serviceId: string,
  value: Record<string, unknown> | null,
): Promise<void> {
  if (value === null) {
    await db.delete(serviceConfig).where(eq(serviceConfig.serviceId, serviceId));
    return;
  }
  await db
    .insert(serviceConfig)
    .values({ id: randomUUID(), serviceId, config: value })
    .onConflictDoUpdate({
      target: serviceConfig.serviceId,
      set: { config: value, updatedAt: new Date() },
    });
}
