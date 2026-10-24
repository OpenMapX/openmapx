import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { OpsClient } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDurableOpsKey,
  executeTrustedConfigurationAndWait,
} from "../apps/api/src/services/ops-client";
import {
  consumePublishedTrustedConfiguration,
  publishTrustedConfigurationSnapshot,
} from "../apps/api/src/services/trusted-config-publisher";
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
});

const secret = () => randomBytes(24).toString("base64url");

/** What an operator gets from `git clone` under a umask of 002, configured. */
async function umask002Checkout(): Promise<string> {
  const parent = mkdtempSync(join(tmpdir(), "openmapx-umask-002-"));
  roots.push(parent);
  const checkout = join(parent, "checkout");
  await runUnderUmask002("git", ["clone", "-q", ROOT, checkout]);
  writeFileSync(
    join(checkout, "infra", "docker", ".env"),
    [
      `POSTGRES_PASSWORD=${secret()}`,
      `BETTER_AUTH_SECRET=${secret()}`,
      `DATA_MANAGER_AUTH_TOKEN=${secret()}`,
      `OPENMAPX_HOST_DIR=${checkout}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
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

describe("a checkout written under umask 002", () => {
  it("gets the bundled agent through startup and a trusted-configuration request", async () => {
    const checkout = await umask002Checkout();
    for (const path of [
      checkout,
      join(checkout, "services"),
      join(checkout, "services", "valhalla", "service.json"),
      join(checkout, "integrations"),
      join(checkout, "integrations", "air-quality", "manifest.json"),
    ]) {
      expect(statSync(path).mode & 0o020, path).toBe(0o020);
    }
    const rendered = await cli(checkout, "compose", "render");
    expect(rendered.stdout, rendered.stderr).toContain("Rendered");

    const infra = join(checkout, "infra", "docker");
    const trustedConfig = join(infra, "state", "ops-agent", "trusted-config");
    const port = await freePort();
    const agent = spawn(process.execPath, [join(outdir, "agent.mjs")], {
      cwd: checkout,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENMAPX_ROOT_DIR: checkout,
        OPS_AGENT_API_TOKEN_FILE: join(infra, "secrets", "ops-agent-api-token"),
        OPS_AGENT_DATA_MANAGER_TOKEN_FILE: join(infra, "secrets", "ops-agent-data-manager-token"),
        OPS_TRUSTED_CONFIG_DIR: trustedConfig,
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

    const tokenFile = join(infra, "secrets", "ops-agent-api-token");
    const token = readFileSync(tokenFile, "utf8").trim();
    const directory = statSync(trustedConfig);
    const operationKey = createDurableOpsKey("stack.render", "umask-002-checkout");
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
      }),
      payload: {
        domain: "umask.example.test",
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
    });
    const client = new OpsClient({ baseUrl: `http://127.0.0.1:${port}`, tokenFile });
    const consumed = await consumePublishedTrustedConfiguration(sealed, () =>
      executeTrustedConfigurationAndWait(
        client,
        sealed.operation as Parameters<typeof executeTrustedConfigurationAndWait>[1],
        operationKey,
      ),
    );
    expect(consumed.submission.status, output).toBe("fulfilled");
    const result =
      consumed.submission.status === "fulfilled" ? consumed.submission.value : undefined;
    expect(result, `${JSON.stringify(result)}\n${output}`).toMatchObject({ outcome: "committed" });
    expect(services.currentConfigurationGeneration(infra)).not.toBe(before);
    expect(
      readFileSync(join(infra, ".trusted-config-current", "docker-compose.generated.yml"), "utf8"),
    ).toContain("umask.example.test");
    agent.kill("SIGTERM");
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
  const community = join(checkout, "services", ".community");
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
      join(checkout, "infra", "docker", ".trusted-config-current", "docker-compose.generated.yml"),
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
    expect(message).toContain(`Delete services/.community/${REPOSITORY}`);
    expect(message).not.toMatch(/\n\s+at /);
  }, 120_000);
});
