import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IntegrationContext } from "@openmapx/integration-framework";

const DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "data",
  "timezones.simplified.json",
);

// Boundaries change roughly twice a year, so a week of browser caching costs
// nothing and the ETag collapses the revalidation to a 304.
const CACHE_CONTROL = "public, max-age=604800";

export function setup(ctx: IntegrationContext): void {
  const raw = readFileSync(DATA_PATH, "utf8");
  const etag = `"${createHash("sha256").update(raw).digest("hex").slice(0, 16)}"`;
  const collection = JSON.parse(raw) as unknown;

  ctx.registerRoute("GET", "/timezones", (req, reply) => {
    // registerIntegrationRouteDispatcher (apps/api/src/integration-routes.ts)
    // builds req from only { query, params, body, userId } — it does not
    // forward request headers, so this cast reads a field that is never
    // actually populated by the real host today. The 304 branch below is
    // exercised by this file's own unit test (which supplies headers
    // directly) but is currently unreachable in the running app.
    const headers = (req as { headers?: Record<string, string> }).headers ?? {};
    reply.header("ETag", etag);
    reply.header("Cache-Control", CACHE_CONTROL);

    if (headers["if-none-match"] === etag) {
      reply.status(304).send(undefined);
      return;
    }

    reply.send(collection);
  });
}
