import { createHash } from "node:crypto";
import {
  type EmailDisclosure,
  type IntegrationsResponse,
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

/**
 * Every value the public metadata payload is derived from, compared by identity.
 * It must cover every field `toIntegrationMeta` reads (guarded by a test). The
 * integration host replaces these values (a reload builds new objects;
 * `setDataSources` assigns a new array; `registerDisclosure` appends, which the
 * count and element entries catch) and never mutates below them in place.
 */
function metadataInputs(enabled: readonly LoadedIntegration[], emailKey: string | null): unknown[] {
  const key: unknown[] = [emailKey, enabled.length];
  for (const integration of enabled) {
    const { manifest } = integration;
    const disclosures = integration.disclosures ?? [];
    key.push(
      integration.id,
      integration.enabled,
      integration.isBuiltIn,
      integration.strings,
      manifest.name,
      manifest.description,
      manifest.domains,
      manifest.frontend,
      manifest.dataSources,
      manifest.healthCheck,
      disclosures.length,
      ...disclosures,
    );
  }
  return key;
}

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export const integrationsRoute: FastifyPluginAsync<IntegrationsRouteOptions> = async (
  app,
  options,
) => {
  declareRouteAuth(app, "public");
  // Per plugin instance, so routes registered with injected options never share it.
  let memo: { inputs: unknown[]; etag: string; body: IntegrationsResponse } | null = null;
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
      let email: EmailDisclosure | null = null;
      try {
        const getEmailDisclosure =
          options.getEmailDisclosure ?? (await import("../utils/email")).getEmailDisclosure;
        email = await getEmailDisclosure();
      } catch (err) {
        app.log.warn({ err }, "email disclosure unavailable; omitting from /api/integrations");
      }
      const getIntegrations =
        options.getIntegrations ?? (await import("../integration-host")).getAllIntegrations;
      // No await from here until the memo is stored: the inputs snapshot and the
      // payload built from it always belong to the same registry generation.
      const enabled = getIntegrations().filter((integration) => integration.enabled);
      const inputs = metadataInputs(enabled, email === null ? null : JSON.stringify(email));
      if (memo === null || !sameInputs(memo.inputs, inputs)) {
        const disclosures = enabled.flatMap((integration) => integration.disclosures ?? []);
        if (email !== null) disclosures.push(email);
        const parsed = integrationMetadataPayloadSchema.safeParse({
          integrations: enabled.map(toIntegrationMeta),
          frameworkStrings: sharedStrings,
          disclosures,
        });
        if (!parsed.success) throw new Error("Invalid integration metadata");
        const metadata = parsed.data;
        const revision = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
        memo = { inputs, etag: `"${revision}"`, body: { revision, ...metadata } };
      }
      const { etag, body } = memo;
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
      return body;
    },
  );
};
