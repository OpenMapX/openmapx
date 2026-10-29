import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  type OpsOperation,
  opsOperationFingerprint,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUnavailableRuntime, dispatchOpsOperation, type OpsTrustedClaim } from "./runtime";
import {
  initializeTrustedConfigurationRuntime,
  installTrustedConfigurationRuntime,
  readTrustedEnabledServiceIds,
} from "./trusted-config-runtime";

const roots: string[] = [];
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function service(id: string): services.LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: {
        image: `example/${id}`,
        tag: "1",
        ...(id === "app-api" ? { environment: { DOCKER_CONFIG: "/root/.docker" } } : {}),
      },
      configSchema: {
        type: "object",
        properties: {
          PUBLIC_SETTING: { type: "string" },
          PRIVATE_SETTING: { type: "string", "x-openmapx-secret": true },
        },
      },
    },
    directory: `/trusted/services/${id}`,
    isBuiltIn: true,
    enabled: true,
  };
}

function checkedInSchema(relativePath: string): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, relativePath), "utf8")) as {
    configSchema: Record<string, unknown>;
  };
  return manifest.configSchema;
}

function payload(
  overrides: Partial<TrustedConfigurationPayload> = {},
): TrustedConfigurationPayload {
  return {
    domain: "maps.example.test",
    serviceConfigs: [{ serviceId: "alpha", values: { PUBLIC_SETTING: "enabled" } }],
    integrationConfigs: [{ integrationId: "routing", values: { enabled: true } }],
    serviceSecrets: [],
    ...overrides,
  };
}

function claim(
  operation: OpsOperation,
  value = payload(),
  values: Record<string, string | number | boolean | null> = {},
): OpsTrustedClaim {
  const revisionId = "revisionId" in operation ? operation.revisionId : "invalid";
  return {
    fingerprint: opsOperationFingerprint(operation),
    operation,
    source: "trusted-data",
    capability: { revisionId, values, trustedConfiguration: value },
  };
}

/** The operator's selection, as `services enable` or the admin panel leaves it. */
function select(infraDir: string, roots: string[]): void {
  const path = services.serviceSelectionPath(infraDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ selected: roots }), { mode: 0o600 });
}

const deploymentUserEnv = `UID=${process.geteuid?.() ?? 0}\nGID=${process.getegid?.() ?? 0}\n`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-trusted-runtime-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  // The whole checkout is mounted, as this release's manifest has it.
  mkdirSync(join(root, "services"), { recursive: true });
  // The deployment's user, which only a host render writes into .env.
  writeFileSync(join(infraDir, ".env"), deploymentUserEnv, { mode: 0o600 });
  select(infraDir, ["alpha"]);
  const current = join(infraDir, services.CURRENT_CONFIGURATION);
  return {
    root,
    infraDir,
    current,
    generations: join(infraDir, services.CONFIGURATION_GENERATIONS),
    compose: join(current, "docker-compose.generated.yml"),
    selection: join(current, "service-selection.json"),
    hardlinks: join(current, "docker-compose.generated.hardlinks.json"),
  };
}

/** Point the current pointer at a generation, with the link text the writer uses. */
function pointCurrentAt(paths: ReturnType<typeof fixture>, revision: string): void {
  mkdirSync(dirname(paths.current), { recursive: true, mode: 0o700 });
  symlinkSync(join(relative(dirname(paths.current), paths.generations), revision), paths.current);
}

async function installSentinelGeneration(paths: ReturnType<typeof fixture>): Promise<void> {
  const oldRevision = `cfg1_${"o".repeat(43)}`;
  const oldGeneration = join(paths.generations, oldRevision);
  mkdirSync(oldGeneration, { recursive: true, mode: 0o700 });
  chmodSync(paths.generations, 0o700);
  chmodSync(oldGeneration, 0o700);
  for (const name of [
    "docker-compose.generated.yml",
    "service-selection.json",
    "docker-compose.generated.hardlinks.json",
  ])
    writeFileSync(join(oldGeneration, name), "sentinel", { mode: 0o600 });
  pointCurrentAt(paths, oldRevision);
}

describe("ops-agent trusted configuration runtime", () => {
  it("renders from its own registry and atomically owns selection, compose, secrets, and hardlink plan", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha"), service("beta")],
      integrationSchemas: new Map([["routing", { enabled: { type: "boolean" } }]]),
      infraDir: paths.infraDir,
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const secretValue = Buffer.from([9, 8, 7, 6]).toString("base64url");
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "serviceSelection.apply" as const,
      revisionId,
    };
    select(paths.infraDir, ["beta"]);
    const trusted = claim(
      operation,
      payload({
        selectedRoots: ["alpha"],
        serviceSecrets: [{ serviceId: "alpha", values: { PRIVATE_SETTING: secretValue } }],
      }),
    );
    const result = await dispatchOpsOperation(runtime, operation, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: trusted,
    });
    expect(result).toEqual({
      outcome: "committed",
      revisionId,
      enabledServiceIds: ["alpha"],
      followUp: "complete",
      cleanupFailed: false,
    });
    expect(JSON.parse(readFileSync(paths.selection, "utf8"))).toEqual({ selected: ["alpha"] });
    // The new selection is the operator's from now on, for the CLI too.
    expect(JSON.parse(readFileSync(services.serviceSelectionPath(paths.infraDir), "utf8"))).toEqual(
      { selected: ["alpha"] },
    );
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
    expect(readFileSync(paths.compose, "utf8")).not.toContain(secretValue);
    expect(JSON.parse(readFileSync(paths.hardlinks, "utf8"))).toEqual([]);
    expect(
      readFileSync(join(paths.current, ".generated-secrets", "alpha", "PRIVATE_SETTING"), "utf8"),
    ).toBe(secretValue);
    // Compose bind-mounts a file secret keeping its owner and mode, so a container
    // running as another uid must be able to read it; the 0700 directories are
    // the host-side boundary.
    expect(
      statSync(join(paths.current, ".generated-secrets", "alpha", "PRIVATE_SETTING")).mode & 0o777,
    ).toBe(0o444);
    expect(statSync(join(paths.current, ".generated-secrets")).mode & 0o777).toBe(0o700);
    expect(statSync(join(paths.current, ".generated-secrets", "alpha")).mode & 0o777).toBe(0o700);
    await expect(initializeTrustedConfigurationRuntime(paths.infraDir)).resolves.toBeUndefined();
  });

  it("renders an env-sourced config key as a reference to the host env, never as a value", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha"), service("beta")],
      integrationSchemas: new Map([["routing", { enabled: { type: "boolean" } }]]),
      infraDir: paths.infraDir,
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "stack.render" as const,
      revisionId,
    };
    const trusted = claim(
      operation,
      payload({
        serviceConfigs: [{ serviceId: "alpha", values: {}, envKeys: ["PUBLIC_SETTING"] }],
      }),
    );
    await dispatchOpsOperation(runtime, operation, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: trusted,
    });
    expect(readFileSync(paths.compose, "utf8")).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Assert the literal Compose interpolation emitted for the container.
      "PUBLIC_SETTING: ${SERVICE_ALPHA_PUBLIC_SETTING:-}",
    );
  });

  it.each([
    ["unknown service config", payload({ serviceConfigs: [{ serviceId: "missing", values: {} }] })],
    [
      "unknown config key",
      payload({ serviceConfigs: [{ serviceId: "alpha", values: { ARBITRARY_ENV: "blocked" } }] }),
    ],
    [
      "secret in environment config",
      payload({ serviceConfigs: [{ serviceId: "alpha", values: { PRIVATE_SETTING: "blocked" } }] }),
    ],
    [
      "env reference to a secret",
      payload({
        serviceConfigs: [{ serviceId: "alpha", values: {}, envKeys: ["PRIVATE_SETTING"] }],
      }),
    ],
    [
      "env reference to an undeclared key",
      payload({
        serviceConfigs: [{ serviceId: "alpha", values: {}, envKeys: ["ARBITRARY_ENV"] }],
      }),
    ],
    [
      "env reference beside a value for the same key",
      payload({
        serviceConfigs: [
          { serviceId: "alpha", values: { PUBLIC_SETTING: "x" }, envKeys: ["PUBLIC_SETTING"] },
        ],
      }),
    ],
    [
      "undeclared secret file",
      payload({ serviceSecrets: [{ serviceId: "alpha", values: { UNKNOWN_SECRET: "blocked" } }] }),
    ],
    [
      "unknown service secret",
      payload({
        serviceSecrets: [{ serviceId: "missing", values: { PRIVATE_SETTING: "blocked" } }],
      }),
    ],
    ["selection outside a selection apply", payload({ selectedRoots: ["beta"] })],
    [
      "mismatched integration",
      payload({ integrationConfigs: [{ integrationId: "missing", values: {} }] }),
    ],
  ] as const)("rejects %s before any host mutation", async (_label, invalidPayload) => {
    const paths = fixture();
    await installSentinelGeneration(paths);
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha"), service("beta")],
      integrationSchemas: new Map([["routing", { enabled: { type: "boolean" } }]]),
      infraDir: paths.infraDir,
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    await expect(
      dispatchOpsOperation(
        runtime,
        {
          expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
          kind: "stack.render",
          revisionId,
        },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: claim(
            {
              expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
              kind: "stack.render",
              revisionId,
            },
            invalidPayload,
          ),
        },
      ),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(
      [paths.compose, paths.selection, paths.hardlinks].map((path) => readFileSync(path, "utf8")),
    ).toEqual(["sentinel", "sentinel", "sentinel"]);
  });

  it("rejects an app-api baseline control environment override from the snapshot", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("app-api")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "stack.render" as const,
      revisionId,
    };
    select(paths.infraDir, ["app-api"]);
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          operation,
          payload({
            serviceConfigs: [
              { serviceId: "app-api", values: { DOCKER_CONFIG: "/attacker/control" } },
            ],
            integrationConfigs: [],
          }),
        ),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(existsSync(paths.current)).toBe(false);
  });

  it("synthesizes only schema-backed service/integration placeholders and selection controls", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("app-api"), service("alpha")],
      integrationSchemas: new Map([
        ["routing-demo", { properties: { region: { type: "string" } } }],
      ]),
      infraDir: paths.infraDir,
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "stack.render" as const,
      revisionId,
    };
    select(paths.infraDir, ["app-api", "alpha"]);
    await dispatchOpsOperation(runtime, operation, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: claim(
        operation,
        payload({
          serviceConfigs: [{ serviceId: "alpha", values: {} }],
          integrationConfigs: [{ integrationId: "routing-demo", values: {} }],
        }),
      ),
    });
    const compose = readFileSync(paths.compose, "utf8");
    expect(compose).toContain("OPENMAPX_APPLIED_SERVICES: app-api,alpha");
    expect(compose).toContain(`SERVICE_ALPHA_PUBLIC_SETTING: \${SERVICE_ALPHA_PUBLIC_SETTING:-}`);
    expect(compose).toContain(
      `INTEGRATION_ROUTING_DEMO_REGION: \${INTEGRATION_ROUTING_DEMO_REGION:-}`,
    );
    expect(compose).not.toContain(`DOCKER_CONFIG: \${DOCKER_CONFIG:-}`);
  });

  it.each([
    ["empty provider array", { providers: [] }],
    [
      "too many providers",
      {
        providers: Array.from({ length: 21 }, (_, index) => ({ id: `p${index}`, type: "keyword" })),
      },
    ],
    ["missing required provider field", { providers: [{ id: "local", type: "ollama" }] }],
    [
      "extra nested provider field",
      { providers: [{ id: "keyword", type: "keyword", unexpected: true }] },
    ],
    ["invalid nested pattern", { providers: [{ id: "INVALID", type: "keyword" }] }],
    [
      "non-http URL",
      { providers: [{ id: "local", type: "ollama", model: "demo", baseURL: "file:///etc" }] },
    ],
    [
      "numeric lower bound",
      { providers: [{ id: "local", type: "ollama", model: "demo", timeoutMs: 249 }] },
    ],
    [
      "conditional required object",
      {
        providers: [
          {
            id: "remote",
            type: "openai-compatible",
            model: "demo",
            baseURL: "http://remote.example.test",
            local: false,
          },
        ],
      },
    ],
  ] as const)("rejects a real search-nlp schema bypass: %s", async (_label, values) => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map([
        ["search-nlp", checkedInSchema("integrations/search-nlp/manifest.json")],
      ]),
      infraDir: paths.infraDir,
    });
    const revisionId = `cfg1_${"v".repeat(43)}`;
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "integrationConfig.apply" as const,
      integrationId: "search-nlp",
      revisionId,
    };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          operation,
          payload({
            integrationConfigs: [
              {
                integrationId: "search-nlp",
                values: structuredClone(
                  values,
                ) as TrustedConfigurationPayload["integrationConfigs"][number]["values"],
              },
            ],
          }),
        ),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(existsSync(paths.current)).toBe(false);
  });

  it("rejects read-only values using the checked-in Dawarich service schema", async () => {
    const paths = fixture();
    const dawarich = service("dawarich-app");
    dawarich.manifest.configSchema = checkedInSchema("services/dawarich-app/service.json");
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [dawarich],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
    });
    const revisionId = `cfg1_${"w".repeat(43)}`;
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "serviceConfig.apply" as const,
      serviceId: "dawarich-app",
      revisionId,
    };
    select(paths.infraDir, ["dawarich-app"]);
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          operation,
          payload({
            serviceConfigs: [
              {
                serviceId: "dawarich-app",
                values: { OPENMAPX_PROVISIONING_GENERATION: "caller-controlled" },
              },
            ],
            integrationConfigs: [],
          }),
        ),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(existsSync(paths.current)).toBe(false);
  });

  it.each([
    ["unsupported vocabulary", { type: "string", minProperties: 1 }],
    ["unsafe regular expression", { type: "string", pattern: "^(a+)+$" }],
  ] as const)("rejects %s in an agent-owned schema", async (_label, definition) => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map([
        ["custom", { type: "object", properties: { value: definition } }],
      ]),
      infraDir: paths.infraDir,
    });
    const revisionId = `cfg1_${"x".repeat(43)}`;
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "integrationConfig.apply" as const,
      integrationId: "custom",
      revisionId,
    };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          operation,
          payload({ integrationConfigs: [{ integrationId: "custom", values: { value: "aaaa" } }] }),
        ),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(existsSync(paths.current)).toBe(false);
  });

  it("refreshes one agent-owned service/integration authority snapshot for install, schema update, and removal", async () => {
    const paths = fixture();
    const community = service("community-live");
    community.isBuiltIn = false;
    community.manifest.quality = "community";
    community.manifest.container.digest = `sha256:${"a".repeat(64)}`;
    let authority = {
      revisionId: "authority-initial",
      services: [service("alpha")],
      integrationSchemas: new Map<string, Record<string, unknown>>(),
    };
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: authority.services,
      integrationSchemas: authority.integrationSchemas,
      loadAuthority: async () => authority,
      infraDir: paths.infraDir,
    });

    authority = {
      revisionId: "authority-installed",
      services: [service("alpha"), community],
      integrationSchemas: new Map([
        ["integration-live", { type: "object", properties: { region: { enum: ["eu"] } } }],
      ]),
    };
    const selectionRevision = `cfg1_${"i".repeat(43)}`;
    const selection = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "serviceSelection.apply" as const,
      revisionId: selectionRevision,
    };
    await expect(
      dispatchOpsOperation(runtime, selection, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          selection,
          payload({
            selectedRoots: ["community-live"],
            serviceConfigs: [{ serviceId: "community-live", values: {} }],
            integrationConfigs: [{ integrationId: "integration-live", values: { region: "eu" } }],
          }),
          { authorityRevision: authority.revisionId },
        ),
      }),
    ).resolves.toMatchObject({
      outcome: "committed",
      revisionId: selectionRevision,
      enabledServiceIds: ["community-live"],
    });
    expect(readFileSync(paths.compose, "utf8")).toContain("community-live:");

    authority = {
      ...authority,
      revisionId: "authority-schema-updated",
      integrationSchemas: new Map([
        ["integration-live", { type: "object", properties: { region: { enum: ["us"] } } }],
      ]),
    };
    const configRevision = `cfg1_${"j".repeat(43)}`;
    const config = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "integrationConfig.apply" as const,
      integrationId: "integration-live",
      revisionId: configRevision,
    };
    await expect(
      dispatchOpsOperation(runtime, config, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          config,
          payload({
            serviceConfigs: [{ serviceId: "community-live", values: {} }],
            integrationConfigs: [{ integrationId: "integration-live", values: { region: "eu" } }],
          }),
          { authorityRevision: authority.revisionId },
        ),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });

    authority = {
      revisionId: "authority-removed",
      services: [service("alpha")],
      integrationSchemas: new Map(),
    };
    const removedRevision = `cfg1_${"k".repeat(43)}`;
    const removed = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "serviceSelection.apply" as const,
      revisionId: removedRevision,
    };
    await expect(
      dispatchOpsOperation(runtime, removed, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          removed,
          payload({
            selectedRoots: ["community-live"],
            serviceConfigs: [{ serviceId: "community-live", values: {} }],
            integrationConfigs: [],
          }),
          { authorityRevision: authority.revisionId },
        ),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
  });

  it("keeps all existing outputs intact when interrupted before the commit boundary", async () => {
    const paths = fixture();
    await installSentinelGeneration(paths);
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
      beforeCommit: async () => {
        throw new Error("simulated crash");
      },
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    await expect(
      dispatchOpsOperation(
        runtime,
        {
          expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
          kind: "stack.render",
          revisionId,
        },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: claim(
            {
              expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
              kind: "stack.render",
              revisionId,
            },
            payload({ integrationConfigs: [] }),
          ),
        },
      ),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(
      [paths.compose, paths.selection, paths.hardlinks].map((path) => readFileSync(path, "utf8")),
    ).toEqual(["sentinel", "sentinel", "sentinel"]);
    expect(existsSync(join(paths.current, ".generated-secrets"))).toBe(false);
  });

  it("recovers a crash immediately after the one-pointer commit without reverting the new generation", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
      afterCommit: async () => {
        throw new Error("simulated post-commit crash");
      },
    });
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    await expect(
      dispatchOpsOperation(
        runtime,
        {
          expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
          kind: "stack.render",
          revisionId,
        },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: claim(
            {
              expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
              kind: "stack.render",
              revisionId,
            },
            payload({ integrationConfigs: [] }),
          ),
        },
      ),
    ).resolves.toMatchObject({ outcome: "committed", followUp: "failed" });
    await initializeTrustedConfigurationRuntime(paths.infraDir);
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
    expect(readFileSync(paths.selection, "utf8")).toContain("alpha");
  });

  it("resumes an identical orphan generation after a crash before the pointer swap", async () => {
    const paths = fixture();
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "stack.render" as const,
      revisionId,
    };
    const crashing = createUnavailableRuntime();
    installTrustedConfigurationRuntime(crashing, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
      afterGenerationRename: async () => {
        throw new Error("simulated crash");
      },
    });
    await expect(
      dispatchOpsOperation(crashing, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(existsSync(paths.current)).toBe(false);
    expect(() => readTrustedEnabledServiceIds(paths.infraDir, [service("alpha")])).toThrow(
      "Trusted configuration apply failed",
    );

    const retry = createUnavailableRuntime();
    installTrustedConfigurationRuntime(retry, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
    });
    await expect(
      dispatchOpsOperation(retry, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({ outcome: "committed", revisionId, enabledServiceIds: ["alpha"] });
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
  });

  it("rejects a dangling trusted-current pointer instead of authorizing baked selection", async () => {
    const paths = fixture();
    pointCurrentAt(paths, `cfg1_${"d".repeat(43)}`);

    await expect(initializeTrustedConfigurationRuntime(paths.infraDir)).rejects.toThrow(
      "Trusted configuration apply failed",
    );
    expect(() => readTrustedEnabledServiceIds(paths.infraDir, [service("alpha")])).toThrow(
      "Trusted configuration apply failed",
    );
  });

  it("enters recovery-only state when the current pointer disappears after activation", async () => {
    const paths = fixture();
    const revisionId = `cfg1_${"p".repeat(43)}`;
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "stack.render" as const,
      revisionId,
    };
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
    });
    await dispatchOpsOperation(runtime, operation, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: claim(operation, payload({ integrationConfigs: [] })),
    });
    unlinkSync(paths.current);

    await expect(initializeTrustedConfigurationRuntime(paths.infraDir)).resolves.toBeUndefined();
    expect(() => readTrustedEnabledServiceIds(paths.infraDir, [service("alpha")])).toThrow(
      "Trusted configuration apply failed",
    );

    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({ outcome: "committed", revisionId, enabledServiceIds: ["alpha"] });
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
  });

  it("rejects a direct replay after a post-pointer crash without reapplying", async () => {
    const paths = fixture();
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "stack.render" as const,
      revisionId,
    };
    const crashing = createUnavailableRuntime();
    installTrustedConfigurationRuntime(crashing, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
      afterCommit: async () => {
        throw new Error("simulated crash");
      },
    });
    await expect(
      dispatchOpsOperation(crashing, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({ outcome: "committed", followUp: "failed" });
    const retry = createUnavailableRuntime();
    installTrustedConfigurationRuntime(retry, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
    });
    await expect(
      dispatchOpsOperation(retry, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({
      outcome: "not_committed",
      reason: "conflict",
      currentRevisionId: revisionId,
    });
  });

  it("applies an explicit empty vault entry and removes the prior generated secret", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
    });
    const firstRevision = `cfg1_${"s".repeat(43)}`;
    const first = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "vault.apply" as const,
      serviceId: "alpha",
      revisionId: firstRevision,
    };
    await dispatchOpsOperation(runtime, first, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: claim(
        first,
        payload({
          integrationConfigs: [],
          serviceSecrets: [{ serviceId: "alpha", values: { PRIVATE_SETTING: "fixture" } }],
        }),
      ),
    });
    expect(existsSync(join(paths.current, ".generated-secrets", "alpha", "PRIVATE_SETTING"))).toBe(
      true,
    );

    const secondRevision = `cfg1_${"t".repeat(43)}`;
    const second = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "vault.apply" as const,
      serviceId: "alpha",
      revisionId: secondRevision,
    };
    await dispatchOpsOperation(runtime, second, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: claim(
        second,
        payload({
          integrationConfigs: [],
          serviceSecrets: [{ serviceId: "alpha", values: {} }],
        }),
      ),
    });
    expect(existsSync(join(paths.current, ".generated-secrets"))).toBe(false);
  });

  it("prunes validated inactive generations so legitimate revisions cannot brick apply", async () => {
    const paths = fixture();
    const generations = paths.generations;
    mkdirSync(generations, { recursive: true, mode: 0o700 });
    chmodSync(generations, 0o700);
    for (let index = 0; index < 17; index += 1) {
      const revision = `cfg1_${index.toString().padStart(43, "a")}`;
      const directory = join(generations, revision);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(join(directory, "service-selection.json"), "{}", { mode: 0o600 });
    }
    await initializeTrustedConfigurationRuntime(paths.infraDir);
    expect(readdirSync(generations)).toHaveLength(15);
  });

  it("renders the operator's selection for every apply that does not change it", async () => {
    const paths = fixture();
    select(paths.infraDir, ["beta"]);
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha"), service("beta")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
      env: {},
    });
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "serviceConfig.apply" as const,
      serviceId: "alpha",
      revisionId: `cfg1_${"c".repeat(43)}`,
    };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({
      outcome: "committed",
      revisionId: operation.revisionId,
      enabledServiceIds: ["beta"],
    });
    const compose = readFileSync(paths.compose, "utf8");
    expect(compose).toContain("beta:");
    expect(compose).not.toContain("alpha:");
    // What was saved for alpha travels with the generation for when it is enabled.
    expect(readFileSync(join(paths.current, "resolved-config.generated.json"), "utf8")).toContain(
      '"serviceId":"alpha"',
    );
  });

  it("leaves the selection to the operator's override while it is set", async () => {
    const paths = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha"), service("beta")],
      integrationSchemas: new Map(),
      infraDir: paths.infraDir,
      env: { OPENMAPX_ENABLED_SERVICES: "alpha" },
    });
    const operation = {
      expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
      kind: "serviceSelection.apply" as const,
      revisionId: `cfg1_${"e".repeat(43)}`,
    };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation, payload({ selectedRoots: ["beta"], integrationConfigs: [] })),
      }),
    ).resolves.toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(readFileSync(services.serviceSelectionPath(paths.infraDir), "utf8")).toContain("alpha");
    expect(existsSync(paths.current)).toBe(false);
    await expect(
      dispatchOpsOperation(
        runtime,
        { kind: "serviceSelection.inspect" },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: {
            fingerprint: "f".repeat(64),
            operation: { kind: "serviceSelection.inspect" },
            source: "registry",
            capability: { revisionId: "registry-v1", values: {} },
          },
        },
      ),
    ).resolves.toEqual({ source: "env", roots: ["alpha"] });
  });

  describe("configuration.hardlinks.inspect", () => {
    const revisionId = `cfg1_${"l".repeat(43)}`;
    const plan = [
      {
        source: "data/osm",
        target: "data/valhalla/osm-pbf",
        consumerService: "valhalla",
        dataType: "osm-pbf",
      },
    ];

    function applied(paths: ReturnType<typeof fixture>): void {
      const generation = join(paths.generations, revisionId);
      mkdirSync(generation, { recursive: true, mode: 0o700 });
      chmodSync(paths.generations, 0o700);
      writeFileSync(join(generation, "docker-compose.generated.yml"), "services: {}\n", {
        mode: 0o600,
      });
      writeFileSync(join(generation, "service-selection.json"), '{"selected":[]}', {
        mode: 0o600,
      });
      writeFileSync(
        join(generation, "docker-compose.generated.hardlinks.json"),
        JSON.stringify(plan),
        { mode: 0o600 },
      );
      pointCurrentAt(paths, revisionId);
    }

    const inspect = (paths: ReturnType<typeof fixture>, inspectRevision: string) => {
      const runtime = createUnavailableRuntime();
      installTrustedConfigurationRuntime(runtime, {
        services: [service("alpha")],
        integrationSchemas: new Map(),
        infraDir: paths.infraDir,
      });
      const operation = {
        kind: "configuration.hardlinks.inspect" as const,
        revisionId: inspectRevision,
      };
      return dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: {
          fingerprint: opsOperationFingerprint(operation),
          operation,
          source: "registry",
          capability: { revisionId: inspectRevision, values: {} },
        },
      });
    };

    it("returns the applied generation's plan for data-manager to apply", async () => {
      const paths = fixture();
      applied(paths);
      await expect(inspect(paths, revisionId)).resolves.toEqual({ revisionId, plan });
    });

    it("refuses when another generation has been applied since", async () => {
      const paths = fixture();
      applied(paths);
      await expect(inspect(paths, `cfg1_${"x".repeat(43)}`)).rejects.toThrow(
        "Another configuration was applied before its hardlinks",
      );
    });
  });

  it("does not commit with an override it may not use, and says why for the admin panel", async () => {
    const paths = fixture();
    // A built-in that mounts a file of the release.
    const directory = join(paths.root, "services", "alpha");
    mkdirSync(join(directory, "config"), { recursive: true });
    writeFileSync(join(directory, "config", "alpha.yml"), "release: true\n");
    const alpha: services.LoadedService = {
      ...service("alpha"),
      manifest: {
        ...service("alpha").manifest,
        bindMounts: [{ source: "config/alpha.yml", target: "/etc/alpha.yml" }],
      },
      directory,
    };
    const override = join(paths.infraDir, "overrides", "services", "alpha", "config", "alpha.yml");
    mkdirSync(dirname(override), { recursive: true, mode: 0o755 });
    writeFileSync(override, "users: ['op:$2y$05$secret-hash']\n");
    chmodSync(override, 0o664);
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [alpha],
      integrationSchemas: new Map([["routing", { enabled: { type: "boolean" } }]]),
      infraDir: paths.infraDir,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const apply = (revisionId: string) => {
      const operation = {
        expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
        kind: "stack.render" as const,
        revisionId,
      };
      return dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation),
      });
    };
    const failure = (attemptedRevisionId: string) => {
      const operation = { kind: "configuration.failure.inspect" as const, attemptedRevisionId };
      return dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: {
          fingerprint: opsOperationFingerprint(operation),
          operation,
          source: "registry",
          capability: { revisionId: attemptedRevisionId, values: {} },
        },
      });
    };
    try {
      const refused = `cfg1_${"r".repeat(43)}`;
      await expect(apply(refused)).resolves.toMatchObject({
        outcome: "not_committed",
        reason: "failed",
      });
      const problem =
        "infra/docker/overrides/services/alpha/config/alpha.yml can't be used: group or others may write it. Render refuses it rather than use the release's file in its place: make it a regular file of yours that only you may write, or delete it.";
      await expect(failure(refused)).resolves.toEqual({ attemptedRevisionId: refused, problem });
      expect(stderr.mock.calls.flat().map(String)).toContainEqual(`${problem}\n`);
      expect(stderr.mock.calls.flat().join("")).not.toContain("secret-hash");
      expect(services.currentConfigurationGeneration(paths.infraDir)).toBeNull();

      chmodSync(override, 0o644);
      stderr.mockClear();
      const applied = `cfg1_${"a".repeat(43)}`;
      await expect(apply(applied)).resolves.toMatchObject({ outcome: "committed" });
      await expect(failure(applied)).resolves.toEqual({
        attemptedRevisionId: applied,
        problem: null,
      });
      // The override in use is information in the agent's log: no ⚠.
      expect(stderr.mock.calls.flat().map(String)).toContainEqual(
        "Service file overrides in use, in place of the release's files (infra/docker/overrides/services): alpha/config/alpha.yml.\n",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it("never changes .env, and refuses a commit without UID or GID, naming the host render", async () => {
    const paths = fixture();
    const env = join(paths.infraDir, ".env");
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: [service("alpha")],
      integrationSchemas: new Map([["routing", { enabled: { type: "boolean" } }]]),
      infraDir: paths.infraDir,
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const apply = (revisionId: string) => {
      const operation = {
        expectedCurrentRevisionId: services.currentConfigurationGeneration(paths.infraDir),
        kind: "stack.render" as const,
        revisionId,
      };
      return dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(operation),
      });
    };
    const failure = (attemptedRevisionId: string) => {
      const operation = { kind: "configuration.failure.inspect" as const, attemptedRevisionId };
      return dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: {
          fingerprint: opsOperationFingerprint(operation),
          operation,
          source: "registry",
          capability: { revisionId: attemptedRevisionId, values: {} },
        },
      });
    };
    // An old mtime, so a write in the same instant would still show.
    const written = (contents: string) => {
      writeFileSync(env, contents, { mode: 0o600 });
      utimesSync(env, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
      return envFileState(env);
    };
    try {
      const present = written(`DOMAIN=maps.example.test\n${deploymentUserEnv}`);
      const committed = `cfg1_${"a".repeat(43)}`;
      await expect(apply(committed)).resolves.toMatchObject({ outcome: "committed" });
      expect(envFileState(env)).toEqual(present);

      for (const [contents, missing] of [
        ["DOMAIN=maps.example.test\n# UID=1000\n", "UID or GID"],
        [`DOMAIN=maps.example.test\nUID=${process.geteuid?.() ?? 0}\n`, "GID"],
      ] as const) {
        const before = written(contents);
        const refused = `cfg1_${(missing === "GID" ? "g" : "r").repeat(43)}`;
        await expect(apply(refused)).resolves.toMatchObject({
          outcome: "not_committed",
          reason: "failed",
        });
        const problem = `infra/docker/.env sets no ${missing}, and the operations agent does not write .env: run \`pnpm openmapx compose render\` on the host, as the checkout's owner, which writes UID and GID from that owner.`;
        await expect(failure(refused)).resolves.toEqual({ attemptedRevisionId: refused, problem });
        expect(stderr.mock.calls.flat().map(String)).toContainEqual(`${problem}\n`);
        expect(envFileState(env)).toEqual(before);
        expect(services.currentConfigurationGeneration(paths.infraDir)).toBe(committed);
      }

      // Nor is a missing one created.
      rmSync(env);
      const absent = `cfg1_${"m".repeat(43)}`;
      await expect(apply(absent)).resolves.toMatchObject({ outcome: "not_committed" });
      expect(existsSync(env)).toBe(false);
    } finally {
      stderr.mockRestore();
    }
  });
});

/**
 * What a write to `.env` would change: its bytes, its inode, its mtime and its
 * mode, read through one descriptor rather than a second lookup by path.
 */
function envFileState(path: string) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor, { bigint: true });
    return {
      bytes: readFileSync(descriptor, "utf8"),
      ino: stats.ino,
      mtimeNs: stats.mtimeNs,
      mode: stats.mode,
    };
  } finally {
    closeSync(descriptor);
  }
}
