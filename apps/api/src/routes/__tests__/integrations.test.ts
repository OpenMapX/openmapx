import { createHash } from "node:crypto";
import {
  type EmailDisclosure,
  integrationMetadataPayloadSchema,
  integrationsResponseSchema,
} from "@openmapx/core/api-contracts";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import { toIntegrationMeta } from "@openmapx/integration-framework";
import Fastify from "fastify";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { integrationsRoute } from "../integrations";

vi.mock("@openmapx/integration-framework", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/integration-framework")>();
  return { ...actual, toIntegrationMeta: vi.fn(actual.toIntegrationMeta) };
});

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
    loadState: "loaded",
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
        cloudRequiresSignIn: false,
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
    // The host replaces strings (a reload builds new objects); it never edits them in place.
    row.strings = { ...row.strings, en: { name: "Changed" } };
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

  it("serves an AI-search disclosure that does not state cloudRequiresSignIn", async () => {
    const isolated = Fastify({ logger: false });
    const row = integration();
    const { cloudRequiresSignIn: _omitted, ...withoutSignIn } = row.disclosures?.[0] as Record<
      string,
      unknown
    >;
    await isolated.register(integrationsRoute, {
      getIntegrations: () => [{ ...row, disclosures: [withoutSignIn] } as typeof row],
      getEmailDisclosure: vi.fn().mockRejectedValue(new Error("no mail provider")),
    });

    const response = await isolated.inject("/api/integrations");

    expect(response.statusCode).toBe(200);
    const body = integrationsResponseSchema.parse(response.json());
    expect(body.disclosures).toHaveLength(1);
    expect(body.disclosures[0]).not.toHaveProperty("cloudRequiresSignIn");
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

describe("integration metadata memo", () => {
  const metaSpy = vi.mocked(toIntegrationMeta);
  const parseSpy = vi.spyOn(integrationMetadataPayloadSchema, "safeParse");

  function smtpEmail(): EmailDisclosure {
    return { type: "email", provider: "smtp", vendorName: "", countryCode: "", transfer: "none" };
  }

  async function memoApp(initial: { list: LoadedIntegration[]; email?: EmailDisclosure | Error }) {
    const state = { list: initial.list, email: initial.email ?? smtpEmail() };
    const isolated = Fastify({ logger: false });
    await isolated.register(integrationsRoute, {
      getIntegrations: () => state.list,
      getEmailDisclosure: async () => {
        if (state.email instanceof Error) throw state.email;
        return { ...state.email };
      },
    });
    const get = (etag?: string) =>
      isolated.inject({
        url: "/api/integrations",
        headers: etag === undefined ? {} : { "if-none-match": etag },
      });
    metaSpy.mockClear();
    parseSpy.mockClear();
    return { isolated, state, get };
  }

  it("reuses the memo for unchanged inputs on 200 and 304", async () => {
    const { isolated, get } = await memoApp({ list: [integration()] });
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(metaSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    const second = await get();
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe(first.body);
    expect(second.headers.etag).toBe(first.headers.etag);
    expect(metaSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    const cached = await get(first.headers.etag as string);
    expect(cached.statusCode).toBe(304);
    expect(cached.body).toBe("");
    expect(cached.headers.etag).toBe(first.headers.etag);
    expect(cached.headers["cache-control"]).toBe("private, no-cache");
    expect(metaSpy).toHaveBeenCalledTimes(1);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    await isolated.close();
  });

  it("rebuilds when the enabled set changes and returns to the same ETag", async () => {
    const a = integration();
    const b = { ...integration(), id: "second" };
    const { isolated, state, get } = await memoApp({ list: [a] });
    const e1 = (await get()).headers.etag as string;

    state.list = [a, b];
    const changed = await get(e1);
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(e1);
    expect(integrationsResponseSchema.parse(changed.json()).integrations).toHaveLength(2);

    parseSpy.mockClear();
    state.list = [a];
    expect((await get()).headers.etag).toBe(e1);
    expect(parseSpy).toHaveBeenCalledTimes(1);
    await isolated.close();
  });

  it("drops an integration disabled in place", async () => {
    const a = integration();
    const { isolated, get } = await memoApp({ list: [a] });
    const e1 = (await get()).headers.etag;

    a.enabled = false;
    const response = await get();
    expect(response.headers.etag).not.toBe(e1);
    expect(integrationsResponseSchema.parse(response.json()).integrations).toEqual([]);
    await isolated.close();
  });

  it("rebuilds for a replaced integration object", async () => {
    const a = integration();
    const { isolated, state, get } = await memoApp({ list: [a] });
    const e1 = (await get()).headers.etag;

    state.list = [{ ...a, strings: { en: { name: "Other" } } }];
    const response = await get();
    expect(response.headers.etag).not.toBe(e1);
    expect(integrationsResponseSchema.parse(response.json()).integrations[0]?.name).toBe("Other");
    await isolated.close();
  });

  it("serves runtime data sources assigned to the same live integration", async () => {
    const a = integration();
    const { isolated, get } = await memoApp({ list: [a] });
    const e1 = (await get()).headers.etag;

    const [source] = a.manifest.dataSources ?? [];
    assert.isDefined(source);
    a.manifest.dataSources = [{ ...source, sourceId: "runtime-source", name: "Runtime source" }];
    const response = await get();
    expect(response.headers.etag).not.toBe(e1);
    expect(integrationsResponseSchema.parse(response.json()).integrations[0]?.dataSources).toEqual(
      a.manifest.dataSources,
    );
    await isolated.close();
  });

  it("rebuilds for replaced and appended disclosures", async () => {
    const a = integration();
    const { isolated, get } = await memoApp({ list: [a] });
    const e1 = (await get()).headers.etag;

    const [disclosure] = a.disclosures ?? [];
    a.disclosures = [{ ...disclosure, aiActive: true } as NonNullable<typeof disclosure>];
    const replaced = await get();
    expect(replaced.headers.etag).not.toBe(e1);
    const before = integrationsResponseSchema.parse(replaced.json()).disclosures.length;

    a.disclosures.push({ ...disclosure, integrationId: "other" } as NonNullable<typeof disclosure>);
    const appended = await get();
    expect(appended.headers.etag).not.toBe(replaced.headers.etag);
    expect(integrationsResponseSchema.parse(appended.json()).disclosures).toHaveLength(before + 1);
    await isolated.close();
  });

  it("keys the email disclosure by content", async () => {
    const { isolated, state, get } = await memoApp({ list: [integration()] });
    const e1 = (await get()).headers.etag;
    expect((await get()).headers.etag).toBe(e1);
    expect(parseSpy).toHaveBeenCalledTimes(1);

    state.email = { ...smtpEmail(), vendorName: "Mail vendor" };
    const changed = await get();
    expect(changed.headers.etag).not.toBe(e1);
    expect(parseSpy).toHaveBeenCalledTimes(2);
    await isolated.close();
  });

  it("neither sticks to nor is poisoned by an email lookup failure", async () => {
    const { isolated, state, get } = await memoApp({
      list: [integration()],
      email: new Error("mail down"),
    });
    const failed = await get();
    expect(failed.statusCode).toBe(200);
    const eFail = failed.headers.etag;
    expect(
      integrationsResponseSchema.parse(failed.json()).disclosures.some((d) => d.type === "email"),
    ).toBe(false);

    state.email = smtpEmail();
    const recovered = await get();
    expect(recovered.headers.etag).not.toBe(eFail);
    expect(
      integrationsResponseSchema
        .parse(recovered.json())
        .disclosures.some((d) => d.type === "email"),
    ).toBe(true);

    state.email = new Error("mail down again");
    expect((await get()).headers.etag).toBe(eFail);
    await isolated.close();
  });

  it("never memoizes a validation failure or serves stale metadata for it", async () => {
    const { isolated, state, get } = await memoApp({ list: [integration()] });
    const ok = await get();
    expect(ok.statusCode).toBe(200);
    const e1 = ok.headers.etag;

    state.email = { ...smtpEmail(), privateField: "private-secret" } as never;
    const failed = await get();
    expect(failed.statusCode).toBe(500);
    expect(failed.json().message).toBe("Invalid integration metadata");

    state.email = smtpEmail();
    const restored = await get();
    expect(restored.statusCode).toBe(200);
    expect(restored.headers.etag).toBe(e1);
    await isolated.close();
  });

  it("toIntegrationMeta reads only fields the /api/integrations memo key covers", async () => {
    const actual = await vi.importActual<typeof import("@openmapx/integration-framework")>(
      "@openmapx/integration-framework",
    );
    const base = integration();
    const manifestReads = new Set<PropertyKey>();
    const integrationReads = new Set<PropertyKey>();
    const manifest = new Proxy(
      { ...base.manifest, name: "Manifest name", description: "Manifest description" },
      {
        get(target, prop, receiver) {
          manifestReads.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    const wrapped = new Proxy(
      { ...base, strings: {}, manifest },
      {
        get(target, prop, receiver) {
          integrationReads.add(prop);
          return Reflect.get(target, prop, receiver);
        },
      },
    );

    actual.toIntegrationMeta(wrapped);

    for (const prop of integrationReads) {
      expect(["id", "enabled", "isBuiltIn", "strings", "manifest", "disclosures"]).toContain(prop);
    }
    for (const prop of manifestReads) {
      expect([
        "name",
        "description",
        "domains",
        "frontend",
        "dataSources",
        "healthCheck",
      ]).toContain(prop);
    }
    expect(manifestReads.has("healthCheck")).toBe(true);
    expect(manifestReads.has("name")).toBe(true);
  });
});
