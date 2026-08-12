import type { HealthCheckResult, IntegrationContext } from "@openmapx/integration-framework";
import { createOsmAliasSuggestionProvider } from "./provider.js";

interface HealthRow {
  relation: string | null;
  status?: string;
  source_fingerprint?: string;
  current_fingerprint?: string;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerSearchSuggestionProvider(createOsmAliasSuggestionProvider(ctx));
  ctx.registerHealthCheck(async (): Promise<HealthCheckResult> => {
    if (!ctx.db) return { status: "unconfigured", error: "PostGIS is not configured" };
    const startedAt = Date.now();
    try {
      const relation = await ctx.db.execute<HealthRow[]>(
        "SELECT to_regclass('osm_search.index_state')::TEXT AS relation",
      );
      if (!relation[0]?.relation) {
        return { status: "unconfigured", responseTime: Date.now() - startedAt };
      }
      const rows = await ctx.db.execute<HealthRow[]>(
        "SELECT status, source_fingerprint, current_fingerprint FROM osm_search.index_state WHERE singleton = 1",
      );
      const state = rows[0];
      if (state?.status !== "ready") {
        return {
          status: "down",
          responseTime: Date.now() - startedAt,
          error: "No ready OSM alias index is published",
        };
      }
      return {
        status: "up",
        responseTime: Date.now() - startedAt,
        ...(state.source_fingerprint !== state.current_fingerprint
          ? { error: "OSM alias index is stale; the previous snapshot remains searchable" }
          : {}),
      };
    } catch (error) {
      return {
        status: "down",
        responseTime: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "OSM alias health check failed",
      };
    }
  });
}
