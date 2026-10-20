import { randomUUID } from "node:crypto";
import type { AdminIntegrationConfigEntry } from "@openmapx/core/api-contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { integrationConfig } from "../db/schema";
import type { PersistedIntegrationImport } from "./integration-config-import";

// PostgreSQL's tuple version changes on EVERY write, including writers outside this
// module. Paired with the immutable row identity it detects delete/reinsert and ABA
// within this bounded request. It is not a durable revision/transaction framework.
const version = sql<string>`xmin::text`;
const projection = {
  id: integrationConfig.id,
  integrationId: integrationConfig.integrationId,
  config: integrationConfig.config,
  version,
};
class OwnershipConflict extends Error {}
export async function persistIntegrationImport(
  entries: AdminIntegrationConfigEntry[],
): Promise<PersistedIntegrationImport> {
  return persistIntegrationConfigs(entries, "replace");
}

/** Ordinary edits carry partial intent, merged only after acquiring the row lock. */
export async function persistIntegrationConfigPatch(
  entry: AdminIntegrationConfigEntry,
): Promise<PersistedIntegrationImport> {
  return persistIntegrationConfigs([entry], "merge");
}

async function persistIntegrationConfigs(
  entries: AdminIntegrationConfigEntry[],
  mode: "replace" | "merge",
): Promise<PersistedIntegrationImport> {
  const ids = entries.map((e) => e.integrationId).sort();
  const saved = await db.transaction(async (tx) => {
    const previous = await tx
      .select(projection)
      .from(integrationConfig)
      .where(inArray(integrationConfig.integrationId, ids))
      .orderBy(integrationConfig.integrationId)
      .for("update");
    const byId = new Map(previous.map((row) => [row.integrationId, row]));
    const owned: Array<(typeof previous)[number]> = [];
    for (const entry of [...entries].sort((a, b) =>
      a.integrationId.localeCompare(b.integrationId),
    )) {
      const old = byId.get(entry.integrationId);
      const config = {
        ...(mode === "merge" ? old?.config : {}),
        ...entry.config,
        ...(!Object.hasOwn(entry.config, "enabled") && typeof old?.config.enabled === "boolean"
          ? { enabled: old.config.enabled }
          : {}),
      };
      const rows = old
        ? await tx
            .update(integrationConfig)
            .set({ config, updatedAt: new Date() })
            .where(eq(integrationConfig.id, old.id))
            .returning(projection)
        : await tx
            .insert(integrationConfig)
            .values({ id: randomUUID(), integrationId: entry.integrationId, config })
            .onConflictDoNothing()
            .returning(projection);
      if (rows.length !== 1) throw new OwnershipConflict();
      owned.push(rows[0]);
    }
    return {
      previous: entries.map((entry) => ({
        integrationId: entry.integrationId,
        config: byId.get(entry.integrationId)?.config ?? null,
      })),
      owned,
    };
  });
  let expectedRows = saved.owned;
  let absentIds: string[] = [];
  return {
    previous: saved.previous,
    async owns() {
      const current = await db
        .select(projection)
        .from(integrationConfig)
        .where(inArray(integrationConfig.integrationId, ids));
      return (
        expectedRows.every((owned) =>
          current.some((row) => row.id === owned.id && row.version === owned.version),
        ) && absentIds.every((id) => !current.some((row) => row.integrationId === id))
      );
    },
    async restore() {
      try {
        const restoredRows = await db.transaction(async (tx) => {
          const updated: typeof saved.owned = [];
          for (const owned of saved.owned) {
            const old = saved.previous.find((row) => row.integrationId === owned.integrationId);
            if (!old) throw new OwnershipConflict();
            const condition = and(
              eq(integrationConfig.id, owned.id),
              sql`${version} = ${owned.version}`,
            );
            const rows =
              old.config === null
                ? await tx
                    .delete(integrationConfig)
                    .where(condition)
                    .returning({ id: integrationConfig.id })
                : await tx
                    .update(integrationConfig)
                    .set({ config: old.config, updatedAt: new Date() })
                    .where(condition)
                    .returning(projection);
            if (rows.length !== 1) throw new OwnershipConflict();
            if (old.config !== null) updated.push(rows[0] as (typeof saved.owned)[number]);
          }
          return updated;
        });
        expectedRows = restoredRows;
        absentIds = saved.previous
          .filter((row) => row.config === null)
          .map((row) => row.integrationId);
        return true;
      } catch (error) {
        if (error instanceof OwnershipConflict) return false;
        throw error;
      }
    },
  };
}
