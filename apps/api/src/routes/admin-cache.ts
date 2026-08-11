import type { FastifyInstance } from "fastify";
import { redis } from "../redis";
import { writeAuditLog } from "../utils/audit-log";
import {
  APP_CACHE_PREFIXES,
  aggregateNamespaces,
  isAppCachePattern,
  resolveCachePattern,
} from "../utils/cache-namespaces";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";

// Globs covering exactly the app-owned key prefixes. The list + clear-all paths
// scan these and nothing else, so the endpoint can never touch keys outside the
// application's cache (the CLI's `--all` FLUSHDB is intentionally NOT mirrored).
const APP_CACHE_GLOBS = APP_CACHE_PREFIXES.map((prefix) => `${prefix}*`);

const SCAN_COUNT = 500;
const UNLINK_BATCH = 500;

type RedisClient = NonNullable<typeof redis>;

/** Collect every key matching a glob via a non-blocking SCAN stream. */
async function scanKeys(client: RedisClient, match: string): Promise<string[]> {
  const keys: string[] = [];
  const stream = client.scanStream({ match, count: SCAN_COUNT });
  for await (const batch of stream as AsyncIterable<string[]>) {
    keys.push(...batch);
  }
  return keys;
}

/** SCAN + UNLINK the keys matching a glob in batches. Returns the count removed. */
async function clearPattern(client: RedisClient, match: string): Promise<number> {
  const keys = await scanKeys(client, match);
  let deleted = 0;
  for (let i = 0; i < keys.length; i += UNLINK_BATCH) {
    const batch = keys.slice(i, i + UNLINK_BATCH);
    if (batch.length > 0) deleted += await client.unlink(...batch);
  }
  return deleted;
}

export async function adminCacheRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");

  app.addHook("preHandler", async (request, _reply) => {
    request.adminSession = await requireAdmin(request);
  });

  // GET /admin/cache — list app-owned cache namespaces with their key counts.
  app.get("/admin/cache", async () => {
    if (!redis) return { namespaces: [] };

    const keys: string[] = [];
    for (const glob of APP_CACHE_GLOBS) {
      keys.push(...(await scanKeys(redis, glob)));
    }

    const namespaces = aggregateNamespaces(keys).map((n) => ({
      namespace: n.namespace,
      keyCount: n.count,
    }));
    return { namespaces };
  });

  // POST /admin/cache/clear — scoped clear of the app-owned cache prefixes.
  // Body: { namespace?: string }. Omitted or "all" clears every app prefix.
  // NEVER runs FLUSHDB/FLUSHALL — an always-on web endpoint must not be able to
  // wipe a Redis that may be shared with other tenants.
  app.post<{ Body: { namespace?: unknown } }>("/admin/cache/clear", async (request, reply) => {
    const raw = request.body?.namespace;
    if (raw !== undefined && typeof raw !== "string") {
      return reply.status(400).send({ error: "namespace must be a string" });
    }
    const namespace = typeof raw === "string" ? raw.trim() : undefined;
    const clearAll = !namespace || namespace === "all";

    // Validate a targeted namespace resolves to an app-owned prefix before we do
    // anything destructive — reject e.g. `*` that would match unrelated keys.
    if (!clearAll) {
      const pattern = resolveCachePattern(namespace as string);
      if (!isAppCachePattern(pattern)) {
        return reply.status(400).send({
          error: "namespace must resolve to an app-owned cache prefix (int:* or cache:*)",
        });
      }
    }

    const adminSession = getAdminSession(request);
    await writeAuditLog({
      actorId: adminSession.user.id,
      targetType: "cache",
      targetId: clearAll ? "all" : (namespace ?? null),
      action: "cache.clear",
      details: { namespace: clearAll ? "all" : namespace },
      request,
    });

    if (!redis) return { deleted: 0 };

    let deleted = 0;
    if (clearAll) {
      for (const glob of APP_CACHE_GLOBS) {
        deleted += await clearPattern(redis, glob);
      }
    } else {
      deleted = await clearPattern(redis, resolveCachePattern(namespace as string));
    }
    return { deleted };
  });
}
