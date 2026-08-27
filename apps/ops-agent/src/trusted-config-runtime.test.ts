import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpsOperation, TrustedConfigurationPayload } from "@openmapx/core/ops";
import type { services } from "@openmapx/core/server";
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
    selectedRoots: ["alpha"],
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
    fingerprint: "f".repeat(64),
    operation,
    source: "trusted-data",
    capability: { revisionId, values, trustedConfiguration: value },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-trusted-runtime-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const current = join(infraDir, ".trusted-config-current");
  return {
    root,
    infraDir,
    current,
    compose: join(current, "docker-compose.generated.yml"),
    selection: join(current, "service-selection.json"),
    hardlinks: join(current, "docker-compose.generated.hardlinks.json"),
  };
}

async function installSentinelGeneration(paths: ReturnType<typeof fixture>): Promise<void> {
  const oldRevision = `cfg1_${"o".repeat(43)}`;
  const oldGeneration = join(paths.infraDir, ".trusted-config-generations", oldRevision);
  mkdirSync(oldGeneration, { recursive: true, mode: 0o700 });
  chmodSync(join(paths.infraDir, ".trusted-config-generations"), 0o700);
  chmodSync(oldGeneration, 0o700);
  for (const name of [
    "docker-compose.generated.yml",
    "service-selection.json",
    "docker-compose.generated.hardlinks.json",
  ])
    writeFileSync(join(oldGeneration, name), "sentinel", { mode: 0o600 });
  const { symlinkSync } = await import("node:fs");
  symlinkSync(join(".trusted-config-generations", oldRevision), paths.current);
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
    const operation = { kind: "serviceSelection.apply" as const, revisionId };
    const trusted = claim(
      operation,
      payload({
        serviceSecrets: [{ serviceId: "alpha", values: { PRIVATE_SETTING: secretValue } }],
      }),
    );
    const result = await dispatchOpsOperation(runtime, operation, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: trusted,
    });
    expect(result).toEqual({ revisionId });
    expect(JSON.parse(readFileSync(paths.selection, "utf8"))).toEqual({ selected: ["alpha"] });
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
    expect(readFileSync(paths.compose, "utf8")).not.toContain(secretValue);
    expect(JSON.parse(readFileSync(paths.hardlinks, "utf8"))).toEqual([]);
    expect(
      readFileSync(join(paths.current, ".generated-secrets", "alpha", "PRIVATE_SETTING"), "utf8"),
    ).toBe(secretValue);
    await expect(initializeTrustedConfigurationRuntime(paths.infraDir)).resolves.toBeUndefined();
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
      "undeclared secret file",
      payload({ serviceSecrets: [{ serviceId: "alpha", values: { UNKNOWN_SECRET: "blocked" } }] }),
    ],
    [
      "disabled service secret",
      payload({
        serviceSecrets: [{ serviceId: "beta", values: { PRIVATE_SETTING: "blocked" } }],
      }),
    ],
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
        { kind: "stack.render", revisionId },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: claim({ kind: "stack.render", revisionId }, invalidPayload),
        },
      ),
    ).rejects.toThrow("Trusted configuration apply failed");
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
    const operation = { kind: "stack.render" as const, revisionId };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          operation,
          payload({
            selectedRoots: ["app-api"],
            serviceConfigs: [
              { serviceId: "app-api", values: { DOCKER_CONFIG: "/attacker/control" } },
            ],
            integrationConfigs: [],
          }),
        ),
      }),
    ).rejects.toThrow("Trusted configuration apply failed");
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
    const operation = { kind: "stack.render" as const, revisionId };
    await dispatchOpsOperation(runtime, operation, {
      signal: new AbortController().signal,
      emitLog: vi.fn(),
      claim: claim(
        operation,
        payload({
          selectedRoots: ["app-api", "alpha"],
          serviceConfigs: [{ serviceId: "alpha", values: {} }],
          integrationConfigs: [{ integrationId: "routing-demo", values: {} }],
        }),
      ),
    });
    const compose = readFileSync(paths.compose, "utf8");
    expect(compose).toContain("OPENMAPX_ENABLED_SERVICES: app-api,alpha");
    expect(compose).toContain("SERVICE_ALPHA_PUBLIC_SETTING: ${SERVICE_ALPHA_PUBLIC_SETTING:-}");
    expect(compose).toContain(
      "INTEGRATION_ROUTING_DEMO_REGION: ${INTEGRATION_ROUTING_DEMO_REGION:-}",
    );
    expect(compose).not.toContain("DOCKER_CONFIG: ${DOCKER_CONFIG:-}");
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
    ).rejects.toThrow("Trusted configuration apply failed");
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
      kind: "serviceConfig.apply" as const,
      serviceId: "dawarich-app",
      revisionId,
    };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        signal: new AbortController().signal,
        emitLog: vi.fn(),
        claim: claim(
          operation,
          payload({
            selectedRoots: ["dawarich-app"],
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
    ).rejects.toThrow("Trusted configuration apply failed");
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
    ).rejects.toThrow("Trusted configuration apply failed");
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
    const selection = { kind: "serviceSelection.apply" as const, revisionId: selectionRevision };
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
    ).resolves.toEqual({ revisionId: selectionRevision });
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
            selectedRoots: ["community-live"],
            serviceConfigs: [{ serviceId: "community-live", values: {} }],
            integrationConfigs: [{ integrationId: "integration-live", values: { region: "eu" } }],
          }),
          { authorityRevision: authority.revisionId },
        ),
      }),
    ).rejects.toThrow("Trusted configuration apply failed");

    authority = {
      revisionId: "authority-removed",
      services: [service("alpha")],
      integrationSchemas: new Map(),
    };
    const removedRevision = `cfg1_${"k".repeat(43)}`;
    const removed = { kind: "serviceSelection.apply" as const, revisionId: removedRevision };
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
    ).rejects.toThrow("Trusted configuration apply failed");
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
        { kind: "stack.render", revisionId },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: claim({ kind: "stack.render", revisionId }, payload({ integrationConfigs: [] })),
        },
      ),
    ).rejects.toThrow("Trusted configuration apply failed");
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
        { kind: "stack.render", revisionId },
        {
          signal: new AbortController().signal,
          emitLog: vi.fn(),
          claim: claim({ kind: "stack.render", revisionId }, payload({ integrationConfigs: [] })),
        },
      ),
    ).rejects.toThrow("Trusted configuration apply failed");
    await initializeTrustedConfigurationRuntime(paths.infraDir);
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
    expect(readFileSync(paths.selection, "utf8")).toContain("alpha");
  });

  it("resumes an identical orphan generation after a crash before the pointer swap", async () => {
    const paths = fixture();
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = { kind: "stack.render" as const, revisionId };
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
    ).rejects.toThrow("Trusted configuration apply failed");
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
    ).resolves.toEqual({ revisionId });
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
  });

  it("rejects a dangling trusted-current pointer instead of authorizing baked selection", async () => {
    const paths = fixture();
    symlinkSync(join(".trusted-config-generations", `cfg1_${"d".repeat(43)}`), paths.current);

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
    const operation = { kind: "stack.render" as const, revisionId };
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
    ).resolves.toEqual({ revisionId });
    expect(readFileSync(paths.compose, "utf8")).toContain("alpha:");
  });

  it("makes a post-pointer crash idempotently retryable", async () => {
    const paths = fixture();
    const revisionId = "cfg1_0123456789abcdef0123456789abcdef0123456789a";
    const operation = { kind: "stack.render" as const, revisionId };
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
    ).rejects.toThrow();
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
    ).resolves.toEqual({ revisionId });
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
    const first = { kind: "vault.apply" as const, serviceId: "alpha", revisionId: firstRevision };
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
    const second = { kind: "vault.apply" as const, serviceId: "alpha", revisionId: secondRevision };
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
    const generations = join(paths.infraDir, ".trusted-config-generations");
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
});
