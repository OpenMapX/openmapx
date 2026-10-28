import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeJsonSchema } from "../schema";
import * as contracts from "./index";

beforeEach(() =>
  vi.stubGlobal("fetch", () => {
    throw new Error("Unexpected network");
  }),
);
afterEach(() => vi.unstubAllGlobals());
const at = "2026-10-20T12:00:00.000Z";
const inventory = [
  ["listAdminIntegrations", "GET", "/api/admin/integrations"],
  ["getAdminIntegration", "GET", "/api/admin/integrations/:id"],
  ["listAdminIntegrationEnvVars", "GET", "/api/admin/integrations/env-vars"],
  ["exportAdminIntegrationConfigs", "GET", "/api/admin/integrations/export"],
  ["importAdminIntegrationConfigs", "POST", "/api/admin/integrations/import"],
  ["runAdminIntegrationHealthChecks", "POST", "/api/admin/integrations/health/run"],
  ["reloadAdminIntegrations", "POST", "/api/admin/integrations/reload"],
  ["patchAdminIntegrationConfig", "PATCH", "/api/admin/integrations/:id/config"],
  ["enableAdminIntegration", "POST", "/api/admin/integrations/:id/enable"],
  ["disableAdminIntegration", "POST", "/api/admin/integrations/:id/disable"],
  ["getAdminIntegrationHealth", "GET", "/api/admin/integrations/:id/health"],
  ["getAdminIntegrationHealthHistory", "GET", "/api/admin/integrations/:id/health/history"],
  ["reloadAdminIntegration", "POST", "/api/admin/integrations/:id/reload"],
  ["listAdminIntegrationBindings", "GET", "/api/admin/integrations/:integrationId/bindings"],
  [
    "setAdminIntegrationBinding",
    "POST",
    "/api/admin/integrations/:integrationId/bindings/:capability",
  ],
  [
    "deleteAdminIntegrationBinding",
    "DELETE",
    "/api/admin/integrations/:integrationId/bindings/:capability",
  ],
  ["listAdminCredentials", "GET", "/api/admin/credentials"],
  ["getAdminIntegrationCredentials", "GET", "/api/admin/credentials/:integrationId"],
  ["testAdminIntegrationCredentials", "POST", "/api/admin/credentials/:integrationId/test"],
  ["setAdminIntegrationCredential", "PUT", "/api/admin/credentials/:integrationId/:key"],
  ["deleteAdminIntegrationCredential", "DELETE", "/api/admin/credentials/:integrationId/:key"],
  ["getAdminOverview", "GET", "/api/admin/overview"],
];
const health = {
  id: "sample",
  name: "Sample",
  category: "routing",
  url: "https://health.example.test",
  status: "up",
  responseTime: 15,
};
const summary = {
  id: "sample",
  name: "Sample",
  description: "Example",
  version: "1.0",
  domains: ["routing"],
  quality: "built-in",
  isBuiltIn: true,
  blockedCode: false,
  enabled: true,
  configured: true,
  hasHealthCheck: true,
  health: { status: "up", responseTime: 15 },
  dependencies: ["base"],
  requires: [{ capability: "routing-engine", optional: true }],
  infrastructure: { dataRequirements: ["roads"], planetScale: false },
};
const credential = {
  key: "apiKey",
  title: "API key",
  description: "Operator credential",
  source: "env",
  sharedSecretName: "sample-account",
  setup: {
    url: "https://account.example.test",
    urlLabel: "Account",
    steps: ["Request access"],
    cost: "Free",
    notes: "Approval",
    email: { to: "access@example.test", subject: "Access", body: "Request" },
  },
  updatedAt: at,
  updatedBy: "admin",
};
const job = {
  id: "job",
  type: "integration.reload",
  source: "application",
  status: "cancel_pending",
  payload: { nested: [true, null] },
  error: null,
  progress: 0.5,
  createdBy: "admin",
  actorLabel: "Admin",
  actor: { id: "admin", name: "Admin", email: "admin@example.test" },
  createdAt: at,
  startedAt: at,
  finishedAt: null,
  cancelable: true,
};
const audit = {
  id: "audit",
  actorId: "admin",
  targetId: "sample",
  targetType: "integration",
  action: "integration.config.update",
  details: { keys: ["nested"], extra: { count: 1 } },
  ipAddress: "127.0.0.1",
  userAgent: "fixture",
  createdAt: at,
};
const overview = {
  systemHealth: { status: "degraded", unhealthyCount: 1 },
  users: { total: 2, active24h: 1, banned: 0 },
  integrations: { total: 3, enabled: 2, unhealthy: 1, unconfigured: 0 },
  services: { running: 1, stopped: 2, unhealthy: 0, unknown: 0 },
  attention: [
    { type: "health_check_failed", severity: "error", message: "Probe failed", target: "sample" },
  ],
  recentActivity: [audit],
  activeJobs: [job],
};
const reload = { ok: true, message: "Reloaded", reloaded: 3, enabled: 2 };
const source = {
  sourceId: "sample-source",
  name: "Source",
  url: "https://source.example.test",
  licensing: {
    version: 1,
    bindings: [{ scope: "data", subject: "Sample", license: { kind: "unknown" } }],
  },
  providerCountry: "DE",
  providerPrivacyUrl: "https://source.example.test/privacy",
  "x-future": { notes: [null, 3] },
};
const detail = {
  ...summary,
  author: "Author",
  license: "MIT",
  documentation: "https://docs.example.test",
  manifest: {
    dataSources: [source],
    id: "sample",
    domains: ["routing"],
    configSchema: {
      type: "object",
      properties: {
        nested: {
          type: "object",
          additionalProperties: { anyOf: [{ type: "string" }, { const: null }] },
          "x-unfamiliar": [false, { value: 2 }],
        },
      },
      $defs: { future: { dynamic: [1, null] } },
    },
    frontend: {
      overlay: {
        legend: { kind: "categorical", items: [{ color: "red", custom: { nested: true } }] },
      },
    },
    "x-future": { arbitrary: [null, false] },
  },
  resolvedConfig: {
    nested: { value: { arbitrary: [1, null, false] }, source: "config.json" },
    apiKey: { value: "***", source: "env" },
  },
  dependencyStatus: [{ id: "base", loaded: true, enabled: false }],
  credentialStatus: [credential],
  secretsConfigured: true,
};

function success(id: keyof typeof contracts.integrationAdminOperations, value: unknown) {
  const contract = contracts.integrationAdminOperations[id].responses[200];
  expect(contract.kind).toBe("json");
  if (contract.kind !== "json") throw new Error("Expected JSON");
  return contract.schema.parse(value);
}
describe("integration administration canonical producer contracts", () => {
  it("binds exactly the 22 approved operation IDs, methods, paths and admin auth", () => {
    expect(contracts).toHaveProperty("integrationAdminOperations");
    expect(
      Object.entries(contracts.integrationAdminOperations).map(([id, op]) => [
        id,
        op.method,
        op.path,
        op.auth,
      ]),
    ).toEqual(inventory.map((row) => [...row, "admin"]));
  });
  it("retains every actual success envelope without reducing it to browser DTOs", () => {
    const fixtures = {
      listAdminIntegrations: [summary],
      getAdminIntegration: detail,
      listAdminIntegrationEnvVars: {
        integrations: [
          {
            id: "sample",
            name: "Sample",
            enabled: true,
            envVars: [
              {
                key: "nested",
                name: "INTEGRATION_SAMPLE_NESTED",
                title: "Nested",
                description: "JSON",
                secret: false,
                present: true,
                defaultValue: { nested: [false, null] },
              },
            ],
          },
        ],
      },
      exportAdminIntegrationConfigs: {
        integrations: [
          { integrationId: "sample", config: { nested: [null, true], enabled: false } },
        ],
        exportedAt: at,
        count: 1,
      },
      importAdminIntegrationConfigs: { ...reload, imported: 1, skipped: [] },
      runAdminIntegrationHealthChecks: { timestamp: at, count: 1, results: [health] },
      reloadAdminIntegrations: { ok: true, jobId: "job" },
      patchAdminIntegrationConfig: { ...reload, updated: ["nested"] },
      enableAdminIntegration: reload,
      disableAdminIntegration: reload,
      getAdminIntegrationHealth: [health],
      getAdminIntegrationHealthHistory: {
        integrationId: "sample",
        hours: 24,
        timeline: [{ hour: at, total: 2, healthy: 1, uptimePercent: 50, avgResponseTime: null }],
      },
      reloadAdminIntegration: { ok: true, jobId: "job" },
      listAdminIntegrationBindings: {
        bindings: [{ capability: "routing-engine", serviceId: "router" }],
        revision: "a".repeat(64),
        desiredRevision: "a".repeat(64),
        runtime: null,
        lastApplication: null,
      },
      setAdminIntegrationBinding: {
        operationId: "binding-test-operation",
        integrationId: "sample",
        desiredRevision: "a".repeat(64),
        database: "retained",
        runtime: "applied",
        runtimeGenerationId: "11111111-1111-4111-8111-111111111111",
      },
      deleteAdminIntegrationBinding: {
        operationId: "binding-test-operation",
        integrationId: "sample",
        desiredRevision: "a".repeat(64),
        database: "retained",
        runtime: "pending",
        runtimeGenerationId: null,
        reason: "integration_disabled",
      },
      listAdminCredentials: {
        credentials: [
          {
            integrationId: "sample",
            name: "Sample",
            enabled: true,
            secretFields: 2,
            vaultStored: 1,
            missingCredentials: 1,
          },
        ],
        secretsConfigured: true,
      },
      getAdminIntegrationCredentials: {
        integrationId: "sample",
        name: "Sample",
        credentials: [credential],
        secretsConfigured: true,
      },
      testAdminIntegrationCredentials: {
        ok: true,
        integrationId: "sample",
        key: null,
        status: "up",
        responseTime: 15,
        error: null,
      },
      setAdminIntegrationCredential: reload,
      deleteAdminIntegrationCredential: reload,
      getAdminOverview: overview,
    };
    for (const [id, fixture] of Object.entries(fixtures))
      expect(success(id as keyof typeof fixtures, fixture)).toEqual(fixture);
  });
  it("preserves unfamiliar nested manifest/schema/source JSON while checking known metadata", () => {
    // Raw wire metadata must survive even when its future schema is not understood here.
    const raw = { ...detail.manifest, dataSources: [source] };
    expect(contracts.adminIntegrationManifestSchema.parse(raw)).toEqual(raw);
    expect(success("getAdminIntegration", detail)).toEqual(detail);
    expect(contracts.adminIntegrationManifestSchema.safeParse({ ...raw, domains: 1 }).success).toBe(
      false,
    );
    expect(
      contracts.adminIntegrationManifestSchema.safeParse({
        ...raw,
        dataSources: [
          {
            ...source,
            licensing: {
              version: 1,
              bindings: Array.from({ length: 65 }, () => source.licensing.bindings[0]),
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
  it("serializes raw manifest and config-schema JSON losslessly through the installed schema emitter", () => {
    const apiRequire = createRequire(
      new URL("../../../../../../apps/api/package.json", import.meta.url),
    );
    const stringify = createRequire(apiRequire.resolve("fastify"))("fast-json-stringify");
    const definitions: Record<string, unknown> = {};
    const schema = routeJsonSchema(contracts.adminIntegrationDetailSchema, {
      identity: "IntegrationDetailFixture",
      io: "output",
      registerDefinition: (definition) => {
        definitions[definition.$id] = definition;
      },
    });
    const serialize = stringify(schema, { schema: definitions });
    expect(JSON.parse(serialize(detail))).toEqual(detail);
  });
  it("rejects non-JSON dynamic values and invalid ISO dates rather than accepting arbitrary JS", () => {
    for (const value of [
      undefined,
      new Date(),
      () => 1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      BigInt(1),
      { nested: undefined },
    ]) {
      expect(contracts.adminIntegrationConfigPatchSchema.safeParse({ nested: value }).success).toBe(
        false,
      );
      expect(
        contracts.adminIntegrationManifestSchema.safeParse({ ...detail.manifest, extra: value })
          .success,
      ).toBe(false);
    }
    expect(
      contracts.adminIntegrationManifestSchema.safeParse(
        JSON.parse('{"id":"sample","domains":[],"nested":{"__proto__":null}}'),
      ).success,
    ).toBe(false);
    expect(
      contracts.adminIntegrationConfigExportSchema.safeParse({
        integrations: [],
        exportedAt: "yesterday",
        count: 0,
      }).success,
    ).toBe(false);
    expect(
      contracts.adminIntegrationCredentialSchema.safeParse({
        ...credential,
        updatedAt: "yesterday",
      }).success,
    ).toBe(false);
    expect(
      contracts.adminOverviewSchema.safeParse({
        ...overview,
        recentActivity: [{ ...audit, createdAt: new Date() }],
      }).success,
    ).toBe(false);
  });
  it("retains overview actors, cancel_pending and data-manager statuses with nullable services/audit", () => {
    expect(
      success("getAdminOverview", {
        ...overview,
        services: null,
        recentActivity: [
          {
            ...audit,
            actorId: null,
            targetId: null,
            targetType: null,
            details: null,
            ipAddress: null,
            userAgent: null,
          },
        ],
        activeJobs: [
          job,
          { ...job, source: "data-manager", status: "interrupted", actor: null, cancelable: false },
        ],
      }),
    ).toMatchObject({
      activeJobs: [
        { status: "cancel_pending", actor: job.actor },
        { status: "interrupted", actor: null },
      ],
    });
    expect(
      contracts.adminOverviewSchema.safeParse({
        ...overview,
        activeJobs: [{ ...job, status: "invented" }],
      }).success,
    ).toBe(false);
  });
  it("accepts the actual single unconfigured health object and both array alternatives", () => {
    const unavailable = { id: "sample", status: "unconfigured", error: "No health check defined" };
    for (const value of [unavailable, [unavailable], [health]])
      expect(success("getAdminIntegrationHealth", value)).toEqual(value);
    expect(
      success("testAdminIntegrationCredentials", {
        ok: false,
        integrationId: "sample",
        key: "apiKey",
        status: "unconfigured",
        error: "Unavailable",
      }),
    ).toMatchObject({ status: "unconfigured" });
  });
  it("keeps effective credential sources separate from vault audit metadata", () => {
    for (const source of ["env", "config.json", "vault", "database", "default", "missing"])
      expect(contracts.adminIntegrationCredentialSchema.parse({ ...credential, source })).toEqual({
        ...credential,
        source,
      });
    expect(
      contracts.adminIntegrationCredentialSchema.safeParse({ ...credential, value: "forbidden" })
        .success,
    ).toBe(false);
  });
  it("defaults history to24 and permits only one bounded safe decimal integer", () => {
    expect(contracts.adminIntegrationHealthHistoryQuerySchema.parse({})).toEqual({ hours: 24 });
    for (const [hours, want] of [
      ["1", 1],
      ["168", 168],
      [24, 24],
    ])
      expect(contracts.adminIntegrationHealthHistoryQuerySchema.parse({ hours })).toEqual({
        hours: want,
      });
    for (const hours of [
      "",
      " ",
      null,
      true,
      [],
      ["24"],
      ["1", "2"],
      "NaN",
      "Infinity",
      "1.1",
      "1e2",
      "0x18",
      "-1",
      "0",
      "169",
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0,
      169,
    ])
      expect(contracts.adminIntegrationHealthHistoryQuerySchema.safeParse({ hours }).success).toBe(
        false,
      );
    expect(
      contracts.adminIntegrationHealthHistoryQuerySchema.safeParse({ hours: "24", extra: 1 })
        .success,
    ).toBe(false);
    expect(
      routeJsonSchema(contracts.adminIntegrationHealthHistoryQuerySchema, {
        identity: "History",
        io: "output",
      }),
    ).toMatchObject({
      properties: { hours: { type: "integer", minimum: 1, maximum: 168, default: 24 } },
    });
  });
  it("validates all import entries before apply with unique syntactic IDs and JSON object configs", () => {
    const entry = {
      integrationId: "sample",
      config: { nested: [null, { extra: true }], enabled: false },
    };
    expect(contracts.adminIntegrationConfigImportSchema.parse({ integrations: [entry] })).toEqual({
      integrations: [entry],
    });
    const exported = { integrations: [entry], exportedAt: at, count: 1 };
    expect(contracts.adminIntegrationConfigImportSchema.parse(exported)).toEqual(exported);
    expect(
      contracts.adminIntegrationConfigImportSchema.parse({
        integrations: [{ integrationId: "sample", config: {} }],
      }),
    ).toEqual({ integrations: [{ integrationId: "sample", config: {} }] });
    for (const body of [
      {},
      { integrations: [] },
      { integrations: [entry, entry] },
      { integrations: [{ ...entry, integrationId: "../sample" }] },
      { integrations: [{ ...entry, config: null }] },
      { integrations: [{ ...entry, config: [] }] },
      { integrations: [{ ...entry, config: { enabled: "false" } }] },
      { integrations: [{ ...entry, extra: true }] },
      { integrations: [entry], extra: true },
    ])
      expect(contracts.adminIntegrationConfigImportSchema.safeParse(body).success).toBe(false);
  });
  it("rejects unknown mutation keys and malformed credential/binding/no-body shapes", () => {
    const ops = contracts.integrationAdminOperations;
    expect(ops.setAdminIntegrationCredential.request.body.parse({ value: " synthetic " })).toEqual({
      value: " synthetic ",
    });
    for (const value of ["", " ", null, 1])
      expect(ops.setAdminIntegrationCredential.request.body.safeParse({ value }).success).toBe(
        false,
      );
    expect(
      ops.setAdminIntegrationCredential.request.body.safeParse({ value: "synthetic", extra: true })
        .success,
    ).toBe(false);
    expect(ops.testAdminIntegrationCredentials.request.body.parse(undefined)).toBeUndefined();
    expect(
      ops.testAdminIntegrationCredentials.request.body.safeParse({ key: "apiKey", extra: true })
        .success,
    ).toBe(false);
    expect(
      ops.setAdminIntegrationBinding.request.body.safeParse({ serviceId: "router", extra: true })
        .success,
    ).toBe(false);
    expect(ops.setAdminIntegrationBinding.request.body.safeParse({ serviceId: "" }).success).toBe(
      false,
    );
    for (const id of [
      "enableAdminIntegration",
      "disableAdminIntegration",
      "reloadAdminIntegration",
      "reloadAdminIntegrations",
      "runAdminIntegrationHealthChecks",
      "deleteAdminIntegrationCredential",
    ] as const) {
      expect(ops[id].request.body.safeParse(undefined).success).toBe(true);
      expect(ops[id].request.body.safeParse({}).success).toBe(true);
      expect(ops[id].request.body.safeParse({ extra: true }).success).toBe(false);
    }
    expect(ops.deleteAdminIntegrationBinding.request.body.safeParse(undefined).success).toBe(false);
    expect(
      ops.deleteAdminIntegrationBinding.request.body.safeParse({
        expectedServiceId: null,
        expectedRevision: "a".repeat(64),
      }).success,
    ).toBe(true);
    for (const body of [{}, [], null, { enabled: true }])
      expect(ops.patchAdminIntegrationConfig.request.body.safeParse(body).success).toBe(false);
  });
  it("preserves errors-array400, vault-hint503 and Retry-After429 distinctions", () => {
    const ops = contracts.integrationAdminOperations;
    for (const payload of [
      { errors: ["Invalid field"] },
      { error: "No fields" },
      { statusCode: 400, error: "Bad Request", message: "Invalid JSON" },
    ])
      expect(ops.patchAdminIntegrationConfig.responses[400].schema.parse(payload)).toEqual(payload);
    const unavailable = { error: "Secrets vault not configured", hint: "Configure the vault" };
    expect(ops.setAdminIntegrationCredential.responses[503].schema.parse(unavailable)).toEqual(
      unavailable,
    );
    expect(
      ops.setAdminIntegrationBinding.responses[503].schema.parse({
        error: "Service registry not available",
      }),
    ).toEqual({ error: "Service registry not available" });
    const limited = ops.runAdminIntegrationHealthChecks.responses[429];
    expect(limited.schema.parse({ error: "Rate limit exceeded", retryAfter: 10 })).toEqual({
      error: "Rate limit exceeded",
      retryAfter: 10,
    });
    expect(limited.headers?.safeParse({ "retry-after": "10" }).success).toBe(true);
    expect(limited.headers?.safeParse({}).success).toBe(false);
    expect(
      ops.patchAdminIntegrationConfig.responses[400].schema.safeParse({ errors: "bad" }).success,
    ).toBe(false);
    expect(
      ops.setAdminIntegrationCredential.responses[503].schema.safeParse({
        ...unavailable,
        value: "forbidden",
      }).success,
    ).toBe(false);
  });
});
