import { describe, expect, it } from "vitest";
import { validateExtensionManifest } from "./extension";
import { COMPONENT_ID_PATTERN, componentIdSchema, isComponentId } from "./identifiers";
import { validateDataSource, validateManifest } from "./integration";
import { compareSemver, isSemver } from "./semver";
import { validateServiceManifest } from "./service";

const communityIntegration = {
  id: "acme-weather",
  version: "1.2.0",
  platform: "1.0",
  domains: ["weather"],
  quality: "community",
};

const communityService = {
  id: "acme-router",
  name: "Acme router",
  version: "1.0.0",
  platform: "1.0",
  quality: "community",
  container: {
    image: "ghcr.io/acme/router",
    tag: "1.0.0",
    digest: `sha256:${"a".repeat(64)}`,
    expose: [8080],
    memory: "256m",
  },
};

const extension = {
  id: "acme",
  name: "Acme",
  version: "1.0.0",
  platform: "1.0",
  integrations: [
    {
      artifact: "https://example.test/acme-weather.tar.gz",
      sha256: "b".repeat(64),
      id: "acme-weather",
    },
  ],
};

const community = { firstParty: false };
const builtIn = { firstParty: true };

describe("component ids", () => {
  it.each(["a", "osm", "live-transit-entur", "a1-b2", "x".repeat(48)])("accepts %s", (id) => {
    expect(isComponentId(id)).toBe(true);
    expect(componentIdSchema.safeParse(id).success).toBe(true);
    expect(COMPONENT_ID_PATTERN.test(id)).toBe(true);
  });

  it.each(["", "a--b", "abc-", "-abc", "Abc", "a_b", "a.b", "x".repeat(49)])("refuses %s", (id) => {
    expect(isComponentId(id)).toBe(false);
    expect(componentIdSchema.safeParse(id).success).toBe(false);
    expect(COMPONENT_ID_PATTERN.test(id)).toBe(false);
  });

  it("applies to every manifest kind and to bundle component references", () => {
    expect(validateManifest({ ...communityIntegration, id: "a--b" }, community).valid).toBe(false);
    expect(validateServiceManifest({ ...communityService, id: "abc-" }, community).valid).toBe(
      false,
    );
    expect(validateExtensionManifest({ ...extension, id: "x".repeat(49) }).valid).toBe(false);
    expect(
      validateExtensionManifest({
        ...extension,
        integrations: [{ ...extension.integrations[0], id: "a--b" }],
      }).valid,
    ).toBe(false);
    expect(
      validateExtensionManifest({
        ...extension,
        config: [{ key: "k", target: `integration:${"x".repeat(49)}` }],
      }).valid,
    ).toBe(false);
  });
});

describe("community integration manifests", () => {
  it("accept a manifest that states protocol and semantic version", () => {
    expect(validateManifest(communityIntegration, community)).toEqual({ valid: true, errors: [] });
  });

  it.each(["platform", "version"])("require %s", (key) => {
    const { [key as keyof typeof communityIntegration]: _, ...rest } = communityIntegration;
    expect(validateManifest(rest, community).valid).toBe(false);
    expect(validateManifest(rest, builtIn).valid).toBe(true);
  });

  it.each(["1", "1.0", "v1.0.0", "latest", "1.0.0.0"])("refuse version %s", (version) => {
    expect(validateManifest({ ...communityIntegration, version }, community).valid).toBe(false);
  });

  it("refuse an unknown top-level key", () => {
    const result = validateManifest({ ...communityIntegration, platfrom: "1.0" }, community);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("platfrom");
  });

  it("refuse any quality label but community", () => {
    for (const quality of ["built-in", "community-verified"])
      expect(validateManifest({ ...communityIntegration, quality }, community).valid).toBe(false);
  });

  it("refuse a required capability that is neither well-known nor namespaced", () => {
    const requires = (capability: string) => [{ capability, optional: true }];
    expect(
      validateManifest({ ...communityIntegration, requires: requires("geocoder") }, community)
        .valid,
    ).toBe(true);
    expect(
      validateManifest({ ...communityIntegration, requires: requires("acme/router") }, community)
        .valid,
    ).toBe(true);
    expect(
      validateManifest({ ...communityIntegration, requires: requires("router") }, community).errors,
    ).toEqual([
      'requires[0].capability: "router" is neither a well-known capability nor namespaced as "<vendor>/<name>"',
    ]);
  });

  it("leave no community-verified label for built-in manifests either", () => {
    expect(
      validateManifest({ ...communityIntegration, quality: "community-verified" }, builtIn).valid,
    ).toBe(false);
  });
});

describe("code, migration, panel and slot declarations", () => {
  const base = { id: "demo", version: "1.0.0", platform: "1.0", domains: ["knowledge"] };
  const validSource = {
    sourceId: "example-feed",
    name: "Example publisher",
    url: "https://example.test/",
    providerCountry: "DE",
    providerPrivacyUrl: "https://example.test/privacy",
    licensing: {
      version: 1,
      bindings: [
        { scope: "data", subject: "Readings", license: { kind: "spdx", expression: "CC-BY-4.0" } },
      ],
    },
  };

  it("refuses the removed backend.cron by name", () => {
    const result = validateManifest({ ...base, backend: { cron: "0 * * * *" } }, community);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/backend.*cron/);
  });

  it("accepts a full code-bearing community manifest", () => {
    expect(
      validateManifest(
        {
          ...base,
          webPlatform: "1.0",
          backend: { routes: true, entry: "dist/backend/index.mjs" },
          database: { migrations: true },
          frontend: {
            entry: "dist/web/index.mjs",
            mapLayer: true,
            legend: true,
            legendKind: "toolbar",
            panel: { detents: "place" },
            mapControl: true,
            layerSelector: { group: "map-details", labelKey: "layer", section: "transport" },
            overlay: { id: "demo-reports" },
          },
          subjectData: {
            storesPersonalData: true,
            strategy: "collector",
            registrationIds: ["demo-reports"],
            operatorInstructions: null,
            registrations: [{ id: "demo-reports" }],
          },
        },
        community,
      ),
    ).toEqual({ valid: true, errors: [] });
    expect(validateManifest({ ...base, frontend: { panel: {} } }, community).valid).toBe(true);
  });

  it("accepts declarations without an entry and migrations without a postgis requirement", () => {
    for (const fields of [
      { backend: { routes: true } },
      { frontend: { mapLayer: true } },
      { frontend: { legend: true } },
      { database: { migrations: true } },
    ])
      expect(validateManifest({ ...base, ...fields }, community), JSON.stringify(fields)).toEqual({
        valid: true,
        errors: [],
      });
  });

  it.each([
    [{ backend: { entry: "dist/backend/main.mjs" } }, "backend.entry"],
    [
      { frontend: { entry: "dist/web/index.mjs" } },
      "manifest.webPlatform: required when frontend.entry is set",
    ],
    [{ frontend: { panel: true } }, "frontend.panel"],
    [{ frontend: { panel: false } }, "frontend.panel"],
    [{ frontend: { panel: { detents: "tall" } } }, "frontend.panel.detents"],
    [{ frontend: { panel: { titleKey: "panel.title" } } }, "titleKey"],
    [
      { frontend: { legendKind: "toolbar" } },
      "manifest.frontend.legendKind: needs frontend.legend",
    ],
    [{ frontend: { legend: true, legendKind: "legend" } }, "frontend.legendKind"],
    [
      { frontend: { layerSelector: { group: "map-details", labelKey: "l", section: "food" } } },
      "section",
    ],
    [{ database: { migrations: false } }, "database.migrations"],
    [{ frontend: { overlay: { id: "Demo_Reports" } } }, "frontend.overlay.id"],
    [
      {
        subjectData: {
          storesPersonalData: false,
          strategy: "not_personal",
          registrationIds: [],
          operatorInstructions: null,
          registrations: [{ id: "x" }],
        },
      },
      "registrations need storesPersonalData",
    ],
  ])("refuses %j", (fields, message) => {
    const result = validateManifest({ ...base, ...fields }, community);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(message);
  });

  it("keeps built-ins on their own slots and their own catalogue", () => {
    expect(
      validateManifest(
        {
          id: "demo",
          domains: ["knowledge"],
          backend: { routes: true },
          frontend: { mapLayer: true, legend: true },
        },
        { firstParty: true },
      ).valid,
    ).toBe(true);
    expect(
      validateManifest(
        { id: "demo", domains: ["knowledge"], frontend: { panel: false } },
        { firstParty: true },
      ).valid,
    ).toBe(false);
    expect(
      validateManifest(
        {
          id: "demo",
          domains: ["knowledge"],
          subjectData: {
            storesPersonalData: true,
            strategy: "collector",
            registrationIds: ["x"],
            operatorInstructions: null,
            registrations: [{ id: "x" }],
          },
        },
        { firstParty: true },
      ).errors.join("\n"),
    ).toContain(
      "manifest.subjectData.registrations: built-in integrations register in the catalogue",
    );
  });

  it("accepts a logo only as an image file under assets/", () => {
    const source = (logoAsset: string) =>
      validateDataSource({ ...validSource, logoAsset }, ["knowledge"]);
    expect(source("assets/logos/acme.svg").valid).toBe(true);
    for (const path of [
      "https://example.org/logo.svg",
      "logos/acme.svg",
      "assets/../logo.svg",
      "assets/acme.gif",
      "assets/a b.png",
    ])
      expect(source(path).valid, path).toBe(false);
  });
});

describe("community service manifests", () => {
  it("accept a manifest that states protocol and semantic version", () => {
    expect(validateServiceManifest(communityService, community)).toEqual({
      valid: true,
      errors: [],
    });
  });

  it.each(["platform", "version"])("require %s", (key) => {
    const { [key as keyof typeof communityService]: _, ...rest } = communityService;
    expect(validateServiceManifest(rest, community).valid).toBe(false);
  });

  it("validate platform as a major.minor protocol version", () => {
    expect(validateServiceManifest({ ...communityService, platform: "1" }, community).valid).toBe(
      false,
    );
    expect(
      validateServiceManifest(
        { ...communityService, quality: "built-in", platform: "one" },
        builtIn,
      ).valid,
    ).toBe(false);
  });

  it("refuse an unknown top-level key and any quality but community", () => {
    expect(validateServiceManifest({ ...communityService, categry: "x" }, community).valid).toBe(
      false,
    );
    expect(
      validateServiceManifest({ ...communityService, quality: "community-verified" }, community)
        .valid,
    ).toBe(false);
  });

  it("make an un-namespaced capability or data type an error", () => {
    const result = validateServiceManifest(
      {
        ...communityService,
        provides: ["routing-engine", "acme/router", "router"],
        produces: [{ type: "blob", sourceDir: "blob" }],
      },
      community,
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      'provides[2]: "router" is neither a well-known capability nor namespaced as "<vendor>/<name>" (e.g. "acme/router")',
      'produces[0].type: "blob" is neither a well-known data type nor namespaced as "<vendor>/<name>" (e.g. "acme/blob")',
    ]);
  });
});

describe("service requests", () => {
  const svc = {
    id: "demo-engine",
    name: "Demo engine",
    version: "1.0.0",
    platform: "1.0",
    quality: "community",
    container: { image: "ghcr.io/example/demo", tag: "1", memory: "512m" },
    ownsSchema: "demo",
  };

  it("accepts every kind of request", () => {
    expect(
      validateServiceManifest(
        {
          ...svc,
          requests: {
            hostPaths: [{ source: "/srv/gps", target: "/data/gps", readOnly: true }],
            platformServices: ["postgis", "overpass"],
            reachableByPlatform: true,
            peerServices: true,
            database: {
              roles: [
                {
                  name: "demo_ingest",
                  privileges: ["create-schema:demo", "use-schema:extensions"],
                },
                { name: "demo_reader", privileges: ["use-schema:demo"], connectionKey: "READ_URL" },
                { name: "demo_login", privileges: [], connectionKey: "LOGIN_URL" },
              ],
            },
          },
        },
        community,
      ),
    ).toEqual({ valid: true, errors: [] });
  });

  const secretField = (key: string) => ({
    configSchema: {
      type: "object",
      properties: { [key]: { type: "string", "x-openmapx-secret": true } },
    },
  });

  it.each([
    [
      {},
      { hostPaths: [{ source: "srv/gps", target: "/data", readOnly: true }] },
      "must be an absolute host path",
    ],
    [
      {},
      { hostPaths: [{ source: "/srv/../etc", target: "/data", readOnly: true }] },
      "must not contain '.' or '..' segments",
    ],
    [
      {},
      { hostPaths: [{ source: "/srv/a:b", target: "/data", readOnly: true }] },
      "must be an absolute host path",
    ],
    [{}, { hostPaths: [{ source: "/srv/gps", target: "/data" }] }, "readOnly"],
    [{}, { platformServices: ["postgis", "postgis"] }, 'requests: duplicate "postgis"'],
    [
      {},
      { database: { roles: [{ name: "openmapx_api", privileges: [] }] } },
      'role "openmapx_api" is a reserved name',
    ],
    [
      {},
      { database: { roles: [{ name: "ab", privileges: [] }] } },
      "must be a lowercase PostgreSQL role name",
    ],
    [
      {},
      { database: { roles: [{ name: "demo", privileges: ["superuser"] }] } },
      "unknown database privilege",
    ],
    [
      {},
      { database: { roles: [{ name: "demo", privileges: ["create-schema"] }] } },
      "unknown database privilege",
    ],
    [
      {},
      { database: { roles: [{ name: "demo", privileges: ["usage:extensions"] }] } },
      "unknown database privilege",
    ],
    [
      {},
      { database: { roles: [{ name: "demo", privileges: ["member-of:demo_readers"] }] } },
      "unknown database privilege",
    ],
    [
      {},
      {
        database: {
          roles: [
            { name: "demo_a", privileges: [] },
            { name: "demo_b", privileges: [] },
          ],
        },
      },
      'requests.database: role "demo_b" needs its own connectionKey',
    ],
    [
      {},
      {
        database: {
          roles: [
            { name: "demo_a", privileges: [], connectionKey: "DATABASE_URL" },
            { name: "demo_b", privileges: [] },
          ],
        },
      },
      'requests.database: role "demo_b" needs its own connectionKey',
    ],
    [
      secretField("DATABASE_URL"),
      { database: { roles: [{ name: "demo", privileges: [] }] } },
      'requests.database: "DATABASE_URL" is filled by the platform and must not be a configSchema property',
    ],
    [
      secretField("READ_URL"),
      { database: { roles: [{ name: "demo", privileges: [], connectionKey: "READ_URL" }] } },
      'requests.database: "READ_URL" is filled by the platform and must not be a configSchema property',
    ],
    [{}, { routes: [] }, "requests"],
  ])("refuses %j with requests %j", (extra, requests, message) => {
    const result = validateServiceManifest({ ...svc, ...extra, requests }, community);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toContain(message);
  });

  it("lets a setting that is not a connection key stay in configSchema", () => {
    expect(
      validateServiceManifest(
        {
          ...svc,
          ...secretField("API_TOKEN"),
          requests: { database: { roles: [{ name: "demo", privileges: [] }] } },
        },
        community,
      ).valid,
    ).toBe(true);
  });

  it("refuses a reserved schema, requests on a built-in, a long device and the removed authRequired", () => {
    expect(
      validateServiceManifest({ ...svc, ownsSchema: "ext_other" }, community).errors.join("\n"),
    ).toContain('ownsSchema: "ext_other" is a reserved name');
    expect(
      validateServiceManifest(
        { ...svc, quality: "built-in", requests: { peerServices: true } },
        { firstParty: true },
      ).errors.join("\n"),
    ).toContain("requests: built-in services use their existing fields");
    expect(
      validateServiceManifest(
        {
          ...svc,
          quality: "built-in",
          container: { ...svc.container, devices: [`/dev/${"a".repeat(251)}`] },
        },
        { firstParty: true },
      ).valid,
    ).toBe(false);
    const proxied = validateServiceManifest(
      {
        ...svc,
        quality: "built-in",
        container: { ...svc.container, expose: [8080] },
        exposure: { proxy: { enabled: true, authRequired: true } },
      },
      { firstParty: true },
    );
    expect(proxied.valid).toBe(false);
    expect(proxied.errors.join("\n")).toMatch(/authRequired/);
  });
});

describe("extension manifests", () => {
  it("require platform and a semantic version", () => {
    expect(validateExtensionManifest(extension)).toEqual({ valid: true, errors: [] });
    const { platform: _, ...withoutPlatform } = extension;
    expect(validateExtensionManifest(withoutPlatform).valid).toBe(false);
    expect(validateExtensionManifest({ ...extension, version: "2024.1" }).valid).toBe(false);
  });
});

describe("semantic versions", () => {
  it("recognise Semantic Versioning 2.0.0", () => {
    expect(isSemver("1.0.0")).toBe(true);
    expect(isSemver("1.0.0-rc.1+build.5")).toBe(true);
    expect(isSemver("01.0.0")).toBe(false);
    expect(isSemver("1.0")).toBe(false);
  });

  it("order by precedence", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0",
      "1.0.1",
      "1.10.0",
      "2.0.0",
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareSemver(ordered[i - 1] as string, ordered[i] as string)).toBe(-1);
      expect(compareSemver(ordered[i] as string, ordered[i - 1] as string)).toBe(1);
    }
    expect(compareSemver("1.0.0+a", "1.0.0+b")).toBe(0);
    expect(compareSemver("1.0", "1.0.0")).toBeNull();
  });
});
