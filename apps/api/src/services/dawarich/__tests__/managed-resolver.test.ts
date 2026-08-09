import { describe, expect, it, vi } from "vitest";
import {
  type ManagedDawarichResolverDependencies,
  ManagedDawarichServiceResolver,
} from "../managed-resolver.js";
import {
  DAWARICH_APP_SERVICE_ID,
  DAWARICH_SOFTWARE_ID,
  DAWARICH_WORKER_SERVICE_ID,
  MANAGED_REFERENCE_ID,
  type ManagedOAuthClient,
} from "../provisioning.js";

const GENERATION = "0123456789abcdef0123456789abcdef";

function readyClient(overrides: Partial<ManagedOAuthClient> = {}): ManagedOAuthClient {
  return {
    client_id: "client-1",
    client_name: "OpenMapX Managed Dawarich",
    client_uri: "https://timeline.example.test",
    software_id: DAWARICH_SOFTWARE_ID,
    software_version: "1.10.3",
    reference_id: MANAGED_REFERENCE_ID,
    redirect_uris: ["https://timeline.example.test/users/auth/openid_connect/callback"],
    token_endpoint_auth_method: "client_secret_basic",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "openid profile email",
    require_pkce: true,
    skip_consent: true,
    enable_end_session: false,
    public: false,
    disabled: false,
    type: "web",
    ...overrides,
  };
}

function readyConfig(origin = "https://timeline.example.test") {
  const hostname = new URL(origin).hostname;
  return {
    APPLICATION_HOSTS: hostname,
    APPLICATION_URL: origin,
    DOMAIN: hostname,
    APPLICATION_PROTOCOL: "https",
    REDIS_URL: "redis://dawarich-redis:6379",
    DATABASE_HOST: "dawarich-postgis",
    DATABASE_PORT: "5432",
    DATABASE_USERNAME: "postgres",
    DATABASE_NAME: "dawarich_production",
    TIME_ZONE: "UTC",
    OIDC_ISSUER: "https://example.test/api/auth",
    OIDC_CLIENT_ID: "client-1",
    OIDC_REDIRECT_URI: `${origin}/users/auth/openid_connect/callback`,
    OIDC_PROVIDER_NAME: "OpenMapX",
    OIDC_AUTO_REGISTER: "true",
    OIDC_PKCE_ENABLED: "true",
    OPENMAPX_PROVISIONING_GENERATION: GENERATION,
  };
}

function createHarness(
  options: {
    installed?: boolean;
    selected?: boolean;
    appConfig?: Record<string, unknown>;
    workerConfig?: Record<string, unknown>;
    secrets?: Record<string, string>;
    healthOk?: boolean;
    oauthAuthority?: { issuer: string; clients: readonly ManagedOAuthClient[] };
    appliedGenerations?: Partial<Record<string, string | null>>;
    desiredGenerations?: Partial<Record<string, string | null>>;
  } = {},
) {
  let now = 1_000;
  const config = readyConfig();
  const secrets = options.secrets ?? {
    "dawarich-postgis:POSTGRES_PASSWORD": "same-db",
    "dawarich-app:DATABASE_PASSWORD": "same-db",
    "dawarich-sidekiq:DATABASE_PASSWORD": "same-db",
    "dawarich-app:SECRET_KEY_BASE": "same-rails",
    "dawarich-sidekiq:SECRET_KEY_BASE": "same-rails",
    "dawarich-app:OIDC_CLIENT_SECRET": "same-oidc",
    "dawarich-sidekiq:OIDC_CLIENT_SECRET": "same-oidc",
  };
  const fetchHealth = vi.fn(
    async (_url: string, _init: RequestInit): Promise<Pick<Response, "ok">> => ({
      ok: options.healthOk ?? true,
    }),
  );
  const dependencies: ManagedDawarichResolverDependencies = {
    getRuntimeState: () => ({
      installed: options.installed ?? true,
      selected: options.selected ?? true,
      internalBaseUrl: "http://dawarich-app:3000",
    }),
    getConfig: vi.fn(async (serviceId) =>
      serviceId === "dawarich-app"
        ? (options.appConfig ?? config)
        : serviceId === "dawarich-sidekiq"
          ? (options.workerConfig ?? config)
          : { POSTGRES_USER: "postgres", POSTGRES_DB: "dawarich_production" },
    ),
    getSecret: vi.fn(async (serviceId, key) => secrets[`${serviceId}:${key}`] ?? null),
    getOAuthAuthority: vi.fn(
      async () =>
        options.oauthAuthority ?? {
          issuer: "https://example.test/api/auth",
          clients: [readyClient()],
        },
    ),
    fetchHealth,
    now: () => now,
    getAppliedGeneration: vi.fn(async (serviceId: string) => {
      if (serviceId in (options.appliedGenerations ?? {})) {
        return options.appliedGenerations?.[serviceId] ?? null;
      }
      return GENERATION;
    }),
    getDesiredGeneration: vi.fn(async (serviceId: string) => {
      if (serviceId in (options.desiredGenerations ?? {})) {
        return options.desiredGenerations?.[serviceId] ?? null;
      }
      return GENERATION;
    }),
  };
  return { dependencies, fetchHealth, advance: (milliseconds: number) => (now += milliseconds) };
}

describe("ManagedDawarichServiceResolver", () => {
  it.each([
    { installed: false, selected: false },
    { installed: true, selected: false },
  ])("is unavailable without a complete selected bundle: %o", async (runtime) => {
    const harness = createHarness(runtime);
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toBeNull();
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it("keeps public and internal origins separate and health-probes only the internal URL", async () => {
    const harness = createHarness();
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toEqual({
      internalBaseUrl: "http://dawarich-app:3000",
      publicOrigin: "https://timeline.example.test",
      provisioned: true,
      healthy: true,
    });
    expect(harness.fetchHealth).toHaveBeenCalledWith(
      "http://dawarich-app:3000/api/v1/health",
      expect.objectContaining({
        method: "GET",
        redirect: "error",
        cache: "no-store",
      }),
    );
    const request = harness.fetchHealth.mock.calls[0]?.[1];
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(request)).not.toContain("timeline.example.test");
  });

  it.each([
    readyConfig("http://timeline.example.test"),
    readyConfig("https://timeline.example.test:444"),
    { ...readyConfig(), APPLICATION_URL: "https://timeline.example.test/path" },
    { ...readyConfig(), OIDC_CLIENT_ID: "" },
    { ...readyConfig(), OIDC_PKCE_ENABLED: "false" },
    { ...readyConfig(), TIME_ZONE: undefined },
  ])("marks invalid or incomplete operator config unprovisioned", async (appConfig) => {
    const harness = createHarness({ appConfig });
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toMatchObject({
      publicOrigin: "",
      provisioned: false,
      healthy: false,
    });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it("marks partial or conflicting file secrets unprovisioned", async () => {
    const harness = createHarness({
      secrets: {
        "dawarich-postgis:POSTGRES_PASSWORD": "db-a",
        "dawarich-app:DATABASE_PASSWORD": "db-a",
        "dawarich-sidekiq:DATABASE_PASSWORD": "db-b",
      },
    });
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toMatchObject({ provisioned: false, healthy: false });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it.each([
    ["neither container", {}],
    ["only the app container", { [DAWARICH_APP_SERVICE_ID]: GENERATION }],
    [
      "a stale worker container",
      {
        [DAWARICH_APP_SERVICE_ID]: GENERATION,
        [DAWARICH_WORKER_SERVICE_ID]: "fedcba9876543210fedcba9876543210",
      },
    ],
  ] as const)(
    "fails closed while %s has the desired generation",
    async (_name, appliedGenerations) => {
      const harness = createHarness({
        appliedGenerations: {
          [DAWARICH_APP_SERVICE_ID]: null,
          [DAWARICH_WORKER_SERVICE_ID]: null,
          ...appliedGenerations,
        },
      });
      const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

      await expect(resolver.resolve()).resolves.toMatchObject({
        publicOrigin: "",
        provisioned: false,
        healthy: false,
      });
      expect(harness.fetchHealth).not.toHaveBeenCalled();
    },
  );

  it("rejects effective env markers that mask a newer database generation", async () => {
    const staleGeneration = "fedcba9876543210fedcba9876543210";
    const effectiveConfig = {
      ...readyConfig(),
      OPENMAPX_PROVISIONING_GENERATION: staleGeneration,
    };
    const harness = createHarness({
      appConfig: effectiveConfig,
      workerConfig: effectiveConfig,
      desiredGenerations: {
        [DAWARICH_APP_SERVICE_ID]: GENERATION,
        [DAWARICH_WORKER_SERVICE_ID]: GENERATION,
      },
      appliedGenerations: {
        [DAWARICH_APP_SERVICE_ID]: staleGeneration,
        [DAWARICH_WORKER_SERVICE_ID]: staleGeneration,
      },
    });
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toMatchObject({
      publicOrigin: "",
      provisioned: false,
      healthy: false,
    });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it.each([
    ["missing app", { [DAWARICH_APP_SERVICE_ID]: null }],
    ["missing worker", { [DAWARICH_WORKER_SERVICE_ID]: null }],
    ["conflicting worker", { [DAWARICH_WORKER_SERVICE_ID]: "fedcba9876543210fedcba9876543210" }],
  ] as const)("rejects a %s raw desired generation", async (_name, desiredGenerations) => {
    const harness = createHarness({ desiredGenerations });
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toMatchObject({
      provisioned: false,
      healthy: false,
    });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted", { issuer: "https://example.test/api/auth", clients: [] }],
    [
      "replaced",
      { issuer: "https://example.test/api/auth", clients: [readyClient({ client_id: "other" })] },
    ],
    [
      "duplicated",
      {
        issuer: "https://example.test/api/auth",
        clients: [readyClient(), readyClient({ client_id: "client-2" })],
      },
    ],
    [
      "security-drifted",
      {
        issuer: "https://example.test/api/auth",
        clients: [readyClient({ grant_types: ["authorization_code", "client_credentials"] })],
      },
    ],
    [
      "issued elsewhere",
      { issuer: "https://other.example.test/api/auth", clients: [readyClient()] },
    ],
  ] as const)("marks a %s Better Auth authority unprovisioned", async (_name, oauthAuthority) => {
    const harness = createHarness({ oauthAuthority });
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toMatchObject({
      publicOrigin: "",
      provisioned: false,
      healthy: false,
    });
    expect(harness.fetchHealth).not.toHaveBeenCalled();
  });

  it("caches only the health result for no more than fifteen seconds", async () => {
    const harness = createHarness();
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies, 15_000);

    await resolver.resolve();
    harness.advance(14_999);
    await resolver.resolve();
    expect(harness.fetchHealth).toHaveBeenCalledTimes(1);

    harness.advance(1);
    await resolver.resolve();
    expect(harness.fetchHealth).toHaveBeenCalledTimes(2);
  });

  it("treats health failures as unhealthy without leaking or throwing", async () => {
    const harness = createHarness();
    harness.fetchHealth.mockRejectedValueOnce(new Error("sensitive upstream failure"));
    const resolver = new ManagedDawarichServiceResolver(harness.dependencies);

    await expect(resolver.resolve()).resolves.toMatchObject({ provisioned: true, healthy: false });
  });
});
