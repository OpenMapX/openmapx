import type { FastifyInstance } from "fastify";
import { getMetrics } from "../services/metrics/index.js";

/**
 * Prometheus scrape endpoint mounted on the existing Fastify app.
 *
 * `internalOnly: true` — this path emits raw OTEL counters in Prometheus
 * text format. No PII (labels are `providerId`, `method`, `outcome`), but the
 * data still reveals operational topology (which providers exist, request
 * volume per provider). Restrict via firewall / docker network rules; do not
 * expose it on the public reverse proxy.
 */
export async function internalMetricsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get("/internal/metrics", async (_request, reply) => {
    const metrics = getMetrics();
    const text = await metrics.renderPrometheus();
    return reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8").send(text);
  });
}
