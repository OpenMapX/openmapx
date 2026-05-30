import type { IntegrationContext } from "@openmapx/integration-framework";
import { FLIGHT_PROVIDERS, getFlightProvider } from "./providers/index.js";
import { parseFlightQuery } from "./query.js";
import type { FlightProviderConfig, FlightProviderInfo } from "./types.js";

/**
 * Flight-search integration. Exposes deep-link builders for external flight
 * engines so the directions panel can open a pre-filled search. No live flight
 * data is fetched — see docs/plans/flights-in-directions.md for why.
 *
 * Routes (under `/api/integrations/flights`):
 *   GET /providers          → list providers + capabilities + default
 *   GET /:provider/open     → 302 redirect to the pre-filled external search
 *   GET /:provider/url      → { url } (same link as JSON, for previews/tests)
 */
export function setup(ctx: IntegrationContext): void {
  const defaultProvider =
    typeof ctx.config.defaultProvider === "string" ? ctx.config.defaultProvider : "skyscanner";
  const providerConfig: FlightProviderConfig = {
    skyscannerMediaPartnerId:
      typeof ctx.config.skyscannerMediaPartnerId === "string"
        ? ctx.config.skyscannerMediaPartnerId
        : undefined,
  };

  ctx.registerRoute("GET", "/providers", async (_req, reply) => {
    const providers: FlightProviderInfo[] = FLIGHT_PROVIDERS.map((p) => ({
      id: p.id,
      name: p.name,
      homepage: p.homepage,
      capabilities: p.capabilities,
      isDefault: p.id === defaultProvider,
    }));
    reply.header("Cache-Control", "public, max-age=3600");
    reply.send({ providers, defaultProvider });
  });

  ctx.registerRoute("GET", "/:provider/open", async (req, reply) => {
    const provider = getFlightProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown flight provider" });
      return;
    }
    const parsed = parseFlightQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    reply.header("Location", provider.build(parsed.query, providerConfig));
    reply.status(302).send({});
  });

  ctx.registerRoute("GET", "/:provider/url", async (req, reply) => {
    const provider = getFlightProvider(req.params.provider ?? "");
    if (!provider) {
      reply.status(404).send({ error: "Unknown flight provider" });
      return;
    }
    const parsed = parseFlightQuery(req.query);
    if (!parsed.ok) {
      reply.status(400).send({ error: parsed.error });
      return;
    }
    reply.send({ provider: provider.id, url: provider.build(parsed.query, providerConfig) });
  });
}
