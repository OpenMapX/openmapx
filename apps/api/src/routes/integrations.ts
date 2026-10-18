import { createHash } from "node:crypto";
import {
  type EmailDisclosure,
  integrationMetadataPayloadSchema,
  integrationsResponseSchema,
} from "@openmapx/core/api-contracts";
import { type LoadedIntegration, toIntegrationMeta } from "@openmapx/integration-framework";
import { sharedStrings } from "@openmapx/integration-framework/strings";
import type { FastifyPluginAsync } from "fastify";
import { declareRouteAuth } from "../utils/route-auth";
import { runtimeMetadataJsonSchema } from "./runtime-metadata-schemas";

interface IntegrationsRouteOptions {
  getIntegrations?: () => LoadedIntegration[];
  getEmailDisclosure?: () => Promise<EmailDisclosure>;
}

export const integrationsRoute: FastifyPluginAsync<IntegrationsRouteOptions> = async (
  app,
  options,
) => {
  declareRouteAuth(app, "public");
  app.addSchema(runtimeMetadataJsonSchema(integrationsResponseSchema, "IntegrationsResponse"));
  app.get(
    "/api/integrations",
    {
      schema: {
        operationId: "getApiIntegrations",
        tags: ["runtime-metadata"],
        headers: {
          type: "object",
          properties: {
            "if-none-match": {
              type: "string",
              description:
                "An ETag validator, including weak validators, a comma-separated list, or *.",
            },
          },
        },
        response: {
          200: {
            $ref: "IntegrationsResponse#",
            type: "object",
            headers: { ETag: { type: "string" }, "Cache-Control": { type: "string" } },
          },
          304: {
            type: "null",
            description: "The public metadata has not changed; no response body.",
            headers: { ETag: { type: "string" }, "Cache-Control": { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      const getIntegrations =
        options.getIntegrations ?? (await import("../integration-host")).getAllIntegrations;
      const enabled = getIntegrations().filter((integration) => integration.enabled);
      const disclosures = enabled.flatMap((integration) => integration.disclosures ?? []);
      try {
        const getEmailDisclosure =
          options.getEmailDisclosure ?? (await import("../utils/email")).getEmailDisclosure;
        disclosures.push(await getEmailDisclosure());
      } catch (err) {
        app.log.warn({ err }, "email disclosure unavailable; omitting from /api/integrations");
      }
      const parsed = integrationMetadataPayloadSchema.safeParse({
        integrations: enabled.map(toIntegrationMeta),
        frameworkStrings: sharedStrings,
        disclosures,
      });
      if (!parsed.success) throw new Error("Invalid integration metadata");
      const metadata = parsed.data;
      const revision = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
      const etag = `"${revision}"`;
      reply.header("Cache-Control", "private, no-cache").header("ETag", etag);
      const raw = request.headers["if-none-match"];
      const validators = typeof raw === "string" ? raw.split(",") : (raw ?? []);
      if (
        validators.some((validator) => {
          const candidate = validator.trim();
          return candidate === "*" || candidate.replace(/^W\//, "") === etag;
        })
      )
        return reply.status(304).send();
      return { revision, ...metadata };
    },
  );
};
