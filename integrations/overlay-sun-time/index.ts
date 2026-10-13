import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dataSourceToAttribution, type IntegrationContext } from "@openmapx/integration-framework";
import {
  snapshotContributors,
  withFeatureContributors,
} from "@openmapx/mobility-core/contributors";

const DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "data",
  "timezones.simplified.json",
);

// Boundaries change roughly twice a year, so a week of browser caching costs
// nothing and the ETag collapses the revalidation to a 304.
const CACHE_CONTROL = "public, max-age=604800";

export function setup(ctx: IntegrationContext): void {
  // Attach the vendored dataset's exact receipt once before retaining serialized
  // bytes. Requests do not parse or stringify the collection, and the ETag
  // hashes the exact receipt-bearing response rather than the original asset.
  const source = ctx.manifest.dataSources?.find(
    (source) => source.sourceId === "timezone-boundary-builder",
  );
  const contributors = snapshotContributors(source ? [dataSourceToAttribution(source)] : []);
  const collection = JSON.parse(readFileSync(DATA_PATH, "utf8")) as GeoJSON.FeatureCollection;
  const raw = JSON.stringify({
    ...collection,
    features: collection.features.map((feature) => withFeatureContributors(feature, contributors)),
  });
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
