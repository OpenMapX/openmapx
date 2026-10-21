import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { routeJsonSchema } from "../schema";
import type { AdminOperation } from "./admin";
import * as contracts from "./index";

const inventory = [
  ["listAdminExtensionCatalog", "GET", "/catalog", 200, false],
  ["getAdminExtensionCatalogEntry", "GET", "/catalog/:id", 200, true],
  ["listAdminInstalledExtensions", "GET", "/installed", 200, false],
  ["previewAdminExtensionInstall", "POST", "/install-preview", 200, true],
  ["installAdminExtension", "POST", "/install", 202, true],
  ["updateAdminExtension", "POST", "/update/:id", 202, false],
  ["removeAdminExtension", "DELETE", "/:id", 202, false],
  ["listAdminExtensionSources", "GET", "/sources", 200, false],
  ["addAdminExtensionSource", "POST", "/sources", 200, false],
  ["removeAdminExtensionSource", "DELETE", "/sources", 200, false],
  ["refreshAdminExtensionCatalog", "POST", "/refresh-catalog", 200, false],
] as const;
const rating = {
  score: 3,
  requiresBuiltIn: false,
  hostPorts: 2,
  secretCount: 1,
  deploymentVariables: ["PUBLIC_URL"],
  factors: ["host ports"],
};
const base = {
  id: "catalog / identity",
  name: "Synthetic bundle",
  summary: "Summary",
  description: "Details",
  author: "Example",
  homepage: "editorial value",
  icon: "icon",
  screenshots: ["image"],
  categories: ["tools"],
  tags: ["maps"],
  minPlatform: "unknown",
  lastUpdated: "editorial date",
  manifest: "raw manifest value",
  manifestSha256: "a".repeat(64),
  featured: true,
  trust: "verified",
  services: [
    {
      repo: "https://example.org/repo",
      ref: "v1",
      service: "example",
      metadata: { nested: [null, { future: true }] },
    },
  ],
  integrations: [
    {
      artifact: "https://example.org/a.tgz",
      sha256: "b".repeat(64),
      id: "example-ui",
      extra: { labels: ["x"] },
    },
  ],
  future: { nested: [null, 1, true, { deep: "retained" }] },
};
const entry = {
  ...base,
  components: { services: 1, integrations: 1 },
  compatible: true,
  platformVersion: "1",
  installed: false,
  installedVersion: null,
  hasUpdate: false,
  removed: null,
  critical: null,
  status: "stale-revocation-data",
};
const preview = {
  extension: { id: "example", name: "Synthetic", version: "opaque version" },
  sourceTrust: "community",
  services: [
    {
      id: "example",
      name: "Example",
      version: "1",
      repositoryCommit: "a".repeat(40),
      hostPorts: [
        { host: 8080, container: 80, protocol: "tcp", bindAddress: "127.0.0.1" },
        { host: 65535, container: 1, protocol: "udp", bindAddress: "0.0.0.0" },
      ],
      securityRating: rating,
    },
  ],
  requiresHostPortConfirmation: true,
  confirmation: "b".repeat(64),
};

describe("complete extension administration contracts", () => {
  beforeEach(() => expect(contracts).toHaveProperty("extensionAdminOperations"));
  it("exports exactly the eleven literal method/path/auth/status contracts", () => {
    expect(contracts).toHaveProperty("extensionAdminOperations");
    const operations = contracts.extensionAdminOperations;
    expect(Object.keys(operations).sort()).toEqual(inventory.map(([id]) => id).sort());
    for (const [id, method, path, success, notFound] of inventory) {
      const operation = operations[id];
      expect(operation).toMatchObject({
        method,
        path: `/api/admin/extensions${path}`,
        auth: "admin",
      });
      expect(
        Object.keys(operation.responses)
          .map(Number)
          .sort((a, b) => a - b),
      ).toEqual(
        [success, 400, 401, 403, 413, 415, 429, 500, ...(notFound ? [404] : [])].sort(
          (a, b) => a - b,
        ),
      );
      for (const response of Object.values(operation.responses)) expect(response.kind).toBe("json");
      expect(operation.responses[429].headers?.safeParse({ "retry-after": "30" }).success).toBe(
        true,
      );
      expect(operation.responses[429].headers?.safeParse({ "retry-after": "1.5" }).success).toBe(
        false,
      );
    }
  });
  it("preserves all catalog fields and nested inline JSON without inventing version or defaults", () => {
    const parsed = contracts.adminExtensionCatalogEntrySchema.parse(entry);
    expect(parsed).toEqual(entry);
    expect(parsed).not.toHaveProperty("version");
    expect(parsed.services?.[0]).not.toHaveProperty("default");
    expectTypeOf(parsed.services?.[0].repo).toEqualTypeOf<string | undefined>();
    expectTypeOf(parsed.version).toEqualTypeOf<string | undefined>();
    const sparse = {
      id: "unknown",
      name: "Unknown",
      components: { services: 0, integrations: 0 },
      compatible: true,
      platformVersion: "1",
      installed: false,
      installedVersion: null,
      hasUpdate: false,
      removed: null,
      critical: null,
      status: "community",
    };
    expect(contracts.adminExtensionCatalogEntrySchema.parse(sparse)).toEqual(sparse);
    for (const status of ["verified", "community", "revoked", "stale-revocation-data"]) {
      expect(contracts.adminExtensionCatalogEntrySchema.parse({ ...entry, status }).status).toBe(
        status,
      );
    }
    const unpinned = {
      ...entry,
      services: [{ repo: "https://example.org/repo", service: "example" }],
    };
    expect(contracts.adminExtensionCatalogEntrySchema.parse(unpinned)).toEqual(unpinned);
    expect(
      contracts.adminExtensionCatalogSchema.parse({
        entries: [entry],
        total: 1,
        revocationDataStale: true,
      }),
    ).toEqual({ entries: [entry], total: 1, revocationDataStale: true });
    expect(
      contracts.adminExtensionCatalogEntrySchema.parse({
        ...entry,
        version: "not semver",
        critical: { reason: "advisory", maxVersion: "opaque" },
        removed: "reason",
        status: "revoked",
      }),
    ).toMatchObject({ version: "not semver", status: "revoked" });
    const detail = {
      ...base,
      componentList: [{ kind: "service", id: "example" }],
      compatible: true,
      platformVersion: "1",
      removed: null,
      critical: null,
    };
    expect(contracts.adminExtensionCatalogDetailSchema.parse(detail)).toEqual(detail);
    expect(contracts.adminExtensionCatalogDetailSchema.parse(detail)).not.toHaveProperty("status");
    expect(
      contracts.adminExtensionCatalogDetailSchema.parse({ ...detail, componentList: [] })
        .componentList,
    ).toEqual([]);
  });
  it("emits portable route schemas for every request/response while retaining JSON catchalls", () => {
    for (const [id, operation] of Object.entries(contracts.extensionAdminOperations) as [
      string,
      AdminOperation,
    ][]) {
      for (const [part, schema] of Object.entries(operation.request ?? {})) {
        expect(() =>
          routeJsonSchema(schema, { identity: `${id}${part}`, io: "output" }),
        ).not.toThrow();
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        if (response.kind !== "json") throw new Error("Extension operations are JSON only");
        expect(() =>
          routeJsonSchema(response.schema, { identity: `${id}${status}`, io: "output" }),
        ).not.toThrow();
      }
    }
    const emitted = routeJsonSchema(contracts.adminExtensionCatalogEntrySchema, {
      identity: "ExtensionEntry",
      io: "output",
    });
    expect(emitted.additionalProperties).toBeTypeOf("object");
    expect(emitted).toMatchObject({
      properties: { services: { items: { additionalProperties: expect.any(Object) } } },
    });
    expect(emitted.required).not.toContain("version");
  });
  it("rejects malformed known catalog fields, non-JSON and own proto keys at any depth", () => {
    for (const patch of [
      { version: null },
      { status: "clean" },
      { components: { services: -1, integrations: 0 } },
      { manifestSha256: "bad" },
      { trust: "trusted" },
      { featured: 1 },
      { tags: [1] },
      { services: [{ repo: "https://example.org", service: 2 }] },
      { integrations: [{ artifact: "https://example.org", id: "example", sha256: "bad" }] },
      { future: undefined },
      { future: new Date() },
      { future: () => 1 },
      { future: NaN },
      { future: { deep: JSON.parse('{"__proto__":null}') } },
    ]) {
      expect(
        contracts.adminExtensionCatalogEntrySchema.safeParse({ ...entry, ...patch }).success,
      ).toBe(false);
    }
    expect(
      contracts.adminExtensionCatalogEntrySchema.safeParse({
        ...entry,
        services: [{ ...base.services[0], metadata: { bad: undefined } }],
      }).success,
    ).toBe(false);
  });
  it("keeps installed projection nulls and absence of enrichment, with strict kinds/trust/ISO dates", () => {
    const installed = {
      id: "example",
      name: "Example",
      sourceTrust: "built-in",
      installedVersion: "opaque",
      sourceUrl: null,
      installedAt: "2026-10-21T10:00:00.000Z",
      updatedAt: "2026-10-21T10:00:00+02:00",
      components: [{ kind: "integration", componentId: "example-ui" }],
      hasUpdate: false,
      latestVersion: null,
    };
    expect(contracts.adminExtensionInstalledSchema.parse(installed)).toEqual(installed);
    expect(
      contracts.adminExtensionInstalledSchema.parse({
        ...installed,
        components: [
          { kind: "service", componentId: "example", enabled: true, securityRating: rating },
        ],
      }).components[0].securityRating,
    ).toEqual(rating);
    for (const patch of [
      { sourceTrust: "other" },
      { installedAt: "yesterday" },
      { latestVersion: 1 },
      { components: [{ kind: "other", componentId: "x" }] },
      { components: [{ kind: "service", componentId: "x", enabled: null }] },
      { manifest: {} },
    ])
      expect(
        contracts.adminExtensionInstalledSchema.safeParse({ ...installed, ...patch }).success,
      ).toBe(false);
  });
  it("validates the entire exact preview, security rating and every effective port without defaults", () => {
    expect(contracts.adminExtensionInstallPreviewSchema.parse(preview)).toEqual(preview);
    for (const field of Object.keys(rating)) {
      const incomplete: Record<string, unknown> = { ...rating };
      delete incomplete[field];
      expect(contracts.adminExtensionSecurityRatingSchema.safeParse(incomplete).success).toBe(
        false,
      );
    }
    for (const patch of [
      { score: 0 },
      { score: 9 },
      { score: 1.5 },
      { hostPorts: -1 },
      { secretCount: Number.MAX_SAFE_INTEGER + 1 },
      { deploymentVariables: [1] },
      { extra: true },
    ])
      expect(
        contracts.adminExtensionSecurityRatingSchema.safeParse({ ...rating, ...patch }).success,
      ).toBe(false);
    for (const patch of [
      { confirmation: "A".repeat(64) },
      { confirmation: "a".repeat(63) },
      { requiresHostPortConfirmation: null },
      { extra: true },
    ])
      expect(
        contracts.adminExtensionInstallPreviewSchema.safeParse({ ...preview, ...patch }).success,
      ).toBe(false);
    for (const patch of [
      { repositoryCommit: "a".repeat(39) },
      { repositoryCommit: "A".repeat(40) },
      { securityRating: { ...rating, deploymentVariables: undefined } },
      ...[
        { host: 0 },
        { host: 65536 },
        { container: 1.5 },
        { protocol: "sctp" },
        { protocol: undefined },
        { bindAddress: undefined },
      ].map((port) => ({ hostPorts: [{ ...preview.services[0].hostPorts[0], ...port }] })),
    ])
      expect(
        contracts.adminExtensionInstallPreviewSchema.safeParse({
          ...preview,
          services: [{ ...preview.services[0], ...patch }],
        }).success,
      ).toBe(false);
  });
  it("accepts scalar query fallbacks, both selectors, opaque confirmation and absent optional bodies", () => {
    expect(
      contracts.adminExtensionCatalogQuerySchema.parse({
        q: "",
        category: "x",
        trust: "future",
        type: "fallback",
        sort: "fallback",
      }),
    ).toEqual({ q: "", category: "x", trust: "future", type: "fallback", sort: "fallback" });
    expect(contracts.adminExtensionCatalogQuerySchema.parse({})).toEqual({});
    for (const query of [{ q: ["a", "b"] }, { type: {} }, { sort: null }, { extra: "x" }])
      expect(contracts.adminExtensionCatalogQuerySchema.safeParse(query).success).toBe(false);
    for (const input of [
      { id: "catalog / id", manifestUrl: "not a URL", hostPortConfirmation: "opaque" },
      { id: "", manifestUrl: "raw" },
      { id: "x", manifestUrl: "" },
    ])
      expect(contracts.adminExtensionInstallRequestSchema.parse(input)).toEqual(input);
    for (const input of [
      {},
      { id: "", manifestUrl: "" },
      { id: 1 },
      { manifestUrl: null },
      { id: "x", sourceTrust: "verified" },
      { id: "x", hostPortConfirmation: 1 },
      null,
    ])
      expect(contracts.adminExtensionInstallRequestSchema.safeParse(input).success).toBe(false);
    expect(contracts.adminExtensionUpdateRequestSchema.parse(undefined)).toBeUndefined();
    expect(contracts.adminExtensionUpdateRequestSchema.parse({ hostPortConfirmation: "" })).toEqual(
      { hostPortConfirmation: "" },
    );
    for (const input of [null, { id: "x" }, { hostPortConfirmation: false }])
      expect(contracts.adminExtensionUpdateRequestSchema.safeParse(input).success).toBe(false);
    expect(contracts.adminExtensionEmptyMutationSchema.parse(undefined)).toBeUndefined();
    expect(contracts.adminExtensionEmptyMutationSchema.parse({})).toEqual({});
    for (const input of [null, { extra: true }])
      expect(contracts.adminExtensionEmptyMutationSchema.safeParse(input).success).toBe(false);
  });
  it("keeps source identity and separates accepted jobs, synchronous ok and refresh counts", () => {
    expect(
      contracts.adminExtensionSourceAddSchema.parse({ url: " raw identity ", label: " " }),
    ).toEqual({ url: " raw identity ", label: " " });
    expect(contracts.adminExtensionSourceRemoveSchema.parse({ url: "not a URL" })).toEqual({
      url: "not a URL",
    });
    expect(
      contracts.adminExtensionSourcesSchema.parse({
        sources: [{ url: "raw", label: "Source", isDefault: true }],
      }),
    ).toEqual({ sources: [{ url: "raw", label: "Source", isDefault: true }] });
    for (const input of [
      { url: "", label: "x" },
      { url: "x", label: "" },
      { url: "x", label: 1 },
      { url: "x", label: "x", extra: true },
    ])
      expect(contracts.adminExtensionSourceAddSchema.safeParse(input).success).toBe(false);
    expect(contracts.adminExtensionAcceptedSchema.parse({ jobId: "job" })).toEqual({
      jobId: "job",
    });
    for (const input of [{ jobId: "" }, { jobId: "job", ok: true }, { ok: true }, {}])
      expect(contracts.adminExtensionAcceptedSchema.safeParse(input).success).toBe(false);
    expect(contracts.adminExtensionOkSchema.safeParse({ ok: true }).success).toBe(true);
    expect(contracts.adminExtensionRefreshSchema.safeParse({ entries: 0 }).success).toBe(true);
    for (const input of [{ entries: -1 }, { entries: 1.5 }, { entries: 0, ok: true }, { ok: true }])
      expect(contracts.adminExtensionRefreshSchema.safeParse(input).success).toBe(false);
  });
});
