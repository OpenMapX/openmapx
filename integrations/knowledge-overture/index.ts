import type { IntegrationContext } from "@openmapx/integration-framework";
import { bindDb, overtureKnowledgeSource } from "./provider.js";

export { overtureKnowledgeSource } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const db = ctx.db;
  if (!db) {
    ctx.log.warn("[knowledge-overture] ctx.db undefined — manifest must require postgis");
    return;
  }

  bindDb(db);

  ctx.registerHealthCheck(async () => {
    try {
      await db.execute("SELECT 1 FROM overture_places.places LIMIT 1");
      return { status: "up" as const };
    } catch {
      return { status: "down" as const, error: "overture_places not ingested" };
    }
  });

  ctx.registerKnowledgeProvider(overtureKnowledgeSource);
}
