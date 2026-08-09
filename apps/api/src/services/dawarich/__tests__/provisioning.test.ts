import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DAWARICH_APP_SERVICE_ID,
  DAWARICH_POSTGIS_SERVICE_ID,
  DAWARICH_SOFTWARE_ID,
  DAWARICH_WORKER_SERVICE_ID,
  inspectManagedDawarichProvisioning,
  MANAGED_REFERENCE_ID,
  type ManagedDawarichProvisioningDependencies,
  ManagedDawarichProvisioningError,
  type ManagedOAuthClient,
  provisionManagedDawarich,
  rotateManagedDawarichOidcSecret,
  validatePublicHostname,
} from "../provisioning.js";

const HEADERS = new Headers({ cookie: "session=admin" });
const ACTOR = "admin-1";
const GENERATION_KEY = "OPENMAPX_PROVISIONING_GENERATION";
const OIDC_RECOVERY_KEY = "OPENMAPX_OIDC_RECOVERY_REQUIRED";

function secretKey(serviceId: string, key: string): string {
  return `${serviceId}:${key}`;
}

function baseClient(overrides: Partial<ManagedOAuthClient> = {}): ManagedOAuthClient {
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

function createHarness(initial?: {
  clients?: ManagedOAuthClient[];
  secrets?: Record<string, string>;
  configs?: Record<string, Record<string, unknown>>;
  effectiveConfigOverrides?: Record<string, Record<string, unknown>>;
  runtime?: Partial<{
    installed: boolean;
    selected: boolean;
    running: boolean;
    healthy: boolean;
  }>;
}) {
  const clients = [...(initial?.clients ?? [])];
  const secrets = new Map(Object.entries(initial?.secrets ?? {}));
  const configs = new Map(Object.entries(initial?.configs ?? {}));
  let nextSecret = 0;
  let nextRandom = 0;
  let lockTail = Promise.resolve();
  const runtime = {
    installed: true,
    selected: false,
    running: false,
    healthy: false,
    ...initial?.runtime,
  };
  const appliedGenerations = new Map<string, string>();

  const listClients = vi.fn(async () => clients.map((client) => ({ ...client })));
  const createClient = vi.fn(async (_headers: Headers, body: Record<string, unknown>) => {
    const created = baseClient({
      ...(body as Partial<ManagedOAuthClient>),
      client_id: `client-${clients.length + 1}`,
      reference_id: MANAGED_REFERENCE_ID,
      client_secret: "oidc-created-sensitive-marker",
    });
    clients.push(created);
    return { ...created };
  });
  const updateClient = vi.fn(
    async (_headers: Headers, clientId: string, update: Partial<ManagedOAuthClient>) => {
      const index = clients.findIndex((client) => client.client_id === clientId);
      if (index < 0) throw new Error("missing client");
      clients[index] = { ...clients[index], ...update } as ManagedOAuthClient;
      return { ...clients[index] };
    },
  );
  const rotateClientSecret = vi.fn(async (_headers: Headers, clientId: string) => {
    const existing = clients.find((client) => client.client_id === clientId);
    if (!existing) throw new Error("missing client");
    return {
      ...existing,
      client_secret: `oidc-rotated-sensitive-marker-${++nextSecret}`,
    };
  });
  const getSecret = vi.fn(async (serviceId: string, key: string) => {
    return secrets.get(secretKey(serviceId, key)) ?? null;
  });
  const setSecret = vi.fn(
    async (serviceId: string, key: string, value: string, _updatedBy?: string | null) => {
      secrets.set(secretKey(serviceId, key), value);
    },
  );
  const getConfig = vi.fn(async (serviceId: string) => ({ ...(configs.get(serviceId) ?? {}) }));
  const getEffectiveConfig = vi.fn(async (serviceId: string) => ({
    ...(configs.get(serviceId) ?? {}),
    ...(initial?.effectiveConfigOverrides?.[serviceId] ?? {}),
  }));
  const mergeConfig = vi.fn(async (serviceId: string, updates: Record<string, unknown>) => {
    configs.set(serviceId, { ...(configs.get(serviceId) ?? {}), ...updates });
  });
  const withLock = vi.fn();
  const runWithLock: ManagedDawarichProvisioningDependencies["withLock"] = async <T>(
    work: () => Promise<T>,
  ): Promise<T> => {
    withLock();
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  };

  const dependencies: ManagedDawarichProvisioningDependencies = {
    listClients,
    createClient,
    updateClient,
    rotateClientSecret,
    getSecret,
    setSecret,
    getConfig,
    getEffectiveConfig,
    mergeConfig,
    withLock: runWithLock,
    randomBytes: (size) => Buffer.alloc(size, (size + ++nextRandom) % 256),
    getRuntimeState: async () => ({ ...runtime }),
    getAppliedGeneration: async (serviceId) => appliedGenerations.get(serviceId) ?? null,
  };
  return {
    dependencies,
    clients,
    secrets,
    configs,
    listClients,
    createClient,
    updateClient,
    rotateClientSecret,
    getSecret,
    setSecret,
    getConfig,
    getEffectiveConfig,
    mergeConfig,
    withLock,
    runtime,
    appliedGenerations,
  };
}

function provision(dependencies: ManagedDawarichProvisioningDependencies) {
  return provisionManagedDawarich(
    {
      headers: HEADERS,
      actorId: ACTOR,
      controllerDomain: "example.test",
    },
    dependencies,
  );
}

async function createAppliedHarness() {
  const harness = createHarness({ runtime: { selected: true, running: true, healthy: true } });
  await provision(harness.dependencies);
  const generation = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
  expect(generation).toMatch(/^[0-9a-f]{32}$/);
  harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, generation as string);
  harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, generation as string);
  vi.clearAllMocks();
  return { ...harness, generation: generation as string };
}

describe("validatePublicHostname", () => {
  it.each([
    "https://timeline.example.test",
    "timeline.example.test/path",
    "timeline.example.test:443",
    "user@timeline.example.test",
    "127.0.0.1",
    "localhost",
    "-bad.example.test",
    "bad_.example.test",
  ])("rejects non-exact DNS hostname %s", (value) => {
    expect(() => validatePublicHostname(value)).toThrow(ManagedDawarichProvisioningError);
  });

  it("normalizes a valid DNS hostname without changing its authority", () => {
    expect(validatePublicHostname("Timeline.Example.Test.")).toBe("timeline.example.test");
  });
});

describe("provisionManagedDawarich", () => {
  it("creates the exact Better Auth client, consistent secrets and managed config", async () => {
    const harness = createHarness();

    const result = await provision(harness.dependencies);

    expect(harness.createClient).toHaveBeenCalledWith(
      HEADERS,
      expect.objectContaining({
        client_name: "OpenMapX Managed Dawarich",
        client_uri: "https://timeline.example.test",
        software_id: DAWARICH_SOFTWARE_ID,
        software_version: "1.10.3",
        redirect_uris: ["https://timeline.example.test/users/auth/openid_connect/callback"],
        token_endpoint_auth_method: "client_secret_basic",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        scope: "openid profile email",
        require_pkce: true,
        skip_consent: true,
        enable_end_session: false,
        client_secret_expires_at: 0,
        type: "web",
      }),
    );
    const dbPassword = harness.secrets.get(
      secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD"),
    );
    expect(dbPassword).toBeTruthy();
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD"))).toBe(
      dbPassword,
    );
    expect(harness.secrets.get(secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD"))).toBe(
      dbPassword,
    );
    const rails = harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE"));
    expect(rails).toMatch(/^[0-9a-f]{128}$/);
    expect(harness.secrets.get(secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE"))).toBe(
      rails,
    );
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      "oidc-created-sensitive-marker",
    );
    expect(harness.secrets.get(secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      "oidc-created-sensitive-marker",
    );
    expect(harness.configs.get(DAWARICH_APP_SERVICE_ID)).toMatchObject({
      APPLICATION_HOSTS: "timeline.example.test",
      APPLICATION_URL: "https://timeline.example.test",
      DATABASE_HOST: "dawarich-postgis",
      REDIS_URL: "redis://dawarich-redis:6379",
      OIDC_ISSUER: "https://example.test/api/auth",
      OIDC_CLIENT_ID: "client-1",
      OIDC_PKCE_ENABLED: "true",
      OIDC_AUTO_REGISTER: "true",
    });
    expect(harness.configs.get(DAWARICH_WORKER_SERVICE_ID)).toEqual(
      harness.configs.get(DAWARICH_APP_SERVICE_ID),
    );
    expect(harness.configs.get(DAWARICH_POSTGIS_SERVICE_ID)).toMatchObject({
      POSTGRES_USER: "postgres",
      POSTGRES_DB: "dawarich_production",
    });
    expect(result.status).toMatchObject({
      installed: true,
      oauthClient: { present: true, clientId: "client-1", redirectUriMatches: true },
      secrets: {
        databasePassword: "consistent",
        secretKeyBase: "consistent",
        oidcClientSecret: "consistent",
      },
      configReady: true,
      readyToStart: true,
      needsApply: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sensitive-marker");
    expect(serialized).not.toContain(dbPassword as string);
    expect(serialized).not.toContain(rails as string);
  });

  it("is idempotent on a second provision and does not rotate or rewrite", async () => {
    const harness = createHarness();
    await provision(harness.dependencies);
    vi.clearAllMocks();

    const second = await provision(harness.dependencies);

    expect(harness.createClient).not.toHaveBeenCalled();
    expect(harness.updateClient).not.toHaveBeenCalled();
    expect(harness.rotateClientSecret).not.toHaveBeenCalled();
    expect(harness.setSecret).not.toHaveBeenCalled();
    expect(harness.mergeConfig).not.toHaveBeenCalled();
    expect(second.audit).toMatchObject({ created: false, reconciled: false, rotated: false });
  });

  it("keeps reconciled runtime changes pending across GETs until app and worker are applied", async () => {
    const harness = createHarness({ runtime: { selected: true, running: true, healthy: true } });
    const initial = await provision(harness.dependencies);
    const previousGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(previousGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(initial)).not.toContain(previousGeneration as string);
    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, previousGeneration as string);
    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, previousGeneration as string);

    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: false });

    Object.assign(harness.clients[0] as ManagedOAuthClient, { client_name: "Drifted client" });
    const reconciled = await provision(harness.dependencies);
    const desiredGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(desiredGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(desiredGeneration).not.toBe(previousGeneration);
    expect(reconciled.status.needsApply).toBe(true);
    expect(JSON.stringify(reconciled)).not.toContain(desiredGeneration as string);

    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: true });

    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, desiredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: true });

    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, desiredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: false });
  });

  it("does not churn a non-expiring Better Auth client whose expiry is omitted", async () => {
    const harness = createHarness();
    await provision(harness.dependencies);
    delete harness.clients[0]?.client_secret_expires_at;
    vi.clearAllMocks();

    const second = await provision(harness.dependencies);

    expect(harness.updateClient).not.toHaveBeenCalled();
    expect(second.audit.reconciled).toBe(false);
  });

  it("preserves a persisted custom public host when later requests omit the optional host", async () => {
    const harness = createHarness();
    await provisionManagedDawarich(
      {
        headers: HEADERS,
        actorId: ACTOR,
        controllerDomain: "example.test",
        publicHost: "history.example.test",
      },
      harness.dependencies,
    );
    vi.clearAllMocks();

    const status = await inspectManagedDawarichProvisioning(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );
    const second = await provision(harness.dependencies);

    expect(status.publicOrigin).toBe("https://history.example.test");
    expect(status.oauthClient.redirectUriMatches).toBe(true);
    expect(harness.updateClient).not.toHaveBeenCalled();
    expect(harness.mergeConfig).not.toHaveBeenCalled();
    expect(second.audit).toMatchObject({ created: false, reconciled: false, rotated: false });
  });

  it("reports persisted configuration drift as not ready to start", async () => {
    const harness = createHarness();
    await provision(harness.dependencies);
    harness.configs.clear();

    const status = await inspectManagedDawarichProvisioning(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );

    expect(status.configReady).toBe(false);
    expect(status.readyToStart).toBe(false);
  });

  it("rejects effective env override drift without exposing the override value", async () => {
    const overrideMarker = "operator-env-sensitive-marker";
    const harness = createHarness({
      effectiveConfigOverrides: {
        [DAWARICH_APP_SERVICE_ID]: { OIDC_CLIENT_ID: overrideMarker },
      },
    });

    const result = await provision(harness.dependencies);

    expect(result.status.configReady).toBe(false);
    expect(result.status.readyToStart).toBe(false);
    expect(harness.configs.get(DAWARICH_APP_SERVICE_ID)?.OIDC_CLIENT_ID).toBe("client-1");
    expect(JSON.stringify(result)).not.toContain(overrideMarker);
  });

  it.each([
    ["client name", { client_name: "Drifted client" }],
    ["client URI", { client_uri: "https://drifted.example.test" }],
    ["software version", { software_version: "0.0.0" }],
    ["redirect URI", { redirect_uris: ["https://drifted.example.test/callback"] }],
    ["grant types", { grant_types: ["authorization_code", "client_credentials"] }],
    ["response types", { response_types: ["code", "token"] }],
    ["scope", { scope: "openid" }],
    ["consent", { skip_consent: false }],
    ["end-session behavior", { enable_end_session: true }],
    ["secret expiry", { client_secret_expires_at: 123 }],
    ["client type", { type: "native" }],
  ] as const)("reports %s drift as OAuth-not-ready until reconciliation", async (_name, drift) => {
    const harness = createHarness();
    await provision(harness.dependencies);
    Object.assign(harness.clients[0] as ManagedOAuthClient, drift);

    const status = await inspectManagedDawarichProvisioning(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );

    expect(status.oauthClient.settingsMatch).toBe(false);
    expect(status.readyToStart).toBe(false);
    expect(harness.updateClient).not.toHaveBeenCalled();
  });

  it("reconciles only safe mutable client metadata and redirect drift", async () => {
    const harness = createHarness({
      clients: [
        baseClient({
          client_name: "Old name",
          redirect_uris: ["https://old.example.test/callback"],
          scope: "openid",
          client_secret_expires_at: 123,
        }),
      ],
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "same-db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "same-db",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "same-db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "same-rails",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE")]: "same-rails",
        [secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "same-oidc",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "same-oidc",
      },
    });

    const result = await provision(harness.dependencies);

    expect(harness.updateClient).toHaveBeenCalledWith(
      HEADERS,
      "client-1",
      expect.objectContaining({
        client_name: "OpenMapX Managed Dawarich",
        redirect_uris: ["https://timeline.example.test/users/auth/openid_connect/callback"],
        scope: "openid profile email",
        client_secret_expires_at: 0,
      }),
    );
    expect(result.audit.reconciled).toBe(true);
  });

  it("blocks duplicate persisted clients with the stable software id", async () => {
    const harness = createHarness({
      clients: [baseClient(), baseClient({ client_id: "client-2" })],
    });

    await expect(provision(harness.dependencies)).rejects.toMatchObject({
      code: "DAWARICH_OAUTH_CLIENT_CONFLICT",
    });
    expect(harness.setSecret).not.toHaveBeenCalled();
  });

  it("reports duplicate persisted clients as a read-only status conflict", async () => {
    const harness = createHarness({
      clients: [baseClient(), baseClient({ client_id: "client-2" })],
    });

    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({ code: "DAWARICH_OAUTH_CLIENT_CONFLICT" });
    expect(harness.setSecret).not.toHaveBeenCalled();
  });

  it("reports immutable OAuth security drift as a read-only status conflict", async () => {
    const harness = createHarness({ clients: [baseClient({ require_pkce: false })] });

    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({ code: "DAWARICH_OAUTH_CLIENT_CONFLICT" });
  });

  it.each([
    {
      name: "partial database copies",
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "db-a",
      },
      code: "DAWARICH_DATABASE_SECRET_CONFLICT",
    },
    {
      name: "mismatched database copies",
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "db-a",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "db-b",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "db-a",
      },
      code: "DAWARICH_DATABASE_SECRET_CONFLICT",
    },
    {
      name: "mismatched Rails copies",
      secrets: {
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "rails-a",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE")]: "rails-b",
      },
      code: "DAWARICH_RAILS_SECRET_CONFLICT",
    },
  ])("blocks $name without automatic repair", async ({ secrets, code }) => {
    const harness = createHarness({ clients: [baseClient()], secrets });

    await expect(provision(harness.dependencies)).rejects.toMatchObject({ code });
    expect(harness.setSecret).not.toHaveBeenCalled();
  });

  it("copies a single existing Rails secret to the missing peer without rotating it", async () => {
    const harness = createHarness({
      clients: [baseClient()],
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "db",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "existing-rails",
        [secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "oidc",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "oidc",
      },
    });

    await provision(harness.dependencies);

    expect(harness.secrets.get(secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE"))).toBe(
      "existing-rails",
    );
  });

  it("rotates once when existing OIDC vault copies are missing or inconsistent", async () => {
    const harness = createHarness({
      clients: [baseClient()],
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "db",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "rails",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE")]: "rails",
        [secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "old-a",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "old-b",
      },
    });

    const result = await provision(harness.dependencies);

    expect(harness.rotateClientSecret).toHaveBeenCalledTimes(1);
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      "oidc-rotated-sensitive-marker-1",
    );
    expect(harness.secrets.get(secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      "oidc-rotated-sensitive-marker-1",
    );
    expect(result.audit.rotated).toBe(true);
  });

  it("serializes concurrent provisions under one application lock", async () => {
    const harness = createHarness();

    const [first, second] = await Promise.all([
      provision(harness.dependencies),
      provision(harness.dependencies),
    ]);

    expect(harness.withLock).toHaveBeenCalledTimes(2);
    expect(harness.createClient).toHaveBeenCalledTimes(1);
    expect(harness.clients).toHaveLength(1);
    expect([first.audit.created, second.audit.created].filter(Boolean)).toHaveLength(1);
  });

  it("reports recovery required after a rotated secret cannot reach both vault copies", async () => {
    const harness = createHarness({
      clients: [baseClient()],
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "db",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "rails",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE")]: "rails",
      },
    });
    harness.setSecret.mockRejectedValueOnce(new Error("vault unavailable"));

    await expect(provision(harness.dependencies)).rejects.toMatchObject({
      code: "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED",
    });
    const second = await provision(harness.dependencies);
    expect(harness.rotateClientSecret).toHaveBeenCalledTimes(2);
    expect(second.audit.rotated).toBe(true);
    expect(JSON.stringify(second)).not.toContain("sensitive-marker");
  });

  it("blocks non-mutable OAuth security drift instead of weakening PKCE", async () => {
    const harness = createHarness({ clients: [baseClient({ require_pkce: false })] });

    await expect(provision(harness.dependencies)).rejects.toMatchObject({
      code: "DAWARICH_OAUTH_CLIENT_CONFLICT",
    });
    expect(harness.updateClient).not.toHaveBeenCalled();
  });
});

describe("rotateManagedDawarichOidcSecret", () => {
  it("does not rotate when the first recovery-phase write fails", async () => {
    const harness = await createAppliedHarness();
    harness.mergeConfig.mockRejectedValueOnce(new Error("app config unavailable"));

    await expect(
      rotateManagedDawarichOidcSecret(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toThrow("app config unavailable");

    expect(harness.rotateClientSecret).not.toHaveBeenCalled();
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      "oidc-created-sensitive-marker",
    );
  });

  it("does not rotate and fails closed when only the app pending generation is written", async () => {
    const harness = await createAppliedHarness();
    let mergeCount = 0;
    harness.mergeConfig.mockImplementation(async (serviceId, updates) => {
      mergeCount += 1;
      if (mergeCount === 4) throw new Error("worker config unavailable");
      harness.configs.set(serviceId, {
        ...(harness.configs.get(serviceId) ?? {}),
        ...updates,
      });
    });

    await expect(
      rotateManagedDawarichOidcSecret(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toThrow("worker config unavailable");

    expect(harness.rotateClientSecret).not.toHaveBeenCalled();
    expect(harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY]).not.toBe(
      harness.configs.get(DAWARICH_WORKER_SERVICE_ID)?.[GENERATION_KEY],
    );
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ configReady: false, needsApply: true });
  });

  it("keeps the new generation pending when Better Auth rotation fails", async () => {
    const harness = await createAppliedHarness();
    harness.rotateClientSecret.mockRejectedValueOnce(new Error("Better Auth unavailable"));

    await expect(
      rotateManagedDawarichOidcSecret(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toThrow("Better Auth unavailable");

    expect(harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY]).not.toBe(
      harness.generation,
    );
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      "oidc-created-sensitive-marker",
    );
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: true });
  });

  it.each([
    ["first", 1, false],
    ["second", 2, true],
  ] as const)(
    "does not rotate when the %s OIDC recovery-marker write fails",
    async (_name, failedMerge, recoveryRequired) => {
      const harness = await createAppliedHarness();
      let mergeCount = 0;
      harness.mergeConfig.mockImplementation(async (serviceId, updates) => {
        mergeCount += 1;
        if (mergeCount === failedMerge) throw new Error("recovery marker unavailable");
        harness.configs.set(serviceId, {
          ...(harness.configs.get(serviceId) ?? {}),
          ...updates,
        });
      });

      await expect(
        rotateManagedDawarichOidcSecret(
          { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
          harness.dependencies,
        ),
      ).rejects.toThrow("recovery marker unavailable");

      expect(harness.rotateClientSecret).not.toHaveBeenCalled();
      await expect(
        inspectManagedDawarichProvisioning(
          { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
          harness.dependencies,
        ),
      ).resolves.toMatchObject({ oauthClient: { recoveryRequired } });
    },
  );

  it.each(["first", "second"] as const)(
    "keeps rotation pending when the %s vault write fails",
    async (failedWrite) => {
      const harness = await createAppliedHarness();
      if (failedWrite === "first") {
        harness.setSecret.mockRejectedValueOnce(new Error("app vault unavailable"));
      } else {
        harness.setSecret
          .mockImplementationOnce(async (serviceId, key, value) => {
            harness.secrets.set(secretKey(serviceId, key), value);
          })
          .mockRejectedValueOnce(new Error("worker vault unavailable"));
      }

      await expect(
        rotateManagedDawarichOidcSecret(
          { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
          harness.dependencies,
        ),
      ).rejects.toMatchObject({ code: "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED" });

      const status = await inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      );
      expect(status.needsApply).toBe(true);
      expect(status.oauthClient.recoveryRequired).toBe(true);
      expect(status.secrets.oidcClientSecret).toBe(
        failedWrite === "first" ? "consistent" : "conflict",
      );
    },
  );

  it("cannot clear first-write OIDC recovery by applying both containers", async () => {
    const harness = await createAppliedHarness();
    harness.setSecret.mockRejectedValueOnce(new Error("app vault unavailable"));

    await expect(
      rotateManagedDawarichOidcSecret(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({ code: "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED" });

    const failedGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    const recoveryMarker = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[OIDC_RECOVERY_KEY];
    expect(recoveryMarker).toBeTruthy();
    expect(harness.configs.get(DAWARICH_WORKER_SERVICE_ID)?.[OIDC_RECOVERY_KEY]).toBeTruthy();
    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, failedGeneration as string);
    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, failedGeneration as string);

    const restartedStatus = await inspectManagedDawarichProvisioning(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );
    expect(restartedStatus).toMatchObject({
      oauthClient: { recoveryRequired: true },
      readyToStart: false,
      needsApply: false,
    });
    expect(JSON.stringify(restartedStatus)).not.toContain(recoveryMarker as string);
    expect(JSON.stringify(restartedStatus)).not.toContain(OIDC_RECOVERY_KEY);

    vi.clearAllMocks();
    const recovered = await provision(harness.dependencies);
    const recoveredGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(harness.rotateClientSecret).toHaveBeenCalledTimes(1);
    expect(recovered.status).toMatchObject({
      oauthClient: { recoveryRequired: false },
      readyToStart: true,
      needsApply: true,
    });
    expect(harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[OIDC_RECOVERY_KEY]).toBeNull();
    expect(harness.configs.get(DAWARICH_WORKER_SERVICE_ID)?.[OIDC_RECOVERY_KEY]).toBeNull();

    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, recoveredGeneration as string);
    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, recoveredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({
      oauthClient: { recoveryRequired: false },
      readyToStart: true,
      needsApply: false,
    });
  });

  it("requires a fresh full Apply after both containers apply during OIDC rotation", async () => {
    const harness = await createAppliedHarness();
    const oldSecret = harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"));
    let releaseVaultWrite!: () => void;
    let signalVaultWrite!: () => void;
    const vaultWriteReached = new Promise<void>((resolve) => {
      signalVaultWrite = resolve;
    });
    const vaultWriteReleased = new Promise<void>((resolve) => {
      releaseVaultWrite = resolve;
    });
    let firstWrite = true;
    harness.setSecret.mockImplementation(async (serviceId, key, value) => {
      if (firstWrite) {
        firstWrite = false;
        signalVaultWrite();
        await vaultWriteReleased;
      }
      harness.secrets.set(secretKey(serviceId, key), value);
    });

    const rotation = rotateManagedDawarichOidcSecret(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );
    await vaultWriteReached;

    const interimGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[OIDC_RECOVERY_KEY]).toBeTruthy();
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"))).toBe(
      oldSecret,
    );
    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, interimGeneration as string);
    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, interimGeneration as string);
    releaseVaultWrite();

    const result = await rotation;
    const finalGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(finalGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(finalGeneration).not.toBe(interimGeneration);
    expect(result.status).toMatchObject({
      oauthClient: { recoveryRequired: false },
      readyToStart: true,
      needsApply: true,
    });
    expect(harness.secrets.get(secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET"))).not.toBe(
      oldSecret,
    );
  });

  it("keeps a worker Apply between the two final-generation writes pending", async () => {
    const harness = await createAppliedHarness();
    let generationWrites = 0;
    harness.mergeConfig.mockImplementation(async (serviceId, updates) => {
      harness.configs.set(serviceId, {
        ...(harness.configs.get(serviceId) ?? {}),
        ...updates,
      });
      if (GENERATION_KEY in updates) {
        generationWrites += 1;
        if (generationWrites === 3) {
          harness.appliedGenerations.set(
            DAWARICH_APP_SERVICE_ID,
            updates[GENERATION_KEY] as string,
          );
          harness.appliedGenerations.set(
            DAWARICH_WORKER_SERVICE_ID,
            harness.configs.get(DAWARICH_WORKER_SERVICE_ID)?.[GENERATION_KEY] as string,
          );
        }
      }
    });

    const result = await rotateManagedDawarichOidcSecret(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );

    expect(generationWrites).toBe(4);
    expect(result.status).toMatchObject({
      oauthClient: { recoveryRequired: false },
      readyToStart: true,
      needsApply: true,
    });
  });

  it.each([
    ["first", 7],
    ["second", 8],
  ] as const)(
    "fails closed when the %s OIDC recovery-marker clear fails",
    async (_name, failedMerge) => {
      const harness = await createAppliedHarness();
      let mergeCount = 0;
      harness.mergeConfig.mockImplementation(async (serviceId, updates) => {
        mergeCount += 1;
        if (mergeCount === failedMerge) throw new Error("recovery clear unavailable");
        harness.configs.set(serviceId, {
          ...(harness.configs.get(serviceId) ?? {}),
          ...updates,
        });
      });

      await expect(
        rotateManagedDawarichOidcSecret(
          { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
          harness.dependencies,
        ),
      ).rejects.toMatchObject({ code: "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED" });

      const failedGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
      harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, failedGeneration as string);
      harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, failedGeneration as string);
      await expect(
        inspectManagedDawarichProvisioning(
          { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
          harness.dependencies,
        ),
      ).resolves.toMatchObject({
        oauthClient: { recoveryRequired: true },
        readyToStart: false,
        needsApply: false,
      });
    },
  );

  it("recovers a partial rotation once and stays pending until both containers apply", async () => {
    const harness = await createAppliedHarness();
    harness.setSecret
      .mockImplementationOnce(async (serviceId, key, value) => {
        harness.secrets.set(secretKey(serviceId, key), value);
      })
      .mockRejectedValueOnce(new Error("worker vault unavailable"));
    await expect(
      rotateManagedDawarichOidcSecret(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).rejects.toMatchObject({ code: "DAWARICH_OIDC_SECRET_RECOVERY_REQUIRED" });
    vi.clearAllMocks();

    const recovered = await provision(harness.dependencies);
    const desiredGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(harness.rotateClientSecret).toHaveBeenCalledTimes(1);
    expect(recovered.audit.rotated).toBe(true);
    expect(recovered.status).toMatchObject({
      secrets: { oidcClientSecret: "consistent" },
      needsApply: true,
    });
    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, desiredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: true });
    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, desiredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: false });

    vi.clearAllMocks();
    await provision(harness.dependencies);
    expect(harness.rotateClientSecret).not.toHaveBeenCalled();
  });

  it("rotates only the OIDC secret and marks the service for apply", async () => {
    const harness = createHarness({
      clients: [baseClient()],
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "keep-db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "keep-db",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "keep-db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "keep-rails",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE")]: "keep-rails",
        [secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "old-oidc",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "old-oidc",
      },
    });
    const before = createHash("sha256")
      .update(JSON.stringify([...harness.secrets].filter(([key]) => !key.includes("OIDC"))))
      .digest("hex");

    const result = await rotateManagedDawarichOidcSecret(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );

    const after = createHash("sha256")
      .update(JSON.stringify([...harness.secrets].filter(([key]) => !key.includes("OIDC"))))
      .digest("hex");
    expect(after).toBe(before);
    expect(harness.rotateClientSecret).toHaveBeenCalledTimes(1);
    expect(result.status.needsApply).toBe(true);
    expect(result.audit.rotated).toBe(true);
  });

  it("persists rotation apply state across GETs until the full bundle runs the new generation", async () => {
    const harness = createHarness({ runtime: { selected: true, running: true, healthy: true } });
    await provision(harness.dependencies);
    const previousGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, previousGeneration as string);
    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, previousGeneration as string);

    const rotated = await rotateManagedDawarichOidcSecret(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );
    const desiredGeneration = harness.configs.get(DAWARICH_APP_SERVICE_ID)?.[GENERATION_KEY];
    expect(desiredGeneration).toMatch(/^[0-9a-f]{32}$/);
    expect(desiredGeneration).not.toBe(previousGeneration);
    expect(rotated.status.needsApply).toBe(true);
    expect(JSON.stringify(rotated)).not.toContain(desiredGeneration as string);

    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: true });

    harness.appliedGenerations.set(DAWARICH_APP_SERVICE_ID, desiredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: true });

    harness.appliedGenerations.set(DAWARICH_WORKER_SERVICE_ID, desiredGeneration as string);
    await expect(
      inspectManagedDawarichProvisioning(
        { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
        harness.dependencies,
      ),
    ).resolves.toMatchObject({ needsApply: false });
  });

  it("uses the persisted custom public host in rotation status and audit", async () => {
    const harness = createHarness({
      clients: [
        baseClient({
          client_uri: "https://history.example.test",
          redirect_uris: ["https://history.example.test/users/auth/openid_connect/callback"],
        }),
      ],
      configs: {
        [DAWARICH_APP_SERVICE_ID]: { APPLICATION_URL: "https://history.example.test" },
      },
      secrets: {
        [secretKey(DAWARICH_POSTGIS_SERVICE_ID, "POSTGRES_PASSWORD")]: "keep-db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "DATABASE_PASSWORD")]: "keep-db",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "DATABASE_PASSWORD")]: "keep-db",
        [secretKey(DAWARICH_APP_SERVICE_ID, "SECRET_KEY_BASE")]: "keep-rails",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "SECRET_KEY_BASE")]: "keep-rails",
        [secretKey(DAWARICH_APP_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "old-oidc",
        [secretKey(DAWARICH_WORKER_SERVICE_ID, "OIDC_CLIENT_SECRET")]: "old-oidc",
      },
    });

    const result = await rotateManagedDawarichOidcSecret(
      { headers: HEADERS, actorId: ACTOR, controllerDomain: "example.test" },
      harness.dependencies,
    );

    expect(result.status.publicOrigin).toBe("https://history.example.test");
    expect(result.status.oauthClient.redirectUriMatches).toBe(true);
    expect(result.audit.hostname).toBe("history.example.test");
  });
});
