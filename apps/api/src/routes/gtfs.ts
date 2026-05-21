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
      motisArchiveId?: string;
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
      // License gate (MDB only): MDB feeds with no published license_url cannot
      // be assumed safe to redistribute. Block by default; an admin can override
      // with `acceptUnknownLicense: true` after reviewing the feed manually.
      if (feed.source === "mobilitydb" && !feed.license && !feed.licenseUrl) {
        if (!(body as { acceptUnknownLicense?: boolean }).acceptUnknownLicense) {
          return reply.status(409).send({
            error: "license-unknown",
            message:
              "This Mobility Database feed has no published license. Re-submit with acceptUnknownLicense:true to import anyway.",
            mdbId: feed.mdbId,
          });
        }
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

    // Import from a MOTIS-fetched archive on disk. The Transitous pipeline
    // (data-manager) already wrote the zip to `/data/gtfs/`; we don't need
    // to re-download it. Resolve the id against the directory listing so
    // the path can't be tampered with by the caller.
    if (body.motisArchiveId) {
      const { getMotisGtfsArchives } = await import("../services/admin-ops");
      const archives = await getMotisGtfsArchives();
      const archive = archives.find((a) => a.id === body.motisArchiveId);
      if (!archive) {
        return reply
          .status(404)
          .send({ error: `MOTIS archive "${body.motisArchiveId}" not found in /data/gtfs/` });
      }
      const slug = body.slug ?? normalizeFeedSlug(archive.id) ?? archive.id;
      if (!isValidFeedSlug(slug)) {
        return reply.status(400).send({ error: new InvalidFeedSlugError(slug).message });
      }
      if (gtfsManager.isImporting(slug)) {
        return reply.status(409).send({ error: `Feed "${slug}" is already being imported` });
      }
      const { join } = await import("node:path");
      const { DATA_DIR } = await import("../services/admin-ops");
      const localPath = join(DATA_DIR, "gtfs", archive.filename);
      const resultSlug = await gtfsManager.startImport(
        {
          name: body.name ?? archive.id,
          // `local:` pseudo-URL records origin without claiming an HTTP source.
          url: `local:${archive.filename}`,
          source: body.source ?? "motis-local",
          countryCode: body.countryCode ?? "",
          localPath,
          originUrl: archive.originUrl,
        },
        slug,
      );
      return reply.status(202).send({
        slug: resultSlug,
        status: "pending",
        message: "Import started. Check GET /api/gtfs/feeds for progress.",
      });
    }

    // Import from URL
    if (!body.url) {
      return reply
        .status(400)
        .send({ error: "One of 'url', 'catalogId', or 'motisArchiveId' is required" });
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
