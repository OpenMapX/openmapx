import Fastify, { type FastifyInstance } from "fastify";
import { vi } from "vitest";
import { integrationsRoute } from "../../routes/integrations";

vi.mock("../../redis.js", () => ({ redis: null }));

const schemaPresentUnsafe = vi.hoisted(
  () => () =>
    vi.fn(async (query: string) => (query.includes("to_regnamespace") ? [{ present: true }] : [])),
);

vi.mock("../../db/index.js", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  },
  sql: { unsafe: vi.fn().mockResolvedValue([]) },
  // The pools behind ctx.db: an integration's schema exists, every other
  // statement returns no rows, every transaction commits.
  integrationSql: {
    unsafe: vi.fn(async () => []),
    begin: vi.fn(async (fn: (sql: unknown) => unknown) => fn({ unsafe: schemaPresentUnsafe() })),
  },
  extensionSql: {
    begin: vi.fn(async (fn: (sql: unknown) => unknown) => fn({ unsafe: schemaPresentUnsafe() })),
  },
}));

const extensionMigrationMocks = vi.hoisted(() => ({
  applyExtensionMigrations: vi.fn(async () => ({ applied: [] as string[], schemaAhead: false })),
}));

vi.mock("../../extension-migrations.js", () => extensionMigrationMocks);

const attentionMocks = vi.hoisted(() => ({
  raiseAttention: vi.fn(async () => "inserted"),
  resolveAttention: vi.fn(async () => {}),
}));

vi.mock("../../services/attention.js", () => attentionMocks);

vi.mock("../../db/schema.js", () => ({
  integrationConfig: { integrationId: "integrationId", config: "config" },
  integrationSecret: {},
}));

vi.mock("../../services/attribution/index.js", () => ({
  AttributionIndex: {
    init: vi.fn().mockResolvedValue({
      setIntegrationManifests: vi.fn(),
      reload: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    }),
  },
  defaultMotisLicenseFile: vi.fn().mockReturnValue(null),
  getAttributionIndex: vi.fn().mockReturnValue(null),
  setAttributionIndex: vi.fn(),
}));

vi.mock("../../services/capability-bindings.js", () => ({
  loadAllBindingsByIntegration: vi.fn().mockResolvedValue(new Map()),
}));

vi.mock("../../services/service-registry.js", () => ({
  getServiceRegistry: vi.fn().mockImplementation(() => {
    throw new Error("service registry unavailable (test mock)");
  }),
  resolveRequiresForIntegration: vi.fn().mockReturnValue(new Map()),
}));

const integrationHealthMocks = vi.hoisted(() => ({
  executeAllIntegrationHealthChecks: vi.fn().mockResolvedValue([]),
  getCachedIntegrationHealthSnapshot: vi.fn().mockReturnValue({
    updatedAt: null,
    results: [],
  }),
}));

vi.mock("../../services/integration-health.js", () => integrationHealthMocks);

vi.mock("../../services/provider-health/registry.js", () => ({
  getProviderHealth: vi.fn().mockReturnValue(null),
  ProviderHealth: { init: vi.fn().mockResolvedValue({ close: vi.fn() }) },
  setProviderHealth: vi.fn(),
}));

vi.mock("../../services/metrics/recorder.js", () => ({
  getMetricsRecorder: vi.fn().mockReturnValue(null),
}));

vi.mock("../../services/secrets.js", () => ({
  secretsKeyProblem: vi.fn().mockReturnValue(null),
  resolveVaultSecrets: vi.fn().mockResolvedValue({}),
  getSecret: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockImplementation(async () => {
    const { httpError } = await import("@openmapx/integration-framework");
    throw httpError(401, "Authentication required");
  }),
}));

export function getIntegrationHealthMocks() {
  return integrationHealthMocks;
}

/** The migration runner the host calls before importing an integration that owns tables. */
export function getExtensionMigrationMocks() {
  return extensionMigrationMocks;
}

/** The attention list the host raises the schema-ahead item on. */
export function getAttentionMocks() {
  return attentionMocks;
}

export function createIntegrationHostTestApp(): FastifyInstance {
  return Fastify({ logger: false }).register(integrationsRoute);
}
