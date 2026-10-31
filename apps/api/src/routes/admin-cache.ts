import { resolveCachePattern } from "@openmapx/core/cache-namespaces";
import type { FastifyInstance } from "fastify";
import { redis } from "../redis";
import { cacheInvalidation } from "../services/cache-invalidation";
import { writeAuditLog } from "../utils/audit-log";
import { APP_CACHE_PREFIXES, isAppCachePattern } from "../utils/cache-policy";
import { getAdminSession, requireAdmin } from "../utils/require-admin";
import { declareRouteAuth } from "../utils/route-auth";
import { registerServiceAdminRoute } from "./admin-service-contract";

const APP_CACHE_GLOBS = APP_CACHE_PREFIXES.map((prefix) => `${prefix}*`);
const SCAN_COUNT = 500,
  UNLINK_BATCH = 500;
type RedisClient = NonNullable<typeof redis>;
/** Consume each SCAN page before requesting the next; never retain the full key list. */
async function scanPattern(client: RedisClient, match: string, remove: boolean): Promise<number> {
  let count = 0;
  const stream = client.scanStream({ match, count: SCAN_COUNT });
  for await (const page of stream as AsyncIterable<string[]>) {
    for (let offset = 0; offset < page.length; offset += UNLINK_BATCH) {
      const batch = page
        .slice(offset, offset + UNLINK_BATCH)
        .filter((key) => APP_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)));
      count += remove && batch.length ? await client.unlink(...batch) : batch.length;
    }
  }
  return count;
}
export async function adminCacheRoute(app: FastifyInstance): Promise<void> {
  declareRouteAuth(app, "admin");
  app.addHook("preHandler", async (request) => {
    request.adminSession = await requireAdmin(request);
  });
  registerServiceAdminRoute(app, "listAdminCacheNamespaces", async () => {
    const counts = new Map<string, number>();
    if (redis)
      for (const glob of APP_CACHE_GLOBS) {
        const stream = redis.scanStream({ match: glob, count: SCAN_COUNT });
        for await (const page of stream as AsyncIterable<string[]>)
          for (const key of page) {
            if (!APP_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
            const separator = key.lastIndexOf(":"),
              namespace = separator === -1 ? key : key.slice(0, separator);
            counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
          }
      }
    return {
      namespaces: [...counts]
        .map(([namespace, keyCount]) => ({ namespace, keyCount }))
        .sort((a, b) => b.keyCount - a.keyCount || a.namespace.localeCompare(b.namespace)),
    };
  });
  registerServiceAdminRoute(app, "clearAdminCache", async (request, reply) => {
    const body = request.body ?? {},
      namespace = body.namespace?.trim();
    const clearAll = body.pattern === undefined && (!namespace || namespace === "all");
    const target =
      body.pattern ??
      (namespace && isAppCachePattern(namespace)
        ? `${namespace}${/[?*[\\]/.test(namespace) ? "" : ":*"}`
        : resolveCachePattern(namespace ?? ""));
    const patterns = clearAll ? APP_CACHE_GLOBS : [target];
    if (!patterns.every(isAppCachePattern))
      return reply.code(400).send({ error: "Target must begin literally with int: or cache:" });
    if (body.dryRun) {
      let estimatedCount = 0;
      if (redis)
        for (const pattern of patterns) estimatedCount += await scanPattern(redis, pattern, false);
      return { dryRun: true as const, estimatedCount, patterns };
    }
    await writeAuditLog({
      actorId: getAdminSession(request).user.id,
      targetType: "cache",
      targetId: clearAll ? "all" : target,
      action: "cache.clear",
      details: { namespace: clearAll ? "all" : namespace, patterns },
      request,
    });
    return cacheInvalidation.invalidate(patterns, async () => {
      let deleted = 0;
      if (redis) for (const pattern of patterns) deleted += await scanPattern(redis, pattern, true);
      return { deleted, patterns };
    });
  });
}
