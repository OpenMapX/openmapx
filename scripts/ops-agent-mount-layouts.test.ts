import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  OpsClient,
  type OpsOperation,
  type OpsOperationKind,
  type OpsResultFor,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDurableOpsKey,
  executeTrustedConfigurationAndWait,
} from "../apps/api/src/services/ops-client";
import {
  consumePublishedTrustedConfiguration,
  publishTrustedConfigurationSnapshot,
} from "../apps/api/src/services/trusted-config-publisher";
import {
  agentHandoffRunArgs,
  inspectAgentContainer,
  writeAgentHandoff,
} from "../apps/ops-agent/src/agent-handoff";

/**
 * The operations agent's own image under both mount layouts it supports: the
 * whole checkout at its host path, as this release's manifest mounts it, and
 * the narrow one a later release switches to, at the same host paths:
 *
 * - `infra/docker`, read-only: `.env` (through the directory, so an editor's
 *   atomic save is seen) and the overrides;
 * - `infra/docker/{state,data,secrets,backups}`, read-write;
 * - nothing else of the checkout. For that run the checkout itself is gone
 *   from the host too, apart from those, so what the agent would read from it
 *   is absent, not empty.
 *
 * Each run starts the agent, commits a configuration change through it as
 * app-api would, with a service file override, runs its fixed CLI's check
 * and render, reads the stack's status and a handoff record, and inspects
 * what its self-update helper would mount.
 *
 * Runs only on Linux where `OPENMAPX_TEST_AGENT_IMAGE` names a built image of
 * apps/ops-agent/Dockerfile from this commit, with Docker reachable.
 */
const IMAGE = process.env.OPENMAPX_TEST_AGENT_IMAGE ?? "";
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const containers: string[] = [];
const OVERRIDE_MARK = "# openmapx-ci: an operator's override";

const RUNTIME_DIRECTORIES = ["state", "data", "secrets", "backups"] as const;
/** The stack's network, which `docker compose up` of the generation creates. */
const COMPOSE_NETWORK = `${services.STACK_PROJECT}_openmapx`;

async function docker(...args: string[]): Promise<string> {
  return (await run("docker", args, { maxBuffer: 16 * 1024 * 1024 })).stdout;
}

/** The mounts at or under the checkout's path, for each layout. */
function layoutMounts(layout: "checkout" | "narrow", root: string) {
  const infra = join(root, "infra", "docker");
  return layout === "checkout"
    ? [{ source: root, target: root, readOnly: false }]
    : [
        { source: infra, target: infra, readOnly: true },
        ...RUNTIME_DIRECTORIES.map((name) => ({
          source: join(infra, name),
          target: join(infra, name),
          readOnly: false,
        })),
      ];
}

describe.skipIf(process.platform !== "linux" || !IMAGE)(
  "the operations agent's image under either mount layout",
  () => {
    afterAll(async () => {
      for (const id of containers.splice(0)) await docker("rm", "--force", id).catch(() => "");
      await docker("network", "rm", COMPOSE_NETWORK).catch(() => "");
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    const secret = () => randomBytes(24).toString("base64url");
    const uid = process.geteuid?.() ?? 0;
    const gid = process.getegid?.() ?? 0;

    /** `pnpm openmapx compose render` on the host: the CLI from source. */
    async function hostRender(root: string): Promise<string> {
      const cli = join(ROOT, "packages", "cli");
      const { stdout, stderr } = await run(
        join(cli, "node_modules", ".bin", "tsx"),
        [
          "--tsconfig",
          join(cli, "tsconfig.json"),
          join(cli, "src", "index.ts"),
          "compose",
          "render",
        ],
        {
          cwd: root,
          env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: root },
        },
      );
      return `${stdout}${stderr}`;
    }

    /** A host: a checkout, its .env and a render on the host. */
    async function host(): Promise<string> {
      const parent = mkdtempSync(join(tmpdir(), "openmapx-mount-layouts-"));
      roots.push(parent);
      const root = join(parent, "checkout");
      await run("git", ["clone", "-q", "--no-local", ROOT, root]);
      const socketGroup = statSync("/var/run/docker.sock").gid;
      const dockerConfig = join(parent, "docker-config");
      mkdirSync(dockerConfig, { mode: 0o700 });
      writeFileSync(
        join(root, "infra", "docker", ".env"),
        [
          `UID=${uid}`,
          `GID=${gid}`,
          `DOCKER_GID=${socketGroup}`,
          `POSTGRES_PASSWORD=${secret()}`,
          `BETTER_AUTH_SECRET=${secret()}`,
          `DATA_MANAGER_AUTH_TOKEN=${secret()}`,
          `OPENMAPX_HOST_DIR=${root}`,
          `OPENMAPX_DOCKER_CONFIG_DIR=${dockerConfig}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      // Before the one-time import and the agent's first start, the agent
      // keeps the whole checkout.
      expect(await hostRender(root)).toContain(
        "The operations agent keeps the whole checkout mounted.",
      );
      expect(services.generationAgentMountLayout(join(root, "infra", "docker"))).toBe("checkout");
      return root;
    }

    /** Takes the checkout away, keeping only what the narrow layout mounts. */
    function removeCheckout(root: string): void {
      for (const name of readdirSync(root)) {
        if (name !== "infra") rmSync(join(root, name), { recursive: true, force: true });
      }
      for (const name of readdirSync(join(root, "infra"))) {
        if (name !== "docker") rmSync(join(root, "infra", name), { recursive: true, force: true });
      }
      const keep = new Set([".env", "overrides", ...RUNTIME_DIRECTORIES]);
      for (const name of readdirSync(join(root, "infra", "docker"))) {
        if (!keep.has(name))
          rmSync(join(root, "infra", "docker", name), { recursive: true, force: true });
      }
    }

    async function startAgent(root: string, layout: "checkout" | "narrow") {
      const infra = join(root, "infra", "docker");
      const { id, baseUrl } = layout === "narrow" ? await composeAgent(root) : await runAgent(root);
      containers.push(id);
      const logs = async () => {
        const { stdout, stderr } = await run("docker", ["logs", id]).catch((error) => error);
        return `${stdout ?? ""}${stderr ?? ""}`;
      };
      const deadline = Date.now() + 90_000;
      for (;;) {
        const healthy = await fetch(`${baseUrl}/health`)
          .then((response) => response.ok)
          .catch(() => false);
        if (healthy) break;
        const state = (await docker("inspect", "--format", "{{.State.Status}}", id)).trim();
        if (state !== "running") throw new Error(`The agent exited: ${await logs()}`);
        if (Date.now() > deadline)
          throw new Error(`The agent never became healthy: ${await logs()}`);
        await new Promise((done) => setTimeout(done, 250));
      }
      const tokenFile = join(infra, "secrets", "ops-agent-api-token");
      return {
        id,
        logs,
        client: new OpsClient({ baseUrl, tokenFile }),
        token: readFileSync(tokenFile, "utf8").trim(),
        exec: (...args: string[]) =>
          run("docker", ["exec", id, ...args], { maxBuffer: 16 * 1024 * 1024 }).catch(
            (error: { stdout?: string; stderr?: string; code?: number }) => ({
              stdout: error.stdout ?? "",
              stderr: error.stderr ?? "",
              failed: error.code ?? 1,
            }),
          ),
        stop: () => docker("rm", "--force", id),
      };
    }
    type Agent = Awaited<ReturnType<typeof startAgent>>;

    /**
     * The agent as this release's manifest has it, from the generation the
     * host render wrote, exactly as `services update ops-agent` creates it.
     * Reached at its address on the stack's network.
     */
    async function composeAgent(root: string): Promise<{ id: string; baseUrl: string }> {
      const infra = join(root, "infra", "docker");
      const compose = [
        "compose",
        "--env-file",
        join(infra, ".env"),
        "-f",
        join(infra, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      ];
      await docker("tag", IMAGE, "ghcr.io/openmapx/ops-agent:main");
      await docker(...compose, "up", "--detach", "--no-deps", "ops-agent");
      const id = (await docker(...compose, "ps", "--all", "--quiet", "ops-agent")).trim();
      const address = (
        await docker(
          "inspect",
          "--format",
          "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}",
          id,
        )
      )
        .trim()
        .split(" ")[0];
      return { id, baseUrl: `http://${address}:4300` };
    }

    /**
     * An agent created with the whole checkout, as an earlier release's
     * generation, or a panel update from one, leaves it.
     */
    async function runAgent(root: string): Promise<{ id: string; baseUrl: string }> {
      const infra = join(root, "infra", "docker");
      const id = (
        await docker(
          "run",
          "--detach",
          "--user",
          `${uid}:${gid}`,
          "--group-add",
          String(statSync("/var/run/docker.sock").gid),
          "--publish",
          "127.0.0.1::4300",
          "--mount",
          "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
          ...layoutMounts("checkout", root).flatMap((mount) => [
            "--mount",
            `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
          ]),
          "--env",
          `OPENMAPX_ROOT_DIR=${root}`,
          "--env",
          "HOST=0.0.0.0",
          "--env",
          "PORT=4300",
          "--env",
          "HOME=/tmp",
          "--env",
          `OPS_AGENT_API_TOKEN_FILE=${join(infra, "secrets", "ops-agent-api-token")}`,
          "--env",
          `OPS_AGENT_DATA_MANAGER_TOKEN_FILE=${join(infra, "secrets", "ops-agent-data-manager-token")}`,
          "--env",
          `OPS_TRUSTED_CONFIG_DIR=${services.agentStatePaths(infra).trustedConfig}`,
          IMAGE,
        )
      ).trim();
      const port = Number((await docker("port", id, "4300/tcp")).trim().split(":").at(-1));
      return { id, baseUrl: `http://127.0.0.1:${port}` };
    }

    async function operate<K extends OpsOperationKind>(
      agent: Agent,
      operation: Extract<OpsOperation, { kind: K }>,
    ): Promise<OpsResultFor<K>> {
      const submitted = await agent.client.execute(operation, {
        operationKey: `opk1_${randomBytes(18).toString("base64url")}`,
      });
      if (submitted.execution === "sync") return submitted.value as OpsResultFor<K>;
      for (;;) {
        const status = await agent.client.status(operation.kind, submitted.operationId);
        if (status.state === "succeeded") return status.result as OpsResultFor<K>;
        if (status.state !== "queued" && status.state !== "running") {
          throw new Error(`${operation.kind} ended ${status.state}: ${await agent.logs()}`);
        }
        await new Promise((done) => setTimeout(done, 250));
      }
    }

    /** A configuration change app-api publishes and the agent commits. */
    async function commit(root: string, agent: Agent, name: string): Promise<void> {
      const infra = join(root, "infra", "docker");
      const operationKey = createDurableOpsKey("stack.render", name);
      const before = services.currentConfigurationGeneration(infra);
      const sealed = await publishTrustedConfigurationSnapshot({
        directory: services.agentStatePaths(infra).trustedConfig,
        token: agent.token,
        ownerUid: uid,
        ownerGid: gid,
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
      const consumed = await consumePublishedTrustedConfiguration(sealed, () =>
        executeTrustedConfigurationAndWait(
          agent.client,
          sealed.operation as Parameters<typeof executeTrustedConfigurationAndWait>[1],
          operationKey,
        ),
      );
      const result =
        consumed.submission.status === "fulfilled" ? consumed.submission.value : undefined;
      expect(result, `${JSON.stringify(result)}\n${await agent.logs()}`).toMatchObject({
        outcome: "committed",
      });
      expect(services.currentConfigurationGeneration(infra)).not.toBe(before);
    }

    for (const layout of ["checkout", "narrow"] as const) {
      it(`${layout === "narrow" ? "with only infra/docker and its runtime directories" : "with the whole checkout"}: starts, commits with an override, checks, renders, and reports its handoffs`, async () => {
        const root = await host();
        const infra = join(root, "infra", "docker");
        // The one-time import runs where this release runs it: with the
        // whole checkout. A later release switches only once it has.
        const first = await startAgent(root, "checkout");
        await commit(root, first, "import");
        await first.stop();
        expect(services.serviceFilesImported(infra)).toBe(true);
        // The agent's own render keeps the layout it runs with.
        expect(services.generationAgentMountLayout(infra)).toBe("checkout");
        if (layout === "narrow") {
          // Now that nothing is missing, a render on the host switches it.
          expect(await hostRender(root)).not.toContain("keeps the whole checkout");
          expect(services.generationAgentMountLayout(infra)).toBe("narrow");
        }

        const shipped = readFileSync(join(ROOT, "services/traefik/config/dynamic/middlewares.yml"));
        const override = join(infra, "overrides/services/traefik/config/dynamic/middlewares.yml");
        mkdirSync(dirname(override), { recursive: true, mode: 0o755 });
        writeFileSync(override, `${shipped}\n${OVERRIDE_MARK}\n`, { mode: 0o644 });
        if (layout === "narrow") removeCheckout(root);
        const env = readFileSync(join(infra, ".env"));

        const agent = await startAgent(root, layout);
        expect(await agent.logs()).toContain(
          layout === "narrow"
            ? `The checkout is not mounted: only ${infra}`
            : `The checkout is mounted at ${root}.`,
        );
        if (layout === "narrow") {
          // What the agent sees of the checkout: infra/docker's .env, the
          // overrides and the runtime directories, and nothing else.
          const listing = await agent.exec(
            "sh",
            "-c",
            `ls -A ${root}; ls -A ${root}/infra; ls -A ${infra}`,
          );
          expect(listing.stdout.split("\n").filter(Boolean)).toEqual([
            "infra",
            "docker",
            ...[".env", "backups", "data", "overrides", "secrets", "state"],
          ]);
          for (const absent of ["services", "packages", "apps", "integrations", ".git"]) {
            const probe = await agent.exec("test", "-e", join(root, absent));
            expect(probe, absent).toMatchObject({ failed: 1 });
          }
        }

        // A configuration change through the admin panel's path, with the
        // override in place of the release's file.
        await commit(root, agent, layout);
        // The agent's commit keeps the layout it runs with, either way.
        expect(services.generationAgentMountLayout(infra)).toBe(layout);
        expect(
          readFileSync(
            join(services.agentStatePaths(infra).directory, "traefik/dynamic/middlewares.yml"),
            "utf8",
          ),
        ).toContain(OVERRIDE_MARK);

        // check, as Run diagnostics runs it, and the render services.update
        // starts with.
        const checked = await agent.exec("node", "dist/cli.mjs", "check");
        const report = `${checked.stdout}${checked.stderr}`;
        expect(report).not.toMatch(/ENOENT/);
        if (layout === "narrow") {
          expect(report).toContain("runs without the checkout, so it doesn't compare");
        }
        const rendered = await agent.exec("node", "dist/cli.mjs", "compose", "render");
        expect(rendered, `${rendered.stdout}${rendered.stderr}`).not.toHaveProperty("failed");
        expect(rendered.stdout).toContain("Rendered");

        // The stack as Compose sees it from the agent, and a handoff record.
        await expect(operate(agent, { kind: "stack.status" })).resolves.toHaveProperty("services");
        const now = new Date().toISOString();
        writeAgentHandoff(root, {
          version: 1,
          handoffId: "handoff-layout",
          releaseId: "main",
          digest: "a".repeat(64),
          phase: "applied",
          previousOverlay: null,
          createdAt: now,
          updatedAt: now,
        });
        await expect(
          operate(agent, { kind: "agent.handoff.inspect", handoffId: "handoff-layout" }),
        ).resolves.toEqual({ handoffId: "handoff-layout", phase: "applied" });

        // What its self-update helper would mount: the agent's own mounts.
        const facts = await inspectAgentContainer(
          async (args) => docker(...args),
          agent.id,
          root,
          new AbortController().signal,
        );
        // The same mounts, the outermost first so a nested one isn't hidden.
        const byTarget = (mounts: Array<{ target: string }>) =>
          [...mounts].sort((left, right) => left.target.localeCompare(right.target));
        expect(byTarget(facts.rootMounts)).toEqual(byTarget(layoutMounts(layout, root)));
        expect(facts.rootMounts[0]).toEqual(layoutMounts(layout, root)[0]);
        const helper = agentHandoffRunArgs(facts, root, "handoff-layout").join("\n");
        if (layout === "narrow") expect(helper).not.toContain(`target=${root}\n`);

        // The agent read .env and never wrote it.
        expect(readFileSync(join(infra, ".env")).equals(env)).toBe(true);
        await agent.stop();
      }, 600_000);
    }
  },
);
