import { createHash } from "node:crypto";
import { getAllPoiSources } from "@openmapx/poi-source-registry";
import type { FastifyInstance } from "fastify";

/**
 * data-manager → apps/api discovery cross-check endpoint.
 *
 * Returns the count of currently-registered POI sources + a sha256 of the
 * sorted source-id list. The data-manager periodically calls this and
 * compares against its own local registry; persistent drift surfaces as a
 * warning in the admin UI (see /poi-ingest/state.registryCountMatchesUpstream).
 *
 * Internal-only — same firewall posture as /internal/metrics. No PII; reveals
 * operational topology (which sources exist on apps/api).
 */
export async function internalPoiSourcesRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/internal/poi-sources/count", async (_request, reply) => {
    const sources = getAllPoiSources();
    const ids = sources.map((s) => s.id).sort();
    const hash = createHash("sha256").update(ids.join("\n")).digest("hex");
    reply.send({ count: sources.length, hash, ids });
  });
}
