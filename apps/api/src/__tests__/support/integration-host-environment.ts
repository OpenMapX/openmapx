import Fastify, { type FastifyInstance } from "fastify";
import { vi } from "vitest";

vi.mock("../../redis.js", () => ({ redis: null }));

vi.mock("../../db.js", () => ({
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
  isSecretsConfigured: vi.fn().mockReturnValue(true),
  resolveVaultSecrets: vi.fn().mockResolvedValue({}),
  getSecret: vi.fn().mockReturnValue(undefined),
}));

vi.mock("../../utils/require-auth.js", () => ({
  requireAuth: vi.fn().mockImplementation(async () => {
    const { httpError } = await import("@openmapx/integration-framework");
    throw httpError(401, "Authentication required");
  }),
}));

vi.mock("@openmapx/poi-source-registry", () => ({
  beginPoiSourceRegistryStaging: vi.fn(),
  commitPoiSourceRegistryStaging: vi.fn(),
  registerPoiSources: vi.fn(),
  rollbackPoiSourceRegistryStaging: vi.fn(),
}));

export function getIntegrationHealthMocks() {
  return integrationHealthMocks;
}

export function createIntegrationHostTestApp(): FastifyInstance {
  return Fastify({ logger: false });
}
