import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import {
  createControlRootOperationKey,
  OpsClient,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
  opsExecutionBudget,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitForOpsResult } from "../apps/api/src/services/ops-client";
import {
  consumePublishedTrustedConfiguration,
  publishTrustedConfigurationSnapshot,
} from "../apps/api/src/services/trusted-config-publisher";
import { extractIntegrationArchive } from "../packages/integration-framework/src/installer";
import {
  buildRuntimeBundle,
  RUNTIME_BUNDLES,
  writeRuntimeBundle,
} from "./build-runtime-bundles.mjs";

const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const REPOSITORY = "0123456789abcdef";
const roots: string[] = [];
const agents: ChildProcess[] = [];
let outdir = "";

beforeAll(async () => {
  // A private output directory inside the repository, so the bundle's pinned
  // dependency paths resolve exactly as they do from apps/ops-agent/dist.
  mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
  outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "checkout-trust-"));
  const bundle = await buildRuntimeBundle(ROOT, "ops-agent", {
    ...RUNTIME_BUNDLES["ops-agent"],
    outdir: relative(ROOT, outdir),
  });
  writeRuntimeBundle(bundle);
}, 120_000);

afterAll(() => {
  for (const agent of agents.splice(0)) agent.kill("SIGKILL");
  if (outdir) rmSync(outdir, { recursive: true, force: true });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}, 120_000);

const secret = () => randomBytes(24).toString("base64url");

/** What an operator gets from `git clone` under a umask of 002, configured. */
async function umask002Checkout(): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "openmapx-umask-002-"));
  roots.push(parent);
  const checkout = join(parent, "checkout");
  await runUnderUmask002("git", ["clone", "-q", ROOT, checkout]);
  // The deployment's user, which a host render writes from the checkout's
  // owner; the bundled CLI is the agent's and only reads it.
  const owner = statSync(checkout);
  writeFileSync(
    join(checkout, "infra", "docker", ".env"),
    [
      `UID=${owner.uid}`,
      `GID=${owner.gid}`,
      `POSTGRES_PASSWORD=${secret()}`,
      `BETTER_AUTH_SECRET=${secret()}`,
      `DATA_MANAGER_AUTH_TOKEN=${secret()}`,
      `OPENMAPX_HOST_DIR=${checkout}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  // Durable control keys require non-group-writable authority ancestors.
  // This is an explicit operator bootstrap step, not application chmod of a
  // shared checkout. Service/integration source trees retain umask-002 modes.
  const unsafe = await cli(checkout, "compose", "render");
  expect(unsafe.stderr).toContain("Directory authority changed or unsafe");
  for (const directory of [
    checkout,
    join(checkout, "infra"),
    join(checkout, "infra", "docker"),
    join(checkout, "infra", "docker", "secrets"),
  ])
    chmodSync(directory, 0o700);
  return checkout;
}

/**
 * Runs a command with a umask of 002, as a Debian or Ubuntu login shell does,
 * without a shell: a Node process sets the umask and starts the command with
 * its arguments as given.
 */
function runUnderUmask002(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return run(
    process.execPath,
    [
      "-e",
      'process.umask(0o002); const { status } = require("node:child_process").spawnSync(process.argv[1], process.argv.slice(2), { stdio: "inherit" }); process.exit(status ?? 1);',
      command,
      ...args,
    ],
    options,
  );
}

/** The bundled fixed CLI, run the way an operator's shell runs it: under umask 002. */
async function cli(checkout: string, ...args: string[]) {
  return runUnderUmask002(process.execPath, [join(outdir, "cli.mjs"), ...args], {
    cwd: checkout,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: checkout },
  }).catch((error: { stdout: string; stderr: string; code: number }) => error);
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolvePort(address.port) : reject(new Error()),
      );
    });
  });
}

interface RunningAgent {
  port: number;
  output: () => string;
  stop: () => void;
}

/** Starts the bundled agent on a checkout and waits until it reports healthy. */
async function startAgent(checkout: string): Promise<RunningAgent> {
  const infra = join(checkout, "infra", "docker");
  const port = await freePort();
  const agent = spawn(process.execPath, [join(outdir, "agent.mjs")], {
    cwd: checkout,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      OPENMAPX_ROOT_DIR: checkout,
      OPS_AGENT_API_TOKEN_FILE: join(infra, "secrets", "ops-agent-api-token"),
      OPS_AGENT_DATA_MANAGER_TOKEN_FILE: join(infra, "secrets", "ops-agent-data-manager-token"),
      OPS_TRUSTED_CONFIG_DIR: join(infra, "state", "ops-agent", "trusted-config"),
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agents.push(agent);
  let output = "";
  agent.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  agent.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (agent.exitCode !== null) throw new Error(`The agent exited: ${output}`);
    const healthy = await fetch(`http://127.0.0.1:${port}/health`)
      .then((response) => response.ok)
      .catch(() => false);
    if (healthy) break;
    if (Date.now() > deadline) throw new Error(`The agent never became healthy: ${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return { port, output: () => output, stop: () => agent.kill("SIGTERM") };
}

/** The fixed local CLI's truthful bearer-root identity; no API job is invented. */
function localRootIdentity(kind: OpsOperationKind) {
  const requestedDeadlineAt = Date.now() + opsExecutionBudget(kind).processMs;
  return {
    operationKey: createControlRootOperationKey({
      notAfter: requestedDeadlineAt,
      nonce: randomBytes(16),
    }),
    execution: { requestedDeadlineAt },
  };
}

async function executeLocalRoot<K extends OpsOperationKind>(
  client: OpsClient,
  operation: Extract<OpsOperation, { kind: K }>,
  identity = localRootIdentity(operation.kind),
): Promise<OpsResultFor<K>> {
  const submitted = await client.execute<K>(operation, identity);
  if (submitted.execution === "sync") return submitted.value;
  return waitForOpsResult<K>(client, operation.kind, submitted, {
    execution: identity.execution,
    observerDeadlineAt: identity.execution.requestedDeadlineAt,
  });
}

/** Publishes the real sealed payload and current source witness over agent HTTP. */
async function expectTrustedConfigurationCommitted(
  checkout: string,
  agent: RunningAgent,
  name: string,
  payload: Partial<Parameters<typeof publishTrustedConfigurationSnapshot>[0]["payload"]>,
): Promise<void> {
  const infra = join(checkout, "infra", "docker");
  const trustedConfig = join(infra, "state", "ops-agent", "trusted-config");
  const tokenFile = join(infra, "secrets", "ops-agent-api-token");
  const token = readFileSync(tokenFile, "utf8").trim();
  const directory = statSync(trustedConfig);
  const client = new OpsClient({ baseUrl: `http://127.0.0.1:${agent.port}`, tokenFile });
  const inspected = await client.execute({ kind: "configuration.sources.inspect" });
  if (inspected.execution !== "sync") throw Error("Expected a synchronous source inspection");
  const identity = localRootIdentity("stack.render");
  const { operationKey } = identity;
  const before = services.currentConfigurationGeneration(infra);
  const sealed = await publishTrustedConfigurationSnapshot({
    directory: trustedConfig,
    token,
    ownerUid: directory.uid,
    ownerGid: directory.gid,
    operationKey,
    operationForRevision: (revisionId) => ({
      kind: "stack.render",
      revisionId,
      expectedCurrentRevisionId: before,
      expectedSourceRevision: inspected.value.sourceRevision,
      coordinatorMode: "require-running",
    }),
    payload: {
      domain: `${name}.example.test`,
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
      ...payload,
    },
  });
  const consumed = await consumePublishedTrustedConfiguration(sealed, () =>
    executeLocalRoot(client, sealed.operation, identity),
  );
  expect(consumed.submission.status, agent.output()).toBe("fulfilled");
  const result = consumed.submission.status === "fulfilled" ? consumed.submission.value : undefined;
  expect(result, `${JSON.stringify(result)}\n${agent.output()}`).toMatchObject({
    outcome: "committed",
  });
  expect(services.currentConfigurationGeneration(infra)).not.toBe(before);
  expect(
    readFileSync(
      join(infra, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      "utf8",
    ),
  ).toContain(`${name}.example.test`);
}

describe("a checkout written under umask 002", () => {
  it("gets the bundled agent through startup and a trusted-configuration request", async () => {
    const checkout = await umask002Checkout();
    for (const path of [
      join(checkout, "services"),
      join(checkout, "services", "valhalla", "service.json"),
      join(checkout, "integrations"),
      join(checkout, "integrations", "air-quality", "manifest.json"),
    ]) {
      expect(statSync(path).mode & 0o020, path).toBe(0o020);
    }
    const infraMode = statSync(join(checkout, "infra", "docker")).mode;
    const rendered = await cli(checkout, "compose", "render");
    expect(rendered.stdout, rendered.stderr).toContain("Rendered");

    const agent = await startAgent(checkout);
    await expectTrustedConfigurationCommitted(checkout, agent, "umask-002-checkout", {});
    agent.stop();
    // The explicitly hardened authority ancestors retain their operator modes;
    // source directories keep their original umask-002 permissions.
    expect(statSync(join(checkout, "infra", "docker")).mode).toBe(infraMode);
  }, 120_000);
});

/** A one-entry-per-file ustar archive; `mode` and links as an archive may declare them. */
function tarGz(
  entries: Array<{
    name: string;
    data?: string;
    mode?: number;
    type?: "0" | "1" | "2";
    link?: string;
  }>,
): Buffer {
  const blocks = entries.flatMap((entry) => {
    const payload = Buffer.from(entry.data ?? "", "utf8");
    const header = Buffer.alloc(512);
    const octal = (offset: number, length: number, value: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    header.write(entry.name, 0, 100, "utf8");
    octal(100, 8, entry.mode ?? 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, payload.length);
    octal(136, 12, 0);
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.link) header.write(entry.link, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    octal(
      148,
      8,
      header.reduce((sum, byte) => sum + byte, 0),
    );
    return [header, payload, Buffer.alloc((512 - (payload.length % 512)) % 512)];
  });
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

describe("integrations installed through the operations agent", () => {
  it("installs, refuses, adopts and authorizes them on a umask-002 checkout", async () => {
    const checkout = await umask002Checkout();
    const infra = join(checkout, "infra", "docker");
    const manifest = (id: string) =>
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        domains: ["map-overlay"],
        quality: "community",
        platform: "1.0",
        configSchema: { type: "object", properties: { region: { enum: ["eu", "us"] } } },
      });
    const artifacts = join(checkout, "..", "artifacts");
    mkdirSync(artifacts);
    /** An archive staged where the host CLI stages one for the agent. */
    const upload = (name: string, entries: Parameters<typeof tarGz>[0]) => {
      const bytes = tarGz(entries);
      writeFileSync(join(artifacts, `${name}.tar.gz`), bytes);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const uploads = services.integrationUploadsDirectory(infra);
      mkdirSync(uploads, { recursive: true, mode: 0o700 });
      writeFileSync(join(uploads, `${sha256}.tar.gz`), bytes, { mode: 0o600 });
      return sha256;
    };

    // The agent's integration store.
    const store = services.agentStatePaths(infra).customIntegrations;
    // Files placed in the store by hand, as an earlier release's installer
    // left them: extracted under umask 002, so group-writable, and no record.
    const legacy = upload("legacy", [
      { name: "manifest.json", data: manifest("legacy"), mode: 0o664 },
      { name: "strings/en.json", data: "{}", mode: 0o664 },
    ]);
    const previous = process.umask(0o002);
    try {
      const work = join(artifacts, "legacy-extract");
      mkdirSync(work);
      mkdirSync(store, { recursive: true });
      renameSync(
        extractIntegrationArchive(
          join(artifacts, "legacy.tar.gz"),
          join(work, "x"),
          join(work, "y"),
        ),
        join(store, "legacy"),
      );
      chmodSync(join(store, "legacy"), 0o775);
    } finally {
      process.umask(previous);
    }
    expect(statSync(join(store, "legacy")).mode & 0o777).toBe(0o775);

    // It does not stop a render or the agent: it is left out and reported.
    const rendered = await cli(checkout, "compose", "render");
    expect(rendered.stdout, rendered.stderr).toContain("Rendered");
    const agent = await startAgent(checkout);
    expect(agent.output()).toContain('Integration "legacy" is not loaded');
    // Run diagnostics runs the fixed CLI's check, which names it too.
    const checked = await cli(checkout, "check", "--no-probe");
    expect(`${checked.stdout}${checked.stderr}`).toContain(
      'Integration "legacy" is not loaded: It was not installed through the operations agent.',
    );

    // The fixed CLI the host CLI runs in the agent's container.
    const agentCli = (...args: string[]) =>
      runUnderUmask002(process.execPath, [join(outdir, "cli.mjs"), ...args], {
        cwd: checkout,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENMAPX_ROOT_DIR: checkout,
          OPS_AGENT_API_TOKEN_FILE: join(infra, "secrets", "ops-agent-api-token"),
          PORT: String(agent.port),
        },
      }).catch((error: { stdout: string; stderr: string; code: number }) => error);
    const looseModes = upload("loose-modes", [
      { name: "manifest.json", data: manifest("loose-modes"), mode: 0o666 },
      { name: "strings/en.json", data: "{}", mode: 0o664 },
    ]);
    const installed = await agentCli("integrations", "install", "--upload", looseModes);
    expect(`${installed.stdout}${installed.stderr}`).toContain(
      "Installed integration loose-modes through the operations agent",
    );
    for (const [name, entries, problem] of [
      [
        "hard-linked",
        [
          { name: "copy.json", data: manifest("hard-linked") },
          { name: "manifest.json", type: "1", link: "copy.json" },
        ],
        "must not be hard-linked",
      ],
      [
        "symlinked",
        [
          { name: "real.json", data: manifest("symlinked") },
          { name: "manifest.json", type: "2", link: "real.json" },
        ],
        "not a symbolic link",
      ],
    ] as const) {
      const refused = await agentCli(
        "integrations",
        "install",
        "--upload",
        upload(name, entries as unknown as Parameters<typeof tarGz>[0]),
      );
      expect("code" in refused && refused.code, name).not.toBe(0);
      expect(`${refused.stdout}${refused.stderr}`, name).toContain(problem);
      expect(existsSync(join(store, name)), name).toBe(false);
    }

    // The earlier install is recorded only after its files match its archive.
    const tokenFile = join(infra, "secrets", "ops-agent-api-token");
    const client = new OpsClient({ baseUrl: `http://127.0.0.1:${agent.port}`, tokenFile });
    const adopted = await executeLocalRoot(client, {
      kind: "catalogIntegration.adopt",
      integrationId: "legacy",
      source: { kind: "upload", sha256: legacy },
    });
    expect(adopted).toEqual({ integrationId: "legacy", status: "recorded", reason: null });

    await expectTrustedConfigurationCommitted(checkout, agent, "installed-integrations", {
      integrationConfigs: [
        { integrationId: "legacy", values: { region: "eu" } },
        { integrationId: "loose-modes", values: { region: "us" } },
      ],
    });
    agent.stop();
  }, 120_000);
});

function communityManifest(id: string, image = `registry.example.test/${id}`): string {
  return JSON.stringify({
    id,
    name: id,
    version: "1.0.0",
    quality: "community",
    container: { image, tag: "1", digest: `sha256:${"a".repeat(64)}` },
  });
}

/**
 * A community repository as the agent installs it, with one manifest the
 * record lists, one it does not, and a second repository without a record.
 */
function installCommunityRepository(checkout: string): string {
  const state = join(checkout, "infra", "docker", "state", "ops-agent");
  // The agent's state directory is its own, as the agent creates it.
  mkdirSync(state, { recursive: true, mode: 0o700 });
  chmodSync(state, 0o700);
  const community = join(state, "community");
  const repository = join(community, REPOSITORY);
  for (const [path, id] of [
    ["recorded", "community-recorded"],
    ["unlisted", "community-unlisted"],
  ] as const) {
    mkdirSync(join(repository, path), { recursive: true });
    writeFileSync(join(repository, path, "service.json"), communityManifest(id));
  }
  mkdirSync(join(community, "fedcba9876543210"), { recursive: true });
  writeFileSync(
    join(community, "fedcba9876543210", "service.json"),
    communityManifest("community-unrecorded"),
  );
  writeFileSync(
    join(community, services.communityRecordFileName(REPOSITORY)),
    JSON.stringify({
      version: services.COMMUNITY_RECORD_VERSION,
      repository: REPOSITORY,
      url: "https://example.test/community.git",
      commit: "c".repeat(40),
      extensionId: "community-extension",
      manifests: [
        {
          path: "recorded",
          sha256: services.manifestSha256(
            readFileSync(join(repository, "recorded", "service.json")),
          ),
        },
      ],
      pending: null,
    }),
    { mode: 0o644 },
  );
  return join(repository, "recorded", "service.json");
}

describe("the ops-agent's fixed CLI", () => {
  it("uses only the community services and integration schemas the agent validates", async () => {
    const checkout = await umask002Checkout();
    const recorded = installCommunityRepository(checkout);
    const integration = join(checkout, "integrations", "air-quality", "manifest.json");
    const manifest = JSON.parse(readFileSync(integration, "utf8")) as {
      configSchema: { properties: Record<string, unknown> };
    };
    manifest.configSchema.properties.tamperedsetting = { type: "string" };
    writeFileSync(integration, JSON.stringify(manifest));

    const listed = await cli(checkout, "services", "list");
    expect(listed.stdout, listed.stderr).toContain("community-recorded");
    expect(listed.stdout).not.toContain("community-unlisted");
    expect(listed.stdout).not.toContain("community-unrecorded");

    const rendered = await cli(checkout, "compose", "render");
    expect(rendered.stdout, rendered.stderr).toContain("Rendered");
    const compose = readFileSync(
      join(
        checkout,
        "infra",
        "docker",
        services.CURRENT_CONFIGURATION,
        "docker-compose.generated.yml",
      ),
      "utf8",
    );
    expect(compose).toContain("INTEGRATION_AIR_QUALITY_ENABLED");
    expect(compose).not.toContain("INTEGRATION_AIR_QUALITY_TAMPEREDSETTING");

    // Changed bytes in a recorded manifest are refused, not run.
    writeFileSync(
      recorded,
      communityManifest("community-recorded", "attacker.example.test/community-recorded"),
    );
    const tampered = await cli(checkout, "services", "list");
    expect(tampered.code).not.toBe(0);
    const message = `${tampered.stdout}${tampered.stderr}`;
    expect(message).not.toContain("attacker.example.test");
    // An operator message with the remedy, not a stack trace.
    expect(message).toContain(
      `Community repository ${REPOSITORY} no longer matches the service manifests the operations agent recorded when it installed it.`,
    );
    expect(message).toContain(`Delete infra/docker/state/ops-agent/community/${REPOSITORY}`);
    expect(message).not.toMatch(/\n\s+at /);
  }, 120_000);
});
