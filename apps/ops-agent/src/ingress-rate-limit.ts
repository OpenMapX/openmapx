import rateLimit, { normalizeIP } from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

const installed = new WeakSet<FastifyInstance>();

/** One bounded peer budget, charged before authentication or body parsing. */
export function registerOpsIngressRateLimit(app: FastifyInstance): void {
  if (installed.has(app)) return;
  installed.add(app);
  let limit: ReturnType<FastifyInstance["rateLimit"]> | undefined;
  app.register(rateLimit, {
    global: false,
    max: 6000,
    timeWindow: 60000,
    cache: 1000,
    keyGenerator: (request) => normalizeIP(request.raw.socket.remoteAddress ?? "unknown"),
  });
  void app.after((error) => {
    if (error) throw error;
    limit = app.rateLimit();
  });
  // The plugin's automatic onRoute hook appends after existing onRequest
  // authentication hooks. Install its actual handler here instead, once ready.
  app.addHook("onRequest", async function (request, reply) {
    if (!limit) throw Error("Ops ingress rate limiter unavailable");
    await limit.call(this, request, reply);
  });
}
