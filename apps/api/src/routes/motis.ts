import type { FastifyInstance } from "fastify";
import { searchCatalog } from "../services/gtfs/catalog";
import { motisManager } from "../services/motis/manager";
import { requireAdmin } from "../utils/require-admin";

export async function motisRoute(server: FastifyInstance): Promise<void> {
  // GET /api/motis/status — MOTIS instance status + feed list
  server.get("/motis/status", async (_request, _reply) => {
    return motisManager.getStatus();
  });

  // GET /api/motis/feeds — list managed feeds
  server.get("/motis/feeds", async (_request, _reply) => {
    return {
      feeds: motisManager.getFeeds(),
      untrackedFiles: motisManager.getUntrackedFiles(),
    };
  });

  // POST /api/motis/feeds — add a feed by URL or catalog ID
  server.post("/motis/feeds", async (request, reply) => {
    await requireAdmin(request);
    const body = request.body as {
      url?: string;
      catalogId?: string;
      slug?: string;
      name?: string;
      countryCode?: string;
    } | null;
    if (!body) {
      return reply.status(400).send({ error: "Request body required" });
    }

    let url: string;
    let name: string;
    let countryCode: string;
    let slug: string;

    if (body.catalogId) {
      // Look up from GTFS catalog
      const feeds = await searchCatalog();
      const catalogFeed = feeds.find((f) => f.id === body.catalogId);
      if (!catalogFeed) {
        return reply.status(404).send({ error: `Catalog feed "${body.catalogId}" not found` });
      }
      url = catalogFeed.url;
      name = body.name ?? catalogFeed.name;
      countryCode = body.countryCode ?? catalogFeed.countryCode;
      slug = body.slug ?? catalogFeed.id.split(":").pop() ?? catalogFeed.countryCode;
    } else if (body.url) {
      url = body.url;
      name = body.name ?? "Manual feed";
      countryCode = body.countryCode ?? "xx";
      slug = body.slug ?? `manual_${Date.now()}`;
    } else {
      return reply.status(400).send({ error: "Provide url or catalogId" });
    }

    // Sanitize slug
    slug = slug
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_|_$/g, "");

    try {
      const feed = await motisManager.addFeed({ slug, name, url, countryCode });
      return reply.status(202).send(feed);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to add feed";
      return reply.status(409).send({ error: message });
    }
  });

  // GET /api/motis/feeds/:slug — single feed status
  server.get("/motis/feeds/:slug", async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const feed = motisManager.getFeed(slug);
    if (!feed) return reply.status(404).send({ error: "Feed not found" });
    return feed;
  });

  // DELETE /api/motis/feeds/:slug — remove a feed
  server.delete("/motis/feeds/:slug", async (request, reply) => {
    await requireAdmin(request);
    const { slug } = request.params as { slug: string };
    const removed = motisManager.removeFeed(slug);
    if (!removed) return reply.status(404).send({ error: "Feed not found" });
    return { removed: true, slug, message: "Restart MOTIS to apply changes" };
  });

  // POST /api/motis/restarted — mark that MOTIS has been restarted
  server.post("/motis/restarted", async (request, _reply) => {
    await requireAdmin(request);
    motisManager.markRestarted();
    return { ok: true, message: "Restart acknowledged" };
  });
}
