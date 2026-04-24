import { InvalidFeedSlugError, isValidFeedSlug, normalizeFeedSlug } from "@openmapx/core";
import type { FastifyInstance } from "fastify";
import { searchCatalog } from "../services/gtfs/catalog";
import { gtfsManager } from "../services/gtfs/index";
import { requireAdmin } from "../utils/require-admin";

export async function gtfsRoute(app: FastifyInstance): Promise<void> {
  // List available feeds from catalogs
  app.get("/gtfs/catalog", async (request) => {
    const { query, country } = request.query as { query?: string; country?: string };
    const feeds = await searchCatalog(query, country);
    return { feeds, count: feeds.length };
  });

  // List imported feeds
  app.get("/gtfs/feeds", async () => {
    const feeds = gtfsManager.getFeeds();
    return { feeds, count: feeds.length };
  });

  // Import a feed
  app.post("/gtfs/feeds", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const body = request.body as {
      url?: string;
      name?: string;
      slug?: string;
      source?: string;
      countryCode?: string;
      catalogId?: string;
    };

    // Import from catalog by ID
    if (body.catalogId) {
      const catalog = await searchCatalog();
      const feed = catalog.find((f) => f.id === body.catalogId);
      if (!feed) {
        return reply.status(404).send({ error: `Catalog feed "${body.catalogId}" not found` });
      }
      const slug = body.slug ?? normalizeFeedSlug(feed.id);
      if (!slug || !isValidFeedSlug(slug)) {
        return reply.status(400).send({ error: new InvalidFeedSlugError(String(slug)).message });
      }
      if (gtfsManager.isImporting(slug)) {
        return reply.status(409).send({ error: `Feed "${slug}" is already being imported` });
      }
      const resultSlug = await gtfsManager.startImport(feed, slug);
      return reply.status(202).send({
        slug: resultSlug,
        status: "pending",
        message: "Import started. Check GET /api/gtfs/feeds for progress.",
      });
    }

    // Import from URL
    if (!body.url) {
      return reply.status(400).send({ error: "Either 'url' or 'catalogId' is required" });
    }

    const name = body.name ?? body.url.split("/").pop()?.replace(".zip", "") ?? "Unknown";
    const slug = body.slug ?? normalizeFeedSlug(name) ?? `manual_${Date.now()}`;
    if (!isValidFeedSlug(slug)) {
      return reply.status(400).send({ error: new InvalidFeedSlugError(slug).message });
    }
    if (gtfsManager.isImporting(slug)) {
      return reply.status(409).send({ error: `Feed "${slug}" is already being imported` });
    }

    const resultSlug = await gtfsManager.startImport(
      {
        name,
        url: body.url,
        source: body.source ?? "manual",
        countryCode: body.countryCode ?? "",
      },
      slug,
    );

    return reply.status(202).send({
      slug: resultSlug,
      status: "pending",
      message: "Import started. Check GET /api/gtfs/feeds for progress.",
    });
  });

  // Get single feed
  app.get("/gtfs/feeds/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    if (!isValidFeedSlug(slug)) {
      return reply.status(400).send({ error: new InvalidFeedSlugError(slug).message });
    }
    const feeds = gtfsManager.getFeeds();
    const feed = feeds.find((f) => f.slug === slug);
    if (!feed) return reply.status(404).send({ error: "Feed not found" });
    return feed;
  });

  // Remove a feed
  app.delete("/gtfs/feeds/:slug", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { slug } = request.params as { slug: string };
    if (!isValidFeedSlug(slug)) {
      return reply.status(400).send({ error: new InvalidFeedSlugError(slug).message });
    }
    try {
      await gtfsManager.removeFeed(slug);
      return { success: true, message: `Feed "${slug}" removed` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(400).send({ error: message });
    }
  });

  // Refresh a feed (re-import)
  app.post("/gtfs/feeds/:slug/refresh", async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return;
    const { slug } = request.params as { slug: string };
    if (!isValidFeedSlug(slug)) {
      return reply.status(400).send({ error: new InvalidFeedSlugError(slug).message });
    }
    const feeds = gtfsManager.getFeeds();
    const feed = feeds.find((f) => f.slug === slug);
    if (!feed) return reply.status(404).send({ error: "Feed not found" });
    if (gtfsManager.isImporting(slug)) {
      return reply.status(409).send({ error: `Feed "${slug}" is already being imported` });
    }

    await gtfsManager.startImport(
      { name: feed.name, url: feed.url, source: feed.source, countryCode: feed.countryCode },
      slug,
    );

    return reply.status(202).send({
      slug,
      status: "pending",
      message: "Re-import started. Check GET /api/gtfs/feeds for progress.",
    });
  });
}
