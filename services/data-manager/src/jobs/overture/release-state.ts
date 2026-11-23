import { overtureRelease } from "@openmapx/db-schema";
import { drizzle } from "drizzle-orm/postgres-js";
import type postgres from "postgres";
import { assertDataPublication } from "../execution/worker-scope.js";
import type { RebuildOvertureLinksResult } from "./rebuild-links.js";

/**
 * Records the Overture places release a region now serves. A failed write is
 * logged and does not fail the sync: the release is already live.
 */
export async function writeOvertureRelease(
  sql: postgres.Sql,
  region: string,
  release: string,
  conflation: RebuildOvertureLinksResult["status"],
  log: { warn: (message: string, extra?: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await assertDataPublication();
    const values = {
      release,
      importedAt: new Date(),
      status:
        conflation === "completed" || conflation === "already_completed"
          ? "imported"
          : "links_pending",
    };
    await drizzle(sql)
      .insert(overtureRelease)
      .values({ region, ...values })
      .onConflictDoUpdate({ target: overtureRelease.region, set: values });
  } catch (err) {
    log.warn("overture-cron: overture_release write failed", { err: (err as Error).message });
  }
}
