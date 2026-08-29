import { type IntegrationContext, scalarQueries } from "@openmapx/integration-framework";
import { createRideOrchestrator, RideComparisonError } from "./orchestrator.js";
import { parseRideQuery } from "./query.js";

/** Normalise a JSON body into the flat string map `parseRideQuery` expects. */
function bodyToQuery(body: unknown): Record<string, string> {
  if (typeof body !== "object" || body === null) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") out[key] = String(value);
  }
  return out;
}

function readProviderIds(body: unknown): string[] {
  if (typeof body !== "object" || body === null) return [];
  const raw = (body as { providerIds?: unknown }).providerIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string");
}

/**
 * Ride-hailing orchestrator. Route geometry for the `ride` travel mode comes
 * from the normal driving router; this integration only supplies providers,
 * quotes and booking handoffs.
 *
 * Routes (under `/api/integrations/ride-hailing`):
 *   GET  /providers          → providers serving the pickup + comparison policy
 *   POST /quotes             → quotes for one provider (or several when unlocked)
 *   GET  /:provider/open     → 302 redirect to the provider handoff
 *   GET  /:provider/handoff  → { handoff } (same link as JSON, for previews/tests)
 */
export function setup(ctx: IntegrationContext): void {
  const orchestrator = createRideOrchestrator(ctx);

  ctx.registerRoute("GET", "/providers", async (req, reply) => {
    const parsed = parseRideQuery(scalarQueries(req.query));
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    // Availability depends on the caller's coordinates and, for some providers,
    // the current time, so this response is per-request and never shared.
    reply.header("Cache-Control", "no-store");
    reply.send(await orchestrator.listProviders(parsed.request));
  });

  ctx.registerRoute("POST", "/quotes", async (req, reply) => {
    // Quotes are priced from a precise origin and destination and go stale in
    // under a minute, so they are never stored anywhere on the way back.
    reply.header("Cache-Control", "no-store");
    const parsed = parseRideQuery(bodyToQuery(req.body));
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    try {
      const results = await orchestrator.getQuotes(parsed.request, readProviderIds(req.body));
      reply.send({ results });
    } catch (err) {
      if (err instanceof RideComparisonError) {
        reply.status(err.status).send({ error: err.message });
        return;
      }
      throw err;
    }
  });

  ctx.registerRoute("GET", "/:provider/open", async (req, reply) => {
    const provider = orchestrator.getProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown ride provider" });
      return;
    }
    const parsed = parseRideQuery(scalarQueries(req.query));
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    const handoff = await provider.createHandoff(parsed.request);
    reply.header("Location", handoff.webUrl);
    reply.status(302).send({});
  });

  ctx.registerRoute("GET", "/:provider/handoff", async (req, reply) => {
    const provider = orchestrator.getProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown ride provider" });
      return;
    }
    const parsed = parseRideQuery(scalarQueries(req.query));
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    reply.send({ provider: provider.id, handoff: await provider.createHandoff(parsed.request) });
  });
}
