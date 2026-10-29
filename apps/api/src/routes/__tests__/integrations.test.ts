import { createHash } from "node:crypto";
import { integrationsResponseSchema } from "@openmapx/core/api-contracts";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { integrationsRoute } from "../integrations";

const app = Fastify({ logger: false });
afterEach(() => app.close());

function integration(): LoadedIntegration {
  return {
    id: "fixture",
    enabled: true,
    isBuiltIn: false,
    directory: "private-directory",
    config: { apiKey: "private-secret" },
    providers: new Map(),
    shutdownHandlers: [],
    manifest: {
      id: "fixture",
      domains: ["transit"],
      frontend: { layerSelector: { group: "map-details", labelKey: "fixture", preview: null } },
      healthCheck: [
        {
          type: "http",
          name: "Public",
          category: "Transit",
          url: "https://private.test",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: unresolved manifest placeholders must remain private.
          urlTemplate: "${apiKey}",
          headers: { Authorization: "private-header" },
          requiredConfigKeys: ["apiKey"],
        },
      ],
      dataSources: [
        {
          sourceId: "fixture-source",
          name: "Rich source",
          url: "https://example.test/data",
          domain: "transit",
          owner: "Dataset owner",
          providerCountry: "DE",
          providerPrivacyUrl: "https://example.test/privacy",
          termsUrl: "https://example.test/terms",
          methodologyUrl: "https://example.test/methodology",
          dataUseClass: "attribution",
          credentialOwner: "instance-operator",
          reviewedAt: "2026-10-18",
          apiHosts: ["api.example.test"],
          mediaHosts: ["images.example.test"],
          attribution: "Complete attribution",
          notes: "Privacy context",
          commercialUse: "conditional",
          redistribution: { sourceData: "conditional", derivedData: "yes" },
          usageConditions: ["Preserve notices"],
          endUserExposure: "proxied",
          personalData: true,
          cookies: false,
          dpaAvailable: true,
          dpaUrl: "https://example.test/dpa",
          licensing: {
            version: 1,
            bindings: [
              {
                scope: "data",
                subject: "Dataset",
                license: {
                  kind: "spdx",
                  expression: "CC-BY-4.0",
                  url: "https://example.test/license",
                },
                notice: "Source notice",
                conditions: ["Condition"],
                attribution: {
                  placement: "visible",
                  surfaces: ["map", "content"],
                  basis: "provider-terms",
                  reviewedAt: "2026-10-18",
                  evidenceUrls: ["https://example.test/terms"],
                  reason: "Required notice",
                  compactText: "Source",
                  logo: "mapillary",
                  prominence: "normal",
                  includePublisher: true,
                },
              },
            ],
            declarations: [{ text: "Original licence", url: "https://example.test/original" }],
          },
        },
      ],
    },
    strings: { en: { name: "Fixture", nested: { values: [1, null, false] } } },
    disclosures: [
      {
        type: "ai-search",
        integrationId: "fixture",
        aiActive: false,
        localActive: false,
        cloudActive: false,
        cloudProcessors: [],
        cloudAvailable: false,
        cloudConsentRequired: true,
        cloudProviderLabels: [],
      },
    ],
  };
}

describe("public integration metadata route", () => {
  it("serializes the public projection before hashing and preserves rich fields", async () => {
    const row = integration();
    await app.register(integrationsRoute, {
      getIntegrations: () => [row, { ...row, id: "disabled", enabled: false }],
      getEmailDisclosure: async () => ({
        type: "email",
        provider: "smtp",
        vendorName: "",
        countryCode: "",
        transfer: "none",
      }),
    });
    const response = await app.inject("/api/integrations");
    expect(response.statusCode).toBe(200);
    const body = integrationsResponseSchema.parse(response.json());
    expect(body.integrations).toHaveLength(1);
    expect(body.integrations[0]?.isBuiltIn).toBe(false);
    expect(body.integrations[0]?.healthCheck).toEqual([
      { type: "http", name: "Public", category: "Transit" },
    ]);
    expect(body.integrations[0]?.strings?.en?.nested).toEqual({ values: [1, null, false] });
    expect(body.integrations[0]?.frontend?.layerSelector?.preview).toBeNull();
    expect(body.integrations[0]?.dataSources).toEqual(row.manifest.dataSources);
    expect(body.disclosures).toHaveLength(2);
    expect(response.body).not.toContain("private-");
    const { revision, ...metadata } = body;
    expect(revision).toBe(createHash("sha256").update(JSON.stringify(metadata)).digest("hex"));
    expect(response.headers.etag).toBe(`"${revision}"`);
    expect(response.headers["cache-control"]).toBe("private, no-cache");
    for (const validator of [`"${revision}"`, `W/"${revision}"`, `"other", W/"${revision}"`, "*"]) {
      const cached = await app.inject({
        url: "/api/integrations",
        headers: { "if-none-match": validator },
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe("");
    }
    row.config.apiKey = "private-changed";
    expect((await app.inject("/api/integrations")).headers.etag).toBe(response.headers.etag);
    row.strings.en = { name: "Changed" };
    expect((await app.inject("/api/integrations")).headers.etag).not.toBe(response.headers.etag);
  });

  it("omits unavailable email disclosure without weakening required payload fields", async () => {
    const isolated = Fastify({ logger: false });
    const unavailable = vi.fn().mockRejectedValue(new Error("private-provider-error"));
    await isolated.register(integrationsRoute, {
      getIntegrations: () => [],
      getEmailDisclosure: unavailable,
    });
    const response = await isolated.inject("/api/integrations");
    expect(response.statusCode).toBe(200);
    expect(integrationsResponseSchema.parse(response.json()).disclosures).toEqual([]);
    expect(response.body).not.toContain("private-provider-error");
    await isolated.close();
  });

  it("rejects malformed producer metadata without publishing validation issues", async () => {
    const isolated = Fastify({ logger: false });
    const row = integration();
    await isolated.register(integrationsRoute, {
      getIntegrations: () => [row],
      getEmailDisclosure: async () =>
        ({
          type: "email",
          provider: "smtp",
          vendorName: "",
          countryCode: "",
          transfer: "none",
          privateField: "private-secret",
        }) as never,
    });
    const response = await isolated.inject("/api/integrations");
    expect(response.statusCode).toBe(500);
    expect(response.json().message).toBe("Invalid integration metadata");
    expect(response.body).not.toContain("privateField");
    expect(response.body).not.toContain("private-secret");
    await isolated.close();
  });
});
