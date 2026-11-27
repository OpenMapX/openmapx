import {
  type CapabilitiesResponse,
  capabilitiesResponseSchema,
} from "@openmapx/core/api-contracts";
import { type RoutingProvider, toIntegrationMeta } from "@openmapx/integration-framework";
import type { FastifyPluginAsync } from "fastify";
import { getAllIntegrations } from "../integration-host.js";
import { isIntegrationHealthy } from "../services/integration-health.js";
import { osmContributionsPubliclyEnabled } from "../utils/osm-config.js";
import { declareRouteAuth } from "../utils/route-auth.js";
import { runtimeMetadataJsonSchema } from "./runtime-metadata-schemas";

/**
 * What a client needs to decide, without knowing engine ids, which routing
 * integration can serve a request and whose traffic proofs it may verify.
 */
function routingCapability(
  providers: readonly unknown[] | undefined,
): Partial<CapabilitiesResponse["services"][string]> {
  const engines = (providers ?? []) as RoutingProvider[];
  if (engines.length === 0) return {};
  return {
    modes: [...new Set(engines.flatMap((engine) => engine.supportedModes ?? []))],
    trafficProof: engines.some((engine) => engine.supportsTrafficProof === true),
    timeAware: engines.some((engine) => engine.supportsTimeAware === true),
    exclusions: engines.some((engine) => engine.supportsExclusions === true),
  };
}

export const capabilitiesRoute: FastifyPluginAsync = async (fastify) => {
  declareRouteAuth(fastify, "public");
  fastify.addSchema(runtimeMetadataJsonSchema(capabilitiesResponseSchema, "CapabilitiesResponse"));

  fastify.get(
    "/capabilities",
    {
      schema: {
        operationId: "getApiCapabilities",
        tags: ["runtime-metadata"],
        response: { 200: { $ref: "CapabilitiesResponse#" } },
      },
    },
    async (_req, reply) => {
      const services: CapabilitiesResponse["services"] = {};

      for (const integration of getAllIntegrations()) {
        const meta = toIntegrationMeta(integration);
        const healthy = isIntegrationHealthy(integration.id, !!integration.manifest.healthCheck);
        services[integration.id] = {
          enabled: meta.enabled,
          healthy,
          available: meta.enabled && (healthy || !integration.manifest.healthCheck),
          domains: meta.domains,
          ...routingCapability(integration.providers.get("routing")),
        };
      }

      reply.header("Cache-Control", "public, max-age=60");
      // A bounded feature bit so a signed-out client can hide unreleased UI.
      // It reflects only the master flag and OAuth configuration — never the
      // direct-write kill switch and never a person's linked-account state.
      const parsed = capabilitiesResponseSchema.safeParse({
        services,
        features: { osmContributions: osmContributionsPubliclyEnabled() },
      });
      if (!parsed.success) throw new Error("Invalid capability metadata");
      return reply.send(parsed.data);
    },
  );
};
