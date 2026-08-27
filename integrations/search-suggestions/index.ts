import {
  isUppercaseAcronymIntent,
  normalizeSearchTerm,
  type SearchSuggestionQuery,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { createSearchSuggestionsOrchestrator } from "./orchestrator.js";

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createSearchSuggestionsOrchestrator(ctx);
  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const rawQuery = typeof req.query.q === "string" ? req.query.q : "";
    const normalized = normalizeSearchTerm(rawQuery);
    if (normalized.replace(/[^\p{L}\p{N}]/gu, "").length < 2) {
      reply.header("Cache-Control", "public, max-age=60");
      reply.send({ suggestions: [], attributions: [], partial: false });
      return;
    }

    const parsedLimit = Number.parseInt(req.query.limit ?? "", 10);
    const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(20, parsedLimit)) : 8;
    const latProvided = req.query.lat !== undefined;
    const lngProvided = req.query.lng !== undefined;
    const lat = Number.parseFloat(req.query.lat ?? "");
    const lng = Number.parseFloat(req.query.lng ?? "");
    if (
      latProvided !== lngProvided ||
      (latProvided &&
        (!Number.isFinite(lat) ||
          !Number.isFinite(lng) ||
          lat < -90 ||
          lat > 90 ||
          lng < -180 ||
          lng > 180))
    ) {
      reply.status(400).send({ error: "lat and lng must both be valid coordinates" });
      return;
    }

    const query: SearchSuggestionQuery = {
      query: rawQuery,
      lang: typeof req.query.lang === "string" && req.query.lang ? req.query.lang : "en",
      limit,
      ...(latProvided ? { proximity: [lng, lat] as [number, number] } : {}),
    };
    const proximityKey = query.proximity
      ? query.proximity.map((value) => Math.round(value * 100) / 100).join(",")
      : "none";
    const key = [
      "aggregate",
      normalized,
      query.lang,
      proximityKey,
      isUppercaseAcronymIntent(rawQuery) ? "upper" : "lower",
      limit,
    ].join(":");
    const result = await ctx.cache.withCache(
      key,
      300,
      (operationSignal) => orchestrator.search(query, operationSignal),
      req.signal,
      (value) => !value.partial,
    );
    reply.header("Cache-Control", result.partial ? "no-store" : "public, max-age=300");
    reply.send(result);
  });
}
