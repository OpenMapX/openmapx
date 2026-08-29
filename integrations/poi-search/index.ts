import { createHash } from "node:crypto";
import { getBrandByQid, suggestBrands, warmBrandIndex } from "@openmapx/brands";
import {
  bboxCacheKey,
  fetchCommonsMetadata,
  normalizeFilter,
  OverpassTimeoutError,
  validateOverpassFilter,
} from "@openmapx/core";
import { type IntegrationContext, scalarQueries } from "@openmapx/integration-framework";
import { getChipTranslations, suggestPresets } from "@openmapx/presets";
import { createPoiSearchOrchestrator } from "./orchestrator.js";

export function setup(ctx: IntegrationContext): void {
  const orchestrator = createPoiSearchOrchestrator(ctx);

  // Build the brand index off the request path so the first search does not pay
  // the artifact parse. Failure is non-fatal: the routes below surface it.
  queueMicrotask(() => {
    try {
      warmBrandIndex();
    } catch (err) {
      ctx.log.warn("Brand index warm-up failed", err);
    }
  });

  ctx.registerRoute("GET", "/search", async (req, reply) => {
    const { category, south, west, north, east, lang } = scalarQueries(req.query);

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
    const { q, south, west, north, east, lang } = scalarQueries(req.query);

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
    const { category, tags, south, west, north, east, lang } = scalarQueries(req.query) as {
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
    const { q, lang, limit } = scalarQueries(req.query) as {
      q?: string;
      lang?: string;
      limit?: string;
    };

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

  ctx.registerRoute("GET", "/brand-suggest", async (req, reply) => {
    const { q, country, limit } = scalarQueries(req.query) as {
      q?: string;
      country?: string;
      limit?: string;
    };

    if (!q || q.trim().length < 2) {
      reply.header("Cache-Control", "public, max-age=60");
      reply.send({ matches: [] });
      return;
    }

    const parsedLimit = limit ? Number.parseInt(limit, 10) : Number.NaN;
    const limitN = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(20, parsedLimit)) : 8;
    // Only a two-letter country code participates in ranking; anything else is
    // ignored rather than rejected, so a stale client cannot break search.
    const cc =
      typeof country === "string" && /^[A-Za-z]{2}$/.test(country)
        ? country.toLowerCase()
        : undefined;

    const cacheKey = `brand-suggest:${cc ?? "-"}:${limitN}:${q.trim().toLowerCase()}`;
    const result = await ctx.cache.withCache(cacheKey, 3600, async () => ({
      matches: suggestBrands(q, cc, limitN),
    }));

    reply.header("Cache-Control", "public, max-age=3600");
    reply.send(result);
  });

  ctx.registerRoute("GET", "/brand/:qid", async (req, reply) => {
    const { qid } = req.params as { qid?: string };

    if (!qid || !/^Q\d{1,12}$/.test(qid)) {
      reply.status(400).send({ error: "Invalid Wikidata QID" });
      return;
    }

    const entry = getBrandByQid(qid);
    if (!entry) {
      reply.status(404).send({ error: `Unknown brand: ${qid}` });
      return;
    }

    reply.header("Cache-Control", "public, max-age=86400");
    reply.send(entry);
  });

  // Per-logo Commons attribution (author + licence) for the brand header
  // card, which shows the one logo it displays at 36px per design §10 —
  // tiny map/list icons carry the blanket NSI/Commons registry credit
  // instead. Separate from `/brand/:qid` (which is a cheap catalog lookup)
  // because this makes an outbound Commons API call and should stay
  // opt-in/lazy from the client, not bundled into every brand-detail fetch.
  ctx.registerRoute("GET", "/brand/:qid/logo-attribution", async (req, reply) => {
    const { qid } = req.params as { qid?: string };

    if (!qid || !/^Q\d{1,12}$/.test(qid)) {
      reply.status(400).send({ error: "Invalid Wikidata QID" });
      return;
    }

    const entry = getBrandByQid(qid);
    if (!entry?.logoFile) {
      reply.status(404).send({ error: `No logo for brand: ${qid}` });
      return;
    }

    const cacheKey = `brand-logo-attribution:${qid}`;
    const result = await ctx.cache.withCache(cacheKey, 86400, async () => {
      const metadata = await fetchCommonsMetadata([entry.logoFile as string]);
      const photo = [...metadata.values()][0];
      return {
        author: photo?.author,
        authorUrl: photo?.authorUrl,
        license: photo?.license,
        licenseUrl: photo?.licenseUrl,
      };
    });

    reply.header("Cache-Control", "public, max-age=86400");
    reply.send(result);
  });

  ctx.registerRoute("GET", "/chip-translations", async (req, reply) => {
    const { lang } = scalarQueries(req.query) as { lang?: string };
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
