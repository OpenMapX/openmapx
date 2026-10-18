import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import {
  capabilitiesResponseSchema,
  integrationMetadataPayloadSchema,
  integrationsResponseSchema,
  localeStringsSchema,
} from "./runtime-metadata";

describe("runtime metadata wire contracts", () => {
  it("requires the actual capability fields and rejects invented fields", () => {
    const response = {
      services: {
        transit: { enabled: true, healthy: false, available: false, domains: ["transit"] },
      },
      features: { osmContributions: false },
    };
    expect(capabilitiesResponseSchema.parse(response)).toEqual(response);
    expect(capabilitiesResponseSchema.safeParse({ services: {} }).success).toBe(false);
    expect(capabilitiesResponseSchema.safeParse({ ...response, secret: "private" }).success).toBe(
      false,
    );
    expect(
      capabilitiesResponseSchema.safeParse({
        ...response,
        services: { transit: { ...response.services.transit, configured: true } },
      }).success,
    ).toBe(false);
  });

  it("preserves complete nested metadata and both legal disclosure variants", () => {
    const payload = {
      integrations: [
        {
          id: "fixture",
          name: "Fixture",
          enabled: true,
          isBuiltIn: false,
          domains: ["transit"],
          frontend: {
            layerSelector: { group: "map-details", labelKey: "fixture", preview: null },
            overlay: { legend: { kind: "ramp", stops: [{ value: 1, color: "red" }] } },
          },
          healthCheck: [{ type: "http", name: "Probe", category: "Transit" }],
          strings: {
            en: { title: "Fixture", nested: { list: [1, true, null, { child: "value" }] } },
          },
          dataSources: [
            {
              sourceId: "fixture",
              name: "Source",
              url: "https://example.test",
              providerCountry: "DE",
              providerPrivacyUrl: "https://example.test/privacy",
              owner: "Owner",
              apiHosts: ["api.example.test"],
              redistribution: { sourceData: "conditional", derivedData: "yes" },
              usageConditions: ["Retain notice"],
              licensing: {
                version: 1,
                bindings: [
                  {
                    scope: "data",
                    subject: "Dataset",
                    license: {
                      kind: "custom",
                      id: "LicenseRef-Fixture",
                      namespace: "fixture",
                      name: "Terms",
                    },
                    notice: "Complete notice",
                    conditions: ["Keep credit"],
                  },
                ],
                declarations: [{ text: "Original declaration" }],
              },
            },
          ],
        },
      ],
      frameworkStrings: { en: { shared: { nested: [null, 1, true, "label"] } } },
      disclosures: [
        {
          type: "ai-search",
          integrationId: "fixture",
          aiActive: true,
          localActive: false,
          cloudActive: true,
          cloudProcessors: [
            {
              id: "router",
              name: "Router",
              countryCode: "VARIES",
              privacyUrl: "https://example.test/privacy",
            },
          ],
          cloudAvailable: true,
          cloudConsentRequired: true,
          cloudProviderLabels: ["Router"],
        },
        { type: "email", provider: "smtp", vendorName: "", countryCode: "", transfer: "none" },
      ],
    };
    expect(integrationMetadataPayloadSchema.parse(payload)).toEqual(payload);
    expect(integrationsResponseSchema.parse({ revision: "a".repeat(64), ...payload })).toEqual({
      revision: "a".repeat(64),
      ...payload,
    });
    expect(integrationsResponseSchema.safeParse({ revision: "invalid", ...payload }).success).toBe(
      false,
    );
    expect(
      integrationMetadataPayloadSchema.safeParse({ ...payload, disclosures: undefined }).success,
    ).toBe(false);
    expect(
      integrationMetadataPayloadSchema.safeParse({
        ...payload,
        integrations: [
          { ...payload.integrations[0], healthCheck: { type: "http", url: "private" } },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts recursive JSON values but requires locale object roots", () => {
    expect(
      localeStringsSchema.parse({ en: { nested: [null, { number: 2, flag: true }] } }),
    ).toEqual({ en: { nested: [null, { number: 2, flag: true }] } });
    expect(localeStringsSchema.safeParse({ en: ["not", "a", "catalog"] }).success).toBe(false);
    expect(localeStringsSchema.safeParse({ en: { bad: undefined } }).success).toBe(false);
  });

  it("emits fully representable recursive response schemas", () => {
    const json = z.toJSONSchema(integrationsResponseSchema, { target: "draft-7", io: "output" });
    expect(JSON.stringify(json)).toContain("revision");
    expect(JSON.stringify(json)).toContain("license");
    expect(JSON.stringify(json)).toContain("$ref");
  });
});
