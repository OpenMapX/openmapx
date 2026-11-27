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
  schemaAheadAttentionKey: (integrationId: string) => `integration-schema-ahead:${integrationId}`,
}));

vi.mock("../../extension-migrations.js", () => extensionMigrationMocks);

const attentionMocks = vi.hoisted(() => ({
  raiseAttention: vi.fn(async () => "inserted"),
  resolveAttention: vi.fn(async () => {}),
  listAttentionKeys: vi.fn(async () => []),
}));

vi.mock("../../services/attention.js", () => attentionMocks);

const disabledExtensionMocks = vi.hoisted(() => ({
  disabledExtensionIntegrationIds: vi.fn(async (): Promise<ReadonlySet<string>> => new Set()),
}));

// The default loader gate reads `installed_extension.enabled`: no extension is disabled.
vi.mock("../../services/installed-extension-state.js", () => disabledExtensionMocks);

const subjectDataMocks = vi.hoisted(() => ({
  syncSubjectHandlerTable: vi.fn(async () => {}),
  runPendingErasures: vi.fn(async () => ({ erased: 0, failed: 0 })),
}));

// The handler registry is real; the two calls that reach the database are not.
vi.mock("../../privacy/extension-subject-data.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../privacy/extension-subject-data")>()),
  ...subjectDataMocks,
}));

/** The run history of scheduled tasks, in memory, with one running row per task at most. */
const taskRunMocks = vi.hoisted(() => {
  const rows: Array<{
    id: string;
    integrationId: string;
    taskName: string;
    status: "running" | "succeeded" | "failed";
    error: string | null;
  }> = [];
  return {
    rows,
    store: {
      start: vi.fn(async (integrationId: string, taskName: string) => {
        if (
          rows.some(
            (row) =>
              row.integrationId === integrationId &&
              row.taskName === taskName &&
              row.status === "running",
          )
        )
          return null;
        const id = `run-${rows.length + 1}`;
        rows.push({ id, integrationId, taskName, status: "running", error: null });
        return id;
      }),
      finish: vi.fn(async (runId: string, status: "succeeded" | "failed", error?: string) => {
        const row = rows.find((candidate) => candidate.id === runId);
        if (row?.status !== "running") return;
        row.status = status;
        row.error = error ?? null;
      }),
      failInterrupted: vi.fn(async () => 0),
    },
  };
});

vi.mock("../../services/integration-task-runs.js", () => ({
  createTaskRunStore: () => taskRunMocks.store,
  pruneIntegrationTaskRuns: vi.fn(async () => 0),
}));

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

/** Where the host records the runs of scheduled tasks. */
export function getTaskRunMocks() {
  return taskRunMocks;
}

/** The attention list the host raises the schema-ahead item on. */
export function getAttentionMocks() {
  return attentionMocks;
}

/** The default disabled-extension gate the host reads before loading installed integrations. */
export function getDisabledExtensionMocks() {
  return disabledExtensionMocks;
}

/** The handler-table sync and the erasure run the host starts after each activation. */
export function getSubjectDataMocks() {
  return subjectDataMocks;
}

export function createIntegrationHostTestApp(): FastifyInstance {
  return Fastify({ logger: false }).register(integrationsRoute);
}
