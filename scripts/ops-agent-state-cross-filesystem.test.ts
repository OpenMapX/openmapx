import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
 * The agent's state moving out of a data directory that is a filesystem of
 * its own, as on a host whose `infra/docker/data` is a separate dataset.
 *
 * Runs only where `OPENMAPX_TEST_SEPARATE_DATA_FS` names a directory holding
 * `host-update/infra/docker/data` and `self-update/infra/docker/data`, each a
 * mount of its own (a tmpfs in a Linux container), for example:
 *
 *   docker run --tmpfs /xfs/host-update/infra/docker/data:uid=1000,gid=1000 \
 *     --tmpfs /xfs/self-update/infra/docker/data:uid=1000,gid=1000 \
 *     -e OPENMAPX_TEST_SEPARATE_DATA_FS=/xfs …
 */
const SEPARATE = process.env.OPENMAPX_TEST_SEPARATE_DATA_FS?.trim();
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const agents: ChildProcess[] = [];
let outdir = "";

describe.skipIf(!SEPARATE || process.platform !== "linux")(
  "agent state on a data directory of its own filesystem",
  () => {
    beforeAll(async () => {
      mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
      outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "state-xfs-"));
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

    /**
     * A checkout written under umask 002 into `target`, whose data directory
     * is already a mount of its own, in the state production is in before the
     * update: the old queue holds an empty `.claimed`, and `state/ops-agent`
     * exists empty, owner-only. With `queued`, the old queue also holds a file
     * named like a snapshot, and the old scratch a planted file, to show that
     * nothing is carried over.
     */
    async function checkout(target: string, queued: boolean) {
      const infra = join(target, "infra", "docker");
      expect(statSync(join(infra, "data")).dev).not.toBe(statSync(target).dev);
      const clone = mkdtempSync(join(tmpdir(), "openmapx-state-xfs-clone-"));
      roots.push(clone);
      const previous = process.umask(0o002);
      try {
        await run("git", ["clone", "-q", "--no-local", ROOT, join(clone, "checkout")]);
        cpSync(join(clone, "checkout"), target, { recursive: true });
      } finally {
        process.umask(previous);
      }
      writeFileSync(
        join(infra, ".env"),
        `POSTGRES_PASSWORD=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nDATA_MANAGER_AUTH_TOKEN=${secret()}\nOPENMAPX_HOST_DIR=${target}\n`,
        { mode: 0o600 },
      );
      const legacy = services.legacyAgentStatePaths(infra);
      const current = services.agentStatePaths(infra);
      mkdirSync(join(legacy.trustedConfig, ".claimed"), { recursive: true, mode: 0o700 });
      mkdirSync(legacy.privacyExtraction, { recursive: true, mode: 0o700 });
      if (queued) {
        writeFileSync(join(legacy.trustedConfig, `cfg1_${"q".repeat(43)}.json`), "queued", {
          mode: 0o600,
        });
        writeFileSync(join(legacy.privacyExtraction, "planted"), "data-manager");
      }
      mkdirSync(current.directory, { recursive: true, mode: 0o700 });
      return { infra, legacy, current };
    }

    async function cli(target: string, ...args: string[]) {
      return run(process.execPath, [join(outdir, "cli.mjs"), ...args], {
        cwd: target,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: target },
      });
    }

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

    /** The agent, with the queue mount the generation it was created from gives it. */
    async function startAgent(target: string, mountedQueue: string) {
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
          OPS_TRUSTED_CONFIG_DIR: mountedQueue,
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

    /** A trusted-configuration request app-api publishes into the queue it mounts. */
    async function expectCommitted(
      target: string,
      agent: { port: number; output: () => string },
      appApiQueue: string,
      name: string,
    ) {
      const infra = join(target, "infra", "docker");
      const tokenFile = join(infra, "secrets", "ops-agent-api-token");
      const directory = statSync(appApiQueue);
      const operationKey = createDurableOpsKey("stack.render", name);
      const before = services.currentConfigurationGeneration(infra);
      const sealed = await publishTrustedConfigurationSnapshot({
        directory: appApiQueue,
        token: readFileSync(tokenFile, "utf8").trim(),
        ownerUid: directory.uid,
        ownerGid: directory.gid,
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
      const result =
        consumed.submission.status === "fulfilled" ? consumed.submission.value : undefined;
      expect(result, `${JSON.stringify(result)}\n${agent.output()}`).toMatchObject({
        outcome: "committed",
      });
      expect(services.currentConfigurationGeneration(infra)).not.toBe(before);
    }

    /** Nothing crossed over, and the old directories stay for their containers. */
    function expectFreshState(state: ReturnType<typeof services.agentStatePaths>, queued: boolean) {
      const legacy = services.legacyAgentStatePaths(join(state.directory, "..", ".."));
      for (const directory of [state.trustedConfig, state.privacyExtraction]) {
        expect(statSync(directory).mode & 0o777).toBe(0o700);
        expect(statSync(directory).dev).not.toBe(statSync(legacy.trustedConfig).dev);
      }
      expect(existsSync(join(state.trustedConfig, `cfg1_${"q".repeat(43)}.json`))).toBe(false);
      expect(readdirSync(state.privacyExtraction)).toEqual([]);
      expect(readdirSync(legacy.trustedConfig).sort()).toEqual(
        queued ? [".claimed", `cfg1_${"q".repeat(43)}.json`] : [".claimed"],
      );
      if (queued) {
        expect(readFileSync(join(legacy.privacyExtraction, "planted"), "utf8")).toBe(
          "data-manager",
        );
      }
    }

    it("moves with a host update: render, then replace the agent and app-api together", async () => {
      const target = join(SEPARATE as string, "host-update");
      const { infra, current } = await checkout(target, true);

      // The host's `pnpm openmapx compose render`, which failed with EXDEV.
      const rendered = await cli(target, "compose", "render");
      expect(rendered.stdout).toContain("Rendered");
      expectFreshState(current, true);
      const compose = readFileSync(
        join(infra, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
        "utf8",
      );
      expect(compose).toContain("../../trusted-config:/var/lib/openmapx/trusted-config");

      // `services update` recreates both from this generation.
      const agent = await startAgent(target, current.trustedConfig);
      await expectCommitted(target, agent, current.trustedConfig, "host-update");
    }, 180_000);

    it("moves with a panel self-update, where app-api is replaced and the agent is not", async () => {
      const target = join(SEPARATE as string, "self-update");
      const { legacy, current } = await checkout(target, false);

      // The earlier release's deployment secrets, which its renders created.
      const secrets = join(target, "infra", "docker", "secrets");
      mkdirSync(secrets, { recursive: true, mode: 0o700 });
      for (const name of ["ops-agent-api-token", "ops-agent-data-manager-token"]) {
        writeFileSync(join(secrets, name), randomBytes(32).toString("base64url"), {
          mode: 0o600,
        });
      }
      // The helper recreates the agent from the current generation, which the
      // earlier release rendered: its container still mounts the old queue.
      const agent = await startAgent(target, legacy.trustedConfig);
      expectFreshState(current, false);

      // The release apply's `services update --no-deps app-api …` renders with
      // the new code and recreates app-api, which now mounts the new queue.
      // The agent keeps running with the old mount.
      const rendered = await cli(target, "compose", "render");
      expect(rendered.stdout).toContain("Rendered");
      await expectCommitted(target, agent, current.trustedConfig, "self-update");
    }, 180_000);
  },
);
