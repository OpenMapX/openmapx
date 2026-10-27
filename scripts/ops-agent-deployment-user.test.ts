import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

/**
 * The deployment's user on a host whose operator is not uid 1000, from an
 * .env an earlier release left without UID or GID, through to a committed
 * trusted-configuration request: in the host update's order (the host's
 * render, then the agent) and in the panel self-update's (the new agent
 * first). Only the host's render writes UID and GID; the agent and its fixed
 * CLI read .env and never change it. app-api publishes as the UID and GID
 * Compose gives it from .env.
 *
 * Runs only on Linux where `OPENMAPX_TEST_DEPLOYMENT_USER` names the uid the
 * test runs as, which must not be 1000 and must own the repository, e.g. in a
 * container as a user created with `useradd -u 1001`.
 */
const EXPECTED_UID = Number(process.env.OPENMAPX_TEST_DEPLOYMENT_USER ?? "");
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const agents: ChildProcess[] = [];
let outdir = "";

describe.skipIf(process.platform !== "linux" || !EXPECTED_UID)(
  "the deployment's user on a host whose operator is not uid 1000",
  () => {
    beforeAll(async () => {
      expect(process.geteuid?.()).toBe(EXPECTED_UID);
      expect(EXPECTED_UID).not.toBe(1000);
      mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
      outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "deployment-user-"));
      writeRuntimeBundle(
        await buildRuntimeBundle(ROOT, "ops-agent", {
          ...RUNTIME_BUNDLES["ops-agent"],
          outdir: relative(ROOT, outdir),
        }),
      );
    }, 120_000);

    afterAll(() => {
      for (const agent of agents.splice(0)) agent.kill("SIGKILL");
      if (outdir) rmSync(outdir, { recursive: true, force: true });
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    const secret = () => randomBytes(24).toString("base64url");

    /** A checkout cloned under umask 002, with an .env that sets no UID or GID. */
    async function checkout(): Promise<string> {
      const clone = mkdtempSync(join(tmpdir(), "openmapx-deployment-user-"));
      roots.push(clone);
      const target = join(clone, "checkout");
      const previous = process.umask(0o002);
      try {
        await run("git", ["clone", "-q", "--no-local", ROOT, target]);
      } finally {
        process.umask(previous);
      }
      expect(statSync(target).uid).toBe(EXPECTED_UID);
      writeFileSync(join(target, "infra", "docker", ".env"), envWithoutUser(target), {
        mode: 0o600,
      });
      return target;
    }

    function envWithoutUser(target: string): string {
      return `# UID=1000\n# GID=1000\nPOSTGRES_PASSWORD=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nDATA_MANAGER_AUTH_TOKEN=${secret()}\nOPENMAPX_HOST_DIR=${target}\n`;
    }

    /** UID and GID as Compose reads them from .env. */
    function deploymentUser(target: string): { uid: number; gid: number } {
      const env = readFileSync(join(target, "infra", "docker", ".env"), "utf8");
      const uid = /^UID=(\d+)$/m.exec(env)?.[1];
      const gid = /^GID=(\d+)$/m.exec(env)?.[1];
      expect(uid, env).toBeDefined();
      expect(gid, env).toBeDefined();
      return { uid: Number(uid), gid: Number(gid) };
    }

    /** `pnpm openmapx` on the host: the CLI from source. */
    async function hostCli(target: string, ...args: string[]) {
      const cli = join(ROOT, "packages", "cli");
      return run(
        join(cli, "node_modules", ".bin", "tsx"),
        ["--tsconfig", join(cli, "tsconfig.json"), join(cli, "src", "index.ts"), ...args],
        {
          cwd: target,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: target },
        },
      );
    }

    /** The fixed CLI the agent runs, from its bundle. */
    async function agentCli(target: string, ...args: string[]) {
      return run(process.execPath, [join(outdir, "cli.mjs"), ...args], {
        cwd: target,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: target },
      });
    }

    /** What a write to .env would change, after giving it an old mtime. */
    function envFileState(target: string, age = false) {
      const env = join(target, "infra", "docker", ".env");
      if (age) utimesSync(env, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
      // Read through one descriptor rather than a second lookup by path.
      const descriptor = openSync(env, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stats = fstatSync(descriptor, { bigint: true });
        return {
          bytes: readFileSync(descriptor, "utf8"),
          ino: stats.ino,
          mtimeNs: stats.mtimeNs,
        };
      } finally {
        closeSync(descriptor);
      }
    }

    const HOST_RENDER_NEEDED =
      "infra/docker/.env sets no UID or GID, and the operations agent does not write .env: run `pnpm openmapx compose render` on the host";

    async function freePort(): Promise<number> {
      return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          server.close(() =>
            typeof address === "object" && address
              ? resolvePort(address.port)
              : reject(new Error()),
          );
        });
      });
    }

    async function startAgent(target: string) {
      const infra = join(target, "infra", "docker");
      const port = await freePort();
      const agent = spawn(process.execPath, [join(outdir, "agent.mjs")], {
        cwd: target,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          OPENMAPX_ROOT_DIR: target,
          OPS_AGENT_API_TOKEN_FILE: join(infra, "secrets", "ops-agent-api-token"),
          OPS_AGENT_DATA_MANAGER_TOKEN_FILE: join(infra, "secrets", "ops-agent-data-manager-token"),
          OPS_TRUSTED_CONFIG_DIR: services.agentStatePaths(infra).trustedConfig,
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
        await new Promise((done) => setTimeout(done, 100));
      }
      return { port, output: () => output };
    }

    /** A request app-api publishes as the UID and GID Compose passes it. */
    async function submit(
      target: string,
      agent: { port: number; output: () => string },
      name: string,
      user: { uid: number; gid: number },
    ) {
      const infra = join(target, "infra", "docker");
      const tokenFile = join(infra, "secrets", "ops-agent-api-token");
      const operationKey = createDurableOpsKey("stack.render", name);
      const before = services.currentConfigurationGeneration(infra);
      const sealed = await publishTrustedConfigurationSnapshot({
        directory: services.agentStatePaths(infra).trustedConfig,
        token: readFileSync(tokenFile, "utf8").trim(),
        ownerUid: user.uid,
        ownerGid: user.gid,
        operationKey,
        operationForRevision: (revisionId) => ({
          kind: "stack.render",
          revisionId,
          expectedCurrentRevisionId: before,
        }),
        payload: {
          domain: `${name}.example.test`,
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
      });
      const client = new OpsClient({ baseUrl: `http://127.0.0.1:${agent.port}`, tokenFile });
      const consumed = await consumePublishedTrustedConfiguration(sealed, () =>
        executeTrustedConfigurationAndWait(
          client,
          sealed.operation as Parameters<typeof executeTrustedConfigurationAndWait>[1],
          operationKey,
        ),
      );
      expect(consumed.submission.status, agent.output()).toBe("fulfilled");
      return consumed.submission.status === "fulfilled" ? consumed.submission.value : undefined;
    }

    async function expectCommitted(
      target: string,
      agent: { port: number; output: () => string },
      name: string,
    ) {
      const infra = join(target, "infra", "docker");
      const before = services.currentConfigurationGeneration(infra);
      const result = await submit(target, agent, name, deploymentUser(target));
      expect(result, `${JSON.stringify(result)}\n${agent.output()}`).toMatchObject({
        outcome: "committed",
      });
      expect(services.currentConfigurationGeneration(infra)).not.toBe(before);
    }

    function expectDeploymentUser(target: string) {
      const infra = join(target, "infra", "docker");
      expect(deploymentUser(target)).toEqual({ uid: EXPECTED_UID, gid: statSync(target).gid });
      expect(statSync(join(infra, ".env")).mode & 0o777).toBe(0o600);
      // Every stack container that runs as the deployment's user, app-api now
      // too, takes it from .env, with no fallback.
      const compose = readFileSync(
        join(infra, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
        "utf8",
      );
      expect(compose).not.toContain("1000");
      expect(compose).toMatch(/\$\{UID:\?/);
    }

    it("is written by the host's render, before the agent starts, which only reads it", async () => {
      const target = await checkout();
      const rendered = await hostCli(target, "compose", "render");
      expect(rendered.stdout).toContain(
        `Set the deployment's user in infra/docker/.env from the checkout's owner: UID=${EXPECTED_UID}`,
      );
      expectDeploymentUser(target);
      const written = envFileState(target, true);
      const agent = await startAgent(target);
      expect(agent.output()).not.toContain("sets no UID");
      await expectCommitted(target, agent, "host-update");
      // The agent's fixed CLI renders with it too, and leaves .env as it was.
      await agentCli(target, "compose", "render");
      expect(envFileState(target)).toEqual(written);
    }, 180_000);

    it("is never written by the new agent after a panel self-update: it refuses until the host's render", async () => {
      const target = await checkout();
      // The generation an earlier release rendered, and its .env without UID/GID.
      await hostCli(target, "compose", "render");
      writeFileSync(join(target, "infra", "docker", ".env"), envWithoutUser(target), {
        mode: 0o600,
      });
      const unset = envFileState(target, true);
      const infra = join(target, "infra", "docker");
      const before = services.currentConfigurationGeneration(infra);
      // The helper recreates the agent; it starts before anything renders, and
      // stays up to say what is missing.
      const agent = await startAgent(target);
      expect(agent.output()).toContain(HOST_RENDER_NEEDED);
      expect(envFileState(target)).toEqual(unset);
      // The admin panel's apply and the agent's fixed CLI render both refuse.
      const refused = await submit(target, agent, "self-update", {
        uid: EXPECTED_UID,
        gid: statSync(target).gid,
      });
      expect(refused, agent.output()).toMatchObject({ outcome: "not_committed" });
      await expect(agentCli(target, "compose", "render")).rejects.toThrow(HOST_RENDER_NEEDED);
      expect(envFileState(target)).toEqual(unset);
      expect(services.currentConfigurationGeneration(infra)).toBe(before);
      // The host's render writes them; the running agent then commits.
      await hostCli(target, "compose", "render");
      expectDeploymentUser(target);
      await expectCommitted(target, agent, "after-host-render");
    }, 180_000);
  },
);
