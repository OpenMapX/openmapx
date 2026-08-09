import { createHash } from "node:crypto";
import {
  bboxCacheKey,
  normalizeFilter,
  OverpassTimeoutError,
  validateOverpassFilter,
} from "@openmapx/core";
import type { IntegrationContext } from "@openmapx/integration-framework";
import { getChipTranslations, suggestPresets } from "@openmapx/presets";
import { createPoiSearchOrchestrator } from "./orchestrator.js";

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createPoiSearchOrchestrator(ctx);

  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const { category, south, west, north, east, lang } = req.query;

    const bbox = {
      south: Number.parseFloat(south),
      west: Number.parseFloat(west),
      north: Number.parseFloat(north),
      east: Number.parseFloat(east),
    };

    for (const [key, val] of Object.entries(bbox)) {
      if (!Number.isFinite(val)) {
        reply.status(400).send({ error: `Invalid bbox parameter: ${key}` });
        return;
      }
    }

    const cacheKey = `category:${category}:${lang ?? "en"}:${bboxCacheKey(bbox)}`;

    try {
      const result = await ctx.cache.withCache(cacheKey, 300, () =>
        orchestrator.search(category, bbox, { lang }),
      );
      reply.header("Cache-Control", "public, max-age=300");
      reply.send(result);
    } catch (err) {
      if (err instanceof OverpassTimeoutError) {
        reply.status(422).send({ error: "area_too_large" });
        return;
      }
      const e = err as { statusCode?: number; message: string };
      if (e.statusCode === 400) {
        reply.status(400).send({ error: e.message });
        return;
      }
      throw err;
    }
  });

  ctx.registerRoute("GET", "/text", async (req, reply) => {
    const { q, south, west, north, east, lang } = req.query;

    if (!q || q.trim().length < 2) {
      reply.send({ results: [], partial: false, truncated: false, total: 0 });
      return;
    }

    const bbox = {
      south: Number.parseFloat(south),
      west: Number.parseFloat(west),
      north: Number.parseFloat(north),
      east: Number.parseFloat(east),
    };
    for (const [key, val] of Object.entries(bbox)) {
      if (!Number.isFinite(val)) {
        reply.status(400).send({ error: `Invalid bbox parameter: ${key}` });
        return;
      }
    }

    const cacheKey = `text:${q.trim().toLowerCase()}:${lang ?? "en"}:${bboxCacheKey(bbox)}`;

    try {
      const result = await ctx.cache.withCache(cacheKey, 300, () =>
        orchestrator.searchText(q, bbox, { lang }),
      );
      reply.header("Cache-Control", "public, max-age=300");
      reply.send(result);
    } catch (err) {
      if (err instanceof OverpassTimeoutError) {
        reply.status(422).send({ error: "area_too_large" });
        return;
      }
      const e = err as { statusCode?: number; message: string };
      if (e.statusCode === 400) {
        reply.status(400).send({ error: e.message });
        return;
      }
      throw err;
    }
  });

  ctx.registerRoute("GET", "/filtered", async (req, reply) => {
    const { category, tags, south, west, north, east, lang } = req.query as {
      category?: string;
      tags?: string;
      south?: string;
      west?: string;
      north?: string;
      east?: string;
      lang?: string;
    };

    if (!category) {
      reply.status(400).send({ error: "Missing category parameter" });
      return;
    }

    let attributes: Record<string, string> = {};
    if (tags) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(tags);
      } catch {
        reply.status(400).send({ error: "Invalid tags parameter: must be valid JSON" });
        return;
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        reply.status(400).send({ error: "Invalid tags: must be a JSON object" });
        return;
      }
      // Every tag value must be a string — non-string values (e.g. numbers)
      // would otherwise reach escapeOverpassLiteral and throw an unhandled 500.
      if (!Object.values(parsed).every((v) => typeof v === "string")) {
        reply.status(400).send({ error: "Invalid tags: values must be strings" });
        return;
      }
      attributes = parsed as Record<string, string>;
    }

    const bbox = {
      south: Number.parseFloat(south ?? ""),
      west: Number.parseFloat(west ?? ""),
      north: Number.parseFloat(north ?? ""),
      east: Number.parseFloat(east ?? ""),
    };
    for (const [key, val] of Object.entries(bbox)) {
      if (!Number.isFinite(val)) {
        reply.status(400).send({ error: `Invalid bbox parameter: ${key}` });
        return;
      }
    }

    const sortedTagKey = Object.keys(attributes)
      .sort()
      .map((k) => `${k}=${attributes[k]}`)
      .join(",");
    const cacheKey = `filtered:${category}:${sortedTagKey}:${lang ?? "en"}:${bboxCacheKey(bbox)}`;

    try {
      const result = await ctx.cache.withCache(cacheKey, 300, () =>
        orchestrator.searchFiltered(category, attributes, bbox, { lang }),
      );
      reply.header("Cache-Control", "public, max-age=300");
      reply.send(result);
    } catch (err) {
      if (err instanceof OverpassTimeoutError) {
        reply.status(422).send({ error: "area_too_large" });
        return;
      }
      const e = err as { statusCode?: number; message: string };
      if (e.statusCode === 400) {
        reply.status(400).send({ error: e.message });
        return;
      }
      throw err;
    }
  });

  ctx.registerRoute("GET", "/preset-suggest", async (req, reply) => {
    const { q, lang, limit } = req.query as { q?: string; lang?: string; limit?: string };

    if (!q || q.trim().length < 2) {
      reply.header("Cache-Control", "public, max-age=60");
      reply.send({ matches: [] });
      return;
    }

    const parsedLimit = limit ? Number.parseInt(limit, 10) : Number.NaN;
    const limitN = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(20, parsedLimit)) : 8;
    const cacheKey = `preset-suggest:${lang ?? "en"}:${limitN}:${q.toLowerCase()}`;
    const result = await ctx.cache.withCache(cacheKey, 300, async () => ({
      matches: suggestPresets(q, lang, limitN),
    }));

    reply.header("Cache-Control", "public, max-age=300");
    reply.send(result);
  });

  ctx.registerRoute("GET", "/chip-translations", async (req, reply) => {
    const { lang } = req.query as { lang?: string };
    const cacheKey = `chip-translations:${lang ?? "en"}`;
    const result = await ctx.cache.withCache(cacheKey, 3600, async () => ({
      translations: getChipTranslations(lang),
    }));
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(result);
  });

  ctx.registerRoute("POST", "/filter", async (req, reply) => {
    const body = req.body as
      | {
          filter?: unknown;
          south?: number | string;
          north?: number | string;
          west?: number | string;
          east?: number | string;
          lang?: string;
        }
      | null
      | undefined;

    const v = validateOverpassFilter(body?.filter);
    if (!v.ok) {
      reply.status(400).send({ error: v.error });
      return;
    }

    const bbox = {
      south: Number(body?.south),
      west: Number(body?.west),
      north: Number(body?.north),
      east: Number(body?.east),
    };
    for (const [key, val] of Object.entries(bbox)) {
      if (!Number.isFinite(val)) {
        reply.status(400).send({ error: `Invalid bbox parameter: ${key}` });
        return;
      }
    }

    const lang = typeof body?.lang === "string" ? body.lang : undefined;

    const filterHash = createHash("sha256")
      .update(JSON.stringify(normalizeFilter(v.filter)))
      .digest("hex")
      .slice(0, 16);
    const cacheKey = `filter:${filterHash}:${lang ?? "en"}:${bboxCacheKey(bbox)}`;

    try {
      const result = await ctx.cache.withCache(cacheKey, 300, () =>
        orchestrator.searchByFilter(v.filter, bbox, { lang }),
      );
      reply.header("Cache-Control", "public, max-age=300");
      reply.send(result);
    } catch (err) {
      if (err instanceof OverpassTimeoutError) {
        reply.status(422).send({ error: "area_too_large" });
        return;
      }
      const e = err as { statusCode?: number; message: string };
      if (e.statusCode === 400) {
        reply.status(400).send({ error: e.message });
        return;
      }
      throw err;
    }
  });
}
