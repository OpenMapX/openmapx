import { NOTABLE_PLACES_SCHEMA_VERSION } from "@openmapx/core/published-data";
import type { HealthCheckResult, IntegrationContext } from "@openmapx/integration-framework";
import { createNotablePlacesSuggestionProvider } from "./provider.js";

interface HealthRow {
  relation: string | null;
  status?: string;
  schema_version?: number;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerSearchSuggestionProvider(createNotablePlacesSuggestionProvider(ctx));
  ctx.registerHealthCheck(async (): Promise<HealthCheckResult> => {
    if (!ctx.db) return { status: "unconfigured", error: "PostGIS is not configured" };
    const startedAt = Date.now();
    try {
      const relation = await ctx.db.execute<HealthRow[]>(
        "SELECT to_regclass('notable_places.index_state')::TEXT AS relation",
      );
      if (!relation[0]?.relation) {
        return { status: "unconfigured", responseTime: Date.now() - startedAt };
      }
      const rows = await ctx.db.execute<HealthRow[]>(
        "SELECT status, schema_version FROM notable_places.index_state WHERE singleton = 1",
      );
      if (rows[0]?.status !== "ready") {
        return {
          status: "down",
          responseTime: Date.now() - startedAt,
          error: "No ready notable-places index is published",
        };
      }
      if (rows[0].schema_version !== NOTABLE_PLACES_SCHEMA_VERSION) {
        return {
          status: "down",
          responseTime: Date.now() - startedAt,
          error: "The notable-places index has an outdated layout and awaits its rebuild",
        };
      }
      return { status: "up", responseTime: Date.now() - startedAt };
    } catch (error) {
      return {
        status: "down",
        responseTime: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Notable-places health check failed",
      };
    }
  });
}
