import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  canonicalReleaseManifest,
  parseReleaseManifest,
  renderReleaseCompose,
} from "../packages/core/src/services/release-manifest";
import {
  legacyReleaseStatePaths,
  releaseStatePaths,
} from "../packages/core/src/services/release-state";
import {
  buildRuntimeBundle,
  RUNTIME_BUNDLES,
  writeRuntimeBundle,
} from "./build-runtime-bundles.mjs";

/**
 * The agent's trusted state moving out of `infra/docker` into its own state
 * directory on a running stack, from the state openmapx.com is in: release
 * 287020e6c, which the host's `compose release` selected, so its overlay names
 * a release `.ops-agent-releases` (0700) does not hold; that store with the
 * agent's thirteen earlier 0600 manifests and three pointers; a checkout
 * written under umask 002; and `.env` 0600. Covers the host update and the
 * panel self-update, with `infra/docker/data` on a filesystem of its own.
 *
 * Runs only where `OPENMAPX_TEST_SEPARATE_DATA_FS` names a directory holding
 * `host-update/infra/docker/data` and `self-update/infra/docker/data`, each a
 * mount of its own (a tmpfs in a Linux container), as for
 * `ops-agent-state-cross-filesystem.test.ts`.
 */
const SEPARATE = process.env.OPENMAPX_TEST_SEPARATE_DATA_FS?.trim();
const run = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const agents: ChildProcess[] = [];
let outdir = "";

/** The release the host selected: in the overlay, not in the agent's store. */
const SELECTED = "287020e6cb521d8a8cc0216d115d47e8ffe5cc57-40136727952-1";
/** The releases the earlier agents stored. */
const RELEASE_DIGITS = [..."123456789abcd"];
const RELEASES = RELEASE_DIGITS.map(
  (digit, index) => `${digit.repeat(40)}-${39000000000 + index}-1`,
);
const digestOf = (contents: string) => createHash("sha256").update(contents).digest("hex");

function manifestFor(release: string, digit: string) {
  return parseReleaseManifest(
    JSON.stringify({
      schemaVersion: 1,
      release,
      images: Object.fromEntries(
        [
          "api",
          "web",
          "data-manager",
          "ops-agent",
          "privacy-backup",
          "transitous-runner",
          "transitous-tools",
        ].map((name) => [name, `ghcr.io/openmapx/${name}@sha256:${digit.repeat(64)}`]),
      ),
      privacyReleaseValidation: {
        version: 1,
        sourceBuildFingerprint: digit.repeat(64),
        validatedAt: "2026-10-20T12:00:00.000Z",
        checks: { translationsConsistent: true, openApiConsistent: true, policyConsistent: true },
      },
    }),
  );
}

const selectedManifest = manifestFor(SELECTED, "f");

describe.skipIf(!SEPARATE || process.platform !== "linux")(
  "the agent's state moving out of infra/docker on a running stack",
  () => {
    beforeAll(async () => {
      mkdirSync(join(ROOT, "apps", "ops-agent", "dist-temp"), { recursive: true });
      outdir = mkdtempSync(join(ROOT, "apps", "ops-agent", "dist-temp", "infra-state-"));
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

    async function cli(target: string, ...args: string[]) {
      return run(process.execPath, [join(outdir, "cli.mjs"), ...args], {
        cwd: target,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, OPENMAPX_ROOT_DIR: target },
      });
    }

    /**
     * The release 287020e6c deployment: its applied generation and pointer in
     * `infra/docker` itself, a selection file there, its release store,
     * overlay and evidence, and the agent state #606 moved already.
     */
    async function earlierDeployment(target: string) {
      const infra = join(target, "infra", "docker");
      expect(statSync(join(infra, "data")).dev).not.toBe(statSync(target).dev);
      const clone = mkdtempSync(join(tmpdir(), "openmapx-infra-state-clone-"));
      roots.push(clone);
      const previous = process.umask(0o002);
      try {
        await run("git", ["clone", "-q", "--no-local", ROOT, join(clone, "checkout")]);
        cpSync(join(clone, "checkout"), target, { recursive: true });
      } finally {
        process.umask(previous);
      }
      expect(statSync(infra).mode & 0o020).toBe(0o020);
      writeFileSync(
        join(infra, ".env"),
        `POSTGRES_PASSWORD=${secret()}\nBETTER_AUTH_SECRET=${secret()}\nDATA_MANAGER_AUTH_TOKEN=${secret()}\nOPENMAPX_HOST_DIR=${target}\n`,
        { mode: 0o600 },
      );
      // A generation the way release 287020e6c applied it, with app-api selected.
      services.writeServiceSelectionFile(infra, ["app-api"]);
      expect((await cli(target, "compose", "render")).stdout).toContain("Rendered");
      const configuration = join(infra, "state", "ops-agent", "configuration");
      const revision = readlinkSync(join(configuration, "current")).split("/").at(-1) as string;
      renameSync(join(configuration, "generations"), join(infra, ".trusted-config-generations"));
      rmSync(configuration, { recursive: true });
      symlinkSync(
        join(".trusted-config-generations", revision),
        join(infra, ".trusted-config-current"),
      );
      rmSync(services.serviceSelectionPath(infra));
      rmSync(releaseStatePaths(infra).directory, { recursive: true, force: true });
      // The earlier release's selection file, which another account of the
      // group could have written: never what is carried over.
      writeFileSync(
        join(infra, "service-selection.json"),
        JSON.stringify({ selected: ["app-api", "data-manager"] }),
      );
      const legacy = legacyReleaseStatePaths(infra);
      mkdirSync(legacy.store, { mode: 0o700 });
      const manifests = new Map<string, string>();
      RELEASES.forEach((release, index) => {
        const canonical = canonicalReleaseManifest(manifestFor(release, RELEASE_DIGITS[index]));
        manifests.set(release, canonical);
        writeFileSync(join(legacy.store, `${release}.json`), canonical, { mode: 0o600 });
      });
      const pointer = (releaseId: string) =>
        JSON.stringify({ releaseId, digest: digestOf(manifests.get(releaseId) as string) });
      writeFileSync(join(legacy.store, "current.json"), pointer(RELEASES[10]), { mode: 0o600 });
      writeFileSync(join(legacy.store, "latest.json"), pointer(RELEASES[12]), { mode: 0o600 });
      writeFileSync(
        join(legacy.store, "selections.json"),
        JSON.stringify(
          Object.fromEntries(
            RELEASES.slice(8).map((release) => [
              release,
              {
                configuration: "c".repeat(64),
                ociDigest: `sha256:${"d".repeat(64)}`,
                digest: digestOf(manifests.get(release) as string),
              },
            ]),
          ),
        ),
        { mode: 0o600 },
      );
      // `compose release` wrote the overlay and its evidence, and no manifest.
      const evidence = `${JSON.stringify(selectedManifest.privacyReleaseValidation)}\n`;
      const evidenceName = `privacy-release-validation-${digestOf(evidence)}.json`;
      writeFileSync(
        legacy.overlay,
        renderReleaseCompose(selectedManifest, infra).replace(
          /file: \S+/,
          `file: ../.release-evidence/${evidenceName}`,
        ),
        { mode: 0o600 },
      );
      mkdirSync(legacy.evidence, { mode: 0o700 });
      writeFileSync(join(legacy.evidence, evidenceName), evidence, { mode: 0o444 });
      return { infra, legacyFiles: snapshotLegacy(infra) };
    }

    /** Every file the earlier release keeps in infra/docker, to prove none changed. */
    function snapshotLegacy(infra: string): Record<string, string> {
      const entries: Record<string, string> = {};
      // Each entry is opened once, without following a link, and read through it.
      const walk = (path: string) => {
        let descriptor: number;
        try {
          descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ELOOP") throw error;
          entries[path] = `-> ${readlinkSync(path)}`;
          return;
        }
        try {
          const stats = fstatSync(descriptor);
          if (stats.isDirectory()) {
            entries[path] = `dir ${stats.mode}`;
            for (const name of readdirSync(path)) walk(join(path, name));
          } else entries[path] = `${stats.mode} ${digestOf(readFileSync(descriptor, "utf8"))}`;
        } finally {
          closeSync(descriptor);
        }
      };
      for (const name of [
        ".trusted-config-current",
        ".trusted-config-generations",
        "service-selection.json",
        ".ops-agent-releases",
        "docker-compose.release.yml",
        ".release-evidence",
      ]) {
        walk(join(infra, name));
      }
      return entries;
    }

    function expectMigrated(infra: string) {
      expect(services.currentConfigurationGeneration(infra)).toMatch(/^cfg1_/);
      // The selection came from the applied generation, not the group's file.
      expect(services.readServiceSelectionFile(infra)).toEqual(["app-api"]);
      const releases = releaseStatePaths(infra);
      expect(
        readdirSync(releases.store)
          .filter((name) => RELEASES.some((release) => name === `${release}.json`))
          .sort(),
      ).toEqual(RELEASES.map((release) => `${release}.json`).sort());
      expect(readdirSync(releases.store)).toEqual(
        expect.arrayContaining(["current.json", "latest.json", "selections.json"]),
      );
      // The host's selection stays selected, with its evidence beside it.
      expect(readFileSync(releases.overlay, "utf8")).toBe(
        renderReleaseCompose(selectedManifest, infra),
      );
      expect(readFileSync(releases.overlay, "utf8")).toContain("../../releases/evidence/");
      for (const directory of [
        join(infra, "state", "ops-agent"),
        join(infra, "state", "ops-agent", "configuration"),
        releases.directory,
        releases.store,
      ]) {
        expect(statSync(directory).mode & 0o077, directory).toBe(0);
      }
      // #605's tightening is gone: infra/docker keeps the umask's mode.
      expect(statSync(infra).mode & 0o020).toBe(0o020);
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

    /**
     * A `docker` that answers only the agent's question whether a handoff
     * helper runs: one does while `helper` exists.
     */
    function fakeDocker(target: string) {
      const bin = join(target, "..", `fake-docker-${randomBytes(4).toString("hex")}`);
      mkdirSync(bin);
      roots.push(bin);
      const helper = join(bin, "helper-running");
      writeFileSync(
        join(bin, "docker"),
        `#!/bin/sh\ncase "$*" in *openmapx.ops-agent.handoff*) [ -f "${helper}" ] && echo 0123456789ab; exit 0;; esac\nexit 1\n`,
      );
      chmodSync(join(bin, "docker"), 0o755);
      return { bin, helper };
    }

    async function startAgent(target: string, docker: { bin: string }) {
      const infra = join(target, "infra", "docker");
      const port = await freePort();
      const agent = spawn(process.execPath, [join(outdir, "agent.mjs")], {
        cwd: target,
        env: {
          PATH: `${docker.bin}:${process.env.PATH}`,
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
      const deadline = Date.now() + 60_000;
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

    async function expectCommitted(
      target: string,
      agent: { port: number; output: () => string },
      name: string,
    ) {
      const infra = join(target, "infra", "docker");
      const queue = services.agentStatePaths(infra).trustedConfig;
      const tokenFile = join(infra, "secrets", "ops-agent-api-token");
      const directory = statSync(queue);
      const operationKey = createDurableOpsKey("stack.render", name);
      const before = services.currentConfigurationGeneration(infra);
      const sealed = await publishTrustedConfigurationSnapshot({
        directory: queue,
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

    async function eventually(check: () => boolean, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() > deadline) return false;
        await new Promise((done) => setTimeout(done, 250));
      }
      return true;
    }

    it("moves with a host update and retires the earlier lock once the new agent runs", async () => {
      const target = join(SEPARATE as string, "host-update");
      const { infra, legacyFiles } = await earlierDeployment(target);

      // The operator's `pnpm openmapx compose render`, then `services update`.
      expect((await cli(target, "compose", "render")).stdout).toContain("Rendered");
      expectMigrated(infra);
      // The earlier agent still runs until `services update` replaces it.
      expect(services.legacyConfigurationWriterActive(infra)).toBe(true);

      // What another account of the group plants afterwards changes nothing.
      writeFileSync(
        join(infra, "service-selection.json"),
        JSON.stringify({ selected: ["data-manager"] }),
      );
      expect((await cli(target, "compose", "render")).stdout).toContain("Rendered");
      expect(services.readServiceSelectionFile(infra)).toEqual(["app-api"]);
      rmSync(join(infra, "service-selection.json"));
      writeFileSync(
        join(infra, "service-selection.json"),
        JSON.stringify({ selected: ["app-api", "data-manager"] }),
      );

      const docker = fakeDocker(target);
      const agent = await startAgent(target, docker);
      expect(await eventually(() => !services.legacyConfigurationWriterActive(infra), 10_000)).toBe(
        true,
      );
      await expectCommitted(target, agent, "host-update");
      // The earlier release's files stay, inert, for an agent restored by a rollback.
      expect(snapshotLegacy(infra)).toEqual(legacyFiles);
    }, 240_000);

    it("moves with a panel self-update and retires the earlier lock once its helper exits", async () => {
      const target = join(SEPARATE as string, "self-update");
      const { infra, legacyFiles } = await earlierDeployment(target);

      // The helper of the earlier agent started this one and still runs.
      const docker = fakeDocker(target);
      writeFileSync(docker.helper, "");
      const agent = await startAgent(target, docker);
      expect(agent.output()).toContain("Moving the applied configuration");
      expectMigrated(infra);
      expect(services.legacyConfigurationWriterActive(infra)).toBe(true);
      await expectCommitted(target, agent, "self-update");

      // Once the helper has exited, writers stop taking the earlier lock.
      rmSync(docker.helper);
      expect(await eventually(() => !services.legacyConfigurationWriterActive(infra), 30_000)).toBe(
        true,
      );
      expect(snapshotLegacy(infra)).toEqual(legacyFiles);
      expect(existsSync(join(infra, ".trusted-config-writer"))).toBe(false);
    }, 240_000);
  },
);
