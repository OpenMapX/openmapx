import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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

/** A request-local inverse. Prior values and tuple ownership never leave this handle. */
export interface PersistedServiceConfigPatch {
  restore(): Promise<boolean>;
}

// xmin changes even on equal-value writes. Pair it with immutable row identity
// for this bounded request only; it is not a durable revision (transaction IDs wrap).
const version = sql<string>`xmin::text`;
const projection = { id: serviceConfig.id, config: serviceConfig.config, version };

export async function persistServiceConfigPatch(
  serviceId: string,
  updates: Record<string, unknown>,
): Promise<PersistedServiceConfigPatch> {
  const { previous, owned } = await db.transaction(async (tx) => {
    const [previous] = await tx
      .select(projection)
      .from(serviceConfig)
      .where(eq(serviceConfig.serviceId, serviceId))
      .for("update");
    const config = { ...previous?.config, ...updates };
    const rows = previous
      ? await tx
          .update(serviceConfig)
          .set({ config, updatedAt: new Date() })
          .where(eq(serviceConfig.id, previous.id))
          .returning(projection)
      : await tx
          .insert(serviceConfig)
          .values({ id: randomUUID(), serviceId, config })
          .onConflictDoNothing()
          .returning(projection);
    const [owned] = rows;
    // Missing-row races never adopt or overwrite the winner. Missing evidence
    // aborts this transaction, before any host operation can be attempted.
    if (rows.length !== 1 || !owned.id || !owned.version) {
      throw new Error("Service configuration ownership unavailable");
    }
    return { previous, owned };
  }); // Commit and release row ownership BEFORE invoking the host.

  return {
    async restore() {
      // The predicate is part of the writing SQL: a waiting UPDATE/DELETE must
      // recheck both identity and version after the competing writer commits.
      const condition = and(eq(serviceConfig.id, owned.id), sql`${version} = ${owned.version}`);
      const rows = previous
        ? await db
            .update(serviceConfig)
            .set({ config: previous.config, updatedAt: new Date() })
            .where(condition)
            .returning({ id: serviceConfig.id })
        : await db.delete(serviceConfig).where(condition).returning({ id: serviceConfig.id });
      return rows.length === 1;
    },
  };
}
