import { createHash } from "node:crypto";
import { createApiClient } from "@openmapx/core";
import type {
  CapabilitiesResponse,
  EmailDisclosure,
  IntegrationsResponse,
} from "@openmapx/core/api-contracts";
import { getApiCapabilities, getApiIntegrations } from "@openmapx/core/api-sdk";
import type { LoadedIntegration } from "@openmapx/integration-framework";
import { sharedStrings } from "@openmapx/integration-framework/strings";
import type { LicenseDescriptor } from "@openmapx/mobility-core/licensing";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  integrations: [] as LoadedIntegration[],
  healthy: new Set<string>(),
}));
vi.mock("../../integration-host.js", () => ({ getAllIntegrations: () => runtime.integrations }));
vi.mock("../../services/integration-health.js", () => ({
  isIntegrationHealthy: (id: string) => runtime.healthy.has(id),
}));
vi.mock("../../utils/osm-config.js", () => ({ osmContributionsPubliclyEnabled: () => false }));

const { capabilitiesRoute } = await import("../capabilities");
const { integrationsRoute } = await import("../integrations");

const descriptorVariants: LicenseDescriptor[] = [
  { kind: "spdx", expression: "MIT OR Apache-2.0", url: "https://example.test/licenses" },
  {
    kind: "custom",
    id: "LicenseRef-Provider",
    namespace: "publisher:example",
    name: "Provider terms",
    version: "v1",
    url: "https://example.test/terms",
  },
  { kind: "unknown", raw: "Review pending", url: "https://example.test/pending" },
  { kind: "per-item", raw: "Set by publisher", url: "https://example.test/items" },
  { kind: "public-domain", name: "Government works", url: "https://example.test/domain" },
  { kind: "status", id: "CC-PDM-1.0", url: "https://creativecommons.org/publicdomain/mark/1.0/" },
];

function richIntegration(): LoadedIntegration {
  return {
    id: "rich",
    enabled: true,
    isBuiltIn: true,
    directory: "private-sdk-directory",
    config: { token: "private-sdk-token" },
    providers: new Map([["secret-provider", ["private-sdk-provider"]]]),
    shutdownHandlers: [],
    manifest: {
      id: "rich",
      description: "Complete metadata",
      domains: ["transit", "weather"],
      frontend: {
        mapLayer: true,
        sharedMapLayer: "shared-transit",
        legend: true,
        panel: true,
        searchCategory: {
          id: "transit",
          label: "Transit",
          showInChipBar: true,
          iconPath: "icons/transit.svg",
        },
        layerSelector: {
          group: "map-details",
          labelKey: "layers.transit",
          icon: "train",
          preview: null,
          quickSelector: true,
        },
        overlay: {
          excludes: ["other-layer"],
          minZoom: 7,
          legend: {
            kind: "categorical",
            title: "Transit",
            titleKey: "legend.title",
            items: [{ color: "#123456", label: "Rail", labelKey: "legend.rail" }],
            stops: [{ value: 1, color: "#654321" }],
          },
        },
      },
      healthCheck: {
        type: "http",
        name: "Service",
        category: "Transit",
        url: "https://private-sdk-host.test",
        headers: { Authorization: "private-sdk-header" },
        requiredConfigKeys: ["private-sdk-key"],
        urlTemplate: "https://private-sdk-template.test",
      },
      dataSources: [
        {
          sourceId: "rich-source",
          domain: "transit",
          name: "Published data",
          url: "https://example.test/data",
          owner: "Publisher",
          termsUrl: "https://example.test/terms",
          methodologyUrl: "https://example.test/methodology",
          dataUseClass: "attribution",
          credentialOwner: "instance-operator",
          reviewedAt: "2026-10-18",
          apiHosts: ["api.example.test"],
          mediaHosts: ["cdn.example.test/images/"],
          attribution: "Complete publisher credit",
          notes: "Privacy context",
          commercialUse: "conditional",
          redistribution: { sourceData: "conditional", derivedData: "yes" },
          usageConditions: ["Preserve notices"],
          providerCountry: "DE",
          providerPrivacyUrl: "https://example.test/privacy",
          endUserExposure: "proxied",
          personalData: true,
          cookies: false,
          dpaAvailable: true,
          dpaUrl: "https://example.test/dpa",
          licensing: {
            version: 1,
            bindings: descriptorVariants.map((license) => ({
              scope: "data",
              subject: "Published data",
              license,
              notice: "Full notice",
              conditions: ["Link the terms"],
              attribution: {
                placement: "visible",
                surfaces: ["map", "content", "image"],
                basis: "provider-terms",
                reviewedAt: "2026-10-18",
                evidenceUrls: ["https://example.test/terms"],
                reason: "Reviewed requirement",
                compactText: "© Publisher",
                logo: "maptiler",
                prominence: "normal",
                includePublisher: true,
              },
            })),
            declarations: [{ text: "Original declaration", url: "https://example.test/original" }],
          },
        },
      ],
    },
    strings: {
      en: {
        name: "Rich metadata",
        nested: { array: ["text", 4, true, null, { deeper: [false, { leaf: "kept" }] }] },
      },
      de: { name: "Metadaten", empty: {} },
    },
    disclosures: [
      {
        type: "ai-search",
        integrationId: "rich",
        aiActive: true,
        localActive: true,
        cloudActive: false,
        cloudProcessors: [
          {
            id: "cloud",
            name: "Optional cloud",
            countryCode: "VARIES",
            privacyUrl: "https://example.test/cloud-privacy",
          },
        ],
        cloudAvailable: true,
        cloudConsentRequired: true,
        cloudProviderLabels: ["Optional cloud"],
      },
    ],
  };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  app = undefined;
  runtime.integrations = [];
  runtime.healthy.clear();
});

async function boundary(
  options: {
    email?: () => Promise<EmailDisclosure>;
    corrupt?: (body: Record<string, unknown>) => unknown;
  } = {},
) {
  const rich = richIntegration();
  const arrayHealth: LoadedIntegration = {
    ...richIntegration(),
    id: "array-health",
    isBuiltIn: false,
    disclosures: [],
    manifest: {
      id: "array-health",
      domains: ["weather"],
      healthCheck: [
        { type: "tcp", name: "Socket", category: "Weather", url: "private-sdk-socket" },
      ],
    },
  };
  const disabled: LoadedIntegration = { ...richIntegration(), id: "disabled", enabled: false };
  runtime.integrations = [rich, arrayHealth, disabled];
  runtime.healthy.add("array-health");
  let email: EmailDisclosure = {
    type: "email",
    provider: "smtp",
    vendorName: "",
    countryCode: "",
    transfer: "none",
  };
  app = Fastify({ logger: false });
  await app.register(capabilitiesRoute, { prefix: "/api" });
  await app.register(integrationsRoute, {
    getIntegrations: () => runtime.integrations,
    getEmailDisclosure: options.email ?? (async () => email),
  });
  await app.ready();
  const server = app;
  const wire: { status: number; body: string; headers: Headers }[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const reply = await server.inject({
      method: init.method as "GET",
      url: `${url.pathname}${url.search}`,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    });
    const headers = new Headers();
    for (const [name, value] of Object.entries(reply.headers)) {
      if (value !== undefined)
        for (const item of Array.isArray(value) ? value : [value])
          headers.append(name, String(item));
    }
    wire.push({ status: reply.statusCode, body: reply.body, headers });
    const body =
      reply.statusCode === 200 && options.corrupt
        ? JSON.stringify(options.corrupt(JSON.parse(reply.body)))
        : reply.body;
    return new Response(reply.statusCode === 304 ? null : body, {
      status: reply.statusCode,
      headers,
    });
  });
  return {
    rich,
    wire,
    client: createApiClient({ baseUrl: "https://sdk.example.test", credentials: "omit" }),
    setEmail: (next: EmailDisclosure) => {
      email = next;
    },
  };
}

describe("producer → Fastify JSON → generated runtime metadata SDK", () => {
  it("decodes complete capabilities including disabled services and the public cache policy", async () => {
    const { client, wire } = await boundary();
    const response = await getApiCapabilities({ client });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({
      services: {
        rich: { enabled: true, healthy: false, available: false, domains: ["transit", "weather"] },
        "array-health": { enabled: true, healthy: true, available: true, domains: ["weather"] },
        disabled: {
          enabled: false,
          healthy: false,
          available: false,
          domains: ["transit", "weather"],
        },
      },
      features: { osmContributions: false },
    });
    expect(response.headers.get("cache-control")).toBe("public, max-age=60");
    expect(wire[0]?.body).not.toContain("private-sdk-");
    expect(wire[0]?.body).not.toContain("configured");
  });

  it("preserves rich public metadata through actual serialization and generated validation", async () => {
    const { rich, client, wire } = await boundary();
    const response = await getApiIntegrations(undefined, { client });
    expect(response.status).toBe(200);
    if (response.status !== 200) throw new Error("Expected initial metadata response");
    expect(response.data.integrations.map((row) => row.id)).toEqual(["rich", "array-health"]);
    const row = response.data.integrations[0];
    expect(row?.dataSources).toEqual(rich.manifest.dataSources);
    expect(row?.frontend).toEqual(rich.manifest.frontend);
    expect(row?.strings).toEqual(rich.strings);
    expect(row?.isBuiltIn).toBe(true);
    expect(row?.healthCheck).toEqual({ type: "http", name: "Service", category: "Transit" });
    expect(response.data.integrations[1]?.healthCheck).toEqual([
      { type: "tcp", name: "Socket", category: "Weather" },
    ]);
    expect(response.data.frameworkStrings).toEqual(sharedStrings);
    expect(response.data.disclosures).toEqual([
      ...(rich.disclosures ?? []),
      { type: "email", provider: "smtp", vendorName: "", countryCode: "", transfer: "none" },
    ]);
    for (const item of response.data.integrations) {
      expect(item).not.toHaveProperty("config");
      expect(item).not.toHaveProperty("directory");
      expect(item).not.toHaveProperty("providers");
    }
    expect(wire[0]?.body).not.toContain("private-sdk-");
    const { revision, ...payload } = response.data;
    expect(revision).toBe(createHash("sha256").update(JSON.stringify(payload)).digest("hex"));
    expect(response.headers.get("etag")).toBe(`"${revision}"`);
    expect(response.headers.get("cache-control")).toBe("private, no-cache");
  });

  it("revalidates using the generated header argument and rotates only for public changes", async () => {
    const { rich, client, wire, setEmail } = await boundary();
    const initial = await getApiIntegrations(undefined, { client });
    if (initial.status !== 200) throw new Error("Expected initial metadata response");
    const etag = initial.headers.get("etag");
    if (!etag) throw new Error("Missing metadata validator");
    rich.config.token = "private-sdk-changed";
    rich.directory = "private-sdk-other-directory";
    for (const validator of [etag, `W/${etag}`, `"unrelated", W/${etag}`, "*"]) {
      const unchanged = await getApiIntegrations({ "if-none-match": validator }, { client });
      expect(unchanged.status).toBe(304);
      expect(unchanged.data).toBeUndefined();
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(wire.at(-1)?.body).toBe("");
    }
    rich.strings.en = { name: "Changed public name" };
    const changed = await getApiIntegrations({ "if-none-match": etag }, { client });
    expect(changed.status).toBe(200);
    if (changed.status !== 200) throw new Error("Expected changed metadata response");
    expect(changed.data.revision).not.toBe(initial.data.revision);
    setEmail({
      type: "email",
      provider: "smtp",
      vendorName: "New public vendor",
      countryCode: "DE",
      transfer: "eea",
    });
    const disclosureChanged = await getApiIntegrations(undefined, { client });
    expect(disclosureChanged.status).toBe(200);
    if (disclosureChanged.status !== 200) throw new Error("Expected changed disclosure response");
    expect(disclosureChanged.data.revision).not.toBe(changed.data.revision);
  });

  it("keeps valid metadata and AI disclosure when email acquisition fails", async () => {
    const { client } = await boundary({
      email: async () => {
        throw new Error("private-sdk-email-error");
      },
    });
    const result = await getApiIntegrations(undefined, { client });
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error("Expected metadata without email disclosure");
    expect(result.data.integrations).toHaveLength(2);
    expect(result.data.disclosures.map((disclosure) => disclosure.type)).toEqual(["ai-search"]);
    expect(JSON.stringify(result.data)).not.toContain("private-sdk-email-error");
  });

  it.each([
    "missing-feature",
    "invalid-revision",
    "invalid-catalog-root",
    "invalid-license-kind",
  ] as const)(
    "rejects malformed successful %s data through the actual generated operation",
    async (kind) => {
      const { client } = await boundary({
        corrupt: (body) => {
          if (kind === "missing-feature") delete body.features;
          else if (kind === "invalid-revision") body.revision = "private-sdk-invalid-revision";
          else if (kind === "invalid-catalog-root")
            body.frameworkStrings = { en: ["private-sdk-invalid-catalog"] };
          else
            body.integrations = [
              {
                id: "bad",
                name: "Bad",
                enabled: true,
                isBuiltIn: true,
                domains: [],
                dataSources: [
                  {
                    sourceId: "bad",
                    name: "Bad",
                    url: "https://example.test",
                    providerCountry: "DE",
                    providerPrivacyUrl: "https://example.test/privacy",
                    licensing: {
                      version: 1,
                      bindings: [
                        {
                          scope: "data",
                          subject: "Data",
                          license: { kind: "private-sdk-invalid-license" },
                        },
                      ],
                    },
                  },
                ],
              },
            ];
          return body;
        },
      });
      const request =
        kind === "missing-feature"
          ? getApiCapabilities({ client })
          : getApiIntegrations(undefined, { client });
      const error = await request.catch((value: unknown) => value);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: "ApiContractError", status: 200 });
      expect(String(error)).not.toContain("private-sdk-");
      expect(JSON.stringify(error)).not.toContain("private-sdk-");
    },
  );

  it("retains canonical response assignability and meaningful recursive JSON types", () => {
    type Capabilities200 = Awaited<ReturnType<typeof getApiCapabilities>>["data"];
    type Integrations200 = Extract<
      Awaited<ReturnType<typeof getApiIntegrations>>,
      { status: 200 }
    >["data"];
    expectTypeOf<Capabilities200>().toExtend<CapabilitiesResponse>();
    expectTypeOf<Integrations200>().toExtend<IntegrationsResponse>();
    const catalog: Integrations200["frameworkStrings"] = {
      en: { nested: { values: [null, true, 3, { label: "typed" }] } },
    };
    const invalidCatalog: Integrations200["frameworkStrings"] = {
      // @ts-expect-error Functions are not JSON, even several levels inside a catalog.
      en: { nested: { callback: () => "invalid" } },
    };
    expect(catalog.en).toHaveProperty("nested");
    void invalidCatalog;
  });
});
