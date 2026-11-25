import {
  currentOvertureSnapshot,
  OVERTURE_PLACES_SCHEMA_VERSION,
} from "@openmapx/core/published-data";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { bindDb, overtureKnowledgeSource } from "./provider.js";

export { overtureKnowledgeSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const db = ctx.db;
  if (!db) {
    ctx.log.warn("[knowledge-overture] ctx.db undefined — manifest must require postgis");
    return;
  }

  bindDb(db, ctx);

  ctx.registerHealthCheck(async () => {
    try {
      const rows = await db.execute<unknown[]>(
        `SELECT 1 FROM overture_places.places AS places
          WHERE ${currentOvertureSnapshot("places", 1)} LIMIT 1`,
        [OVERTURE_PLACES_SCHEMA_VERSION],
      );
      if (Array.isArray(rows) && rows.length > 0) return { status: "up" as const };
      return {
        status: "down" as const,
        error: "No Overture places of the current layout; awaiting their import",
      };
    } catch {
      return { status: "down" as const, error: "overture_places not ingested" };
    }
  });

  ctx.registerKnowledgeProvider(overtureKnowledgeSource);
}
