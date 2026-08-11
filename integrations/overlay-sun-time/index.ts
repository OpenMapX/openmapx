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
  // Serve the raw bytes rather than parsing to an object: Fastify would
  // otherwise JSON.stringify the ~1.23 MB collection on every cache miss,
  // and the parsed object holds several times the string's heap for the
  // life of the process. The ETag is hashed off these same bytes, so it
  // matches exactly what goes out on the wire.
  const raw = readFileSync(DATA_PATH, "utf8");
  const etag = `"${createHash("sha256").update(raw).digest("hex").slice(0, 16)}"`;

  ctx.registerRoute("GET", "/timezones", (req, reply) => {
    reply.header("ETag", etag);
    reply.header("Cache-Control", CACHE_CONTROL);

    if (req.headers["if-none-match"] === etag) {
      reply.status(304).send(undefined);
      return;
    }

    reply.type("application/json");
    reply.send(raw);
  });
}
