/** The crash-point suite's only seam to the system under test.
 *
 * Scenario files talk to a {@link CrashHost} and nothing else. The host is a
 * fresh installation in a temporary directory, provisioned by the real CLI
 * (`compose release`, `compose render`, `compose up`) against a fake Docker
 * engine and a real PostgreSQL database. The API, the operations agent and the
 * data-manager run as their production entrypoints in OS processes, each in a
 * mount namespace that reproduces its Compose bind mounts, and reach each other
 * through fault proxies. The configuration helper runs the same way when the
 * agent starts it with `docker run`.
 *
 * What may change here when the update system is rewritten: entrypoint paths,
 * environment, how an update or configuration change is submitted, and the
 * operator-exit commands. What scenarios observe stays outward: HTTP answers,
 * job and operation states over public or contract routes, CLI exit codes and
 * messages, the Docker trace, and the API's configuration inspect route. */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OPS_PROTOCOL_VERSION } from "@openmapx/core/ops";
import postgres from "postgres";
import { type RuntimeBundles, runtimeBundles } from "./support/bundles";
import {
  type ContainerRecord,
  FakeDockerEngine,
  type FaultRule,
  type Invocation,
  isEffect,
} from "./support/engine";
import { FaultProxy, type ProxiedRequest, type ReplyMatch } from "./support/fault-proxy";
import {
  type BindMount,
  type ContainedProcess,
  launchContained,
  sandboxAvailable,
} from "./support/sandbox";

export type Role = "api" | "agent" | "dm";
export type Link = "api->agent" | "agent->dm" | "dm->agent" | "api->dm";
export type Caller = Role | "helper" | "host-cli";

const REPO = fileURLToPath(new URL("../../../../../../", import.meta.url));
const SHIM = fileURLToPath(new URL("./support/docker-shim.mjs", import.meta.url));
const TSX = createRequire(import.meta.url).resolve("tsx/esm");
const REGISTRY = "registry.crash.test/openmapx";
const MANIFEST_REPOSITORY = `${REGISTRY}/release-manifest`;
const RELEASE_IMAGES = [
  "api",
  "web",
  "data-manager",
  "ops-agent",
  "transitous-runner",
  "transitous-tools",
] as const;
const SERVICE_OF_ROLE: Record<Role, string> = {
  api: "app-api",
  agent: "ops-agent",
  dm: "data-manager",
};
const ROLE_OF_SERVICE: Record<string, Role> = {
  "app-api": "api",
  "ops-agent": "agent",
  "data-manager": "dm",
};
const READINESS: Record<Role, string> = {
  api: "/health",
  agent: "/health",
  dm: "/status",
};

/** Why this machine cannot run the suite, or undefined when it can. */
export function crashPointsUnavailable(): string | undefined {
  if (process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")
    return "set OPENMAPX_RUN_DATABASE_TESTS=1 with a disposable DATABASE_URL";
  if (!process.env.DATABASE_URL) return "DATABASE_URL is not set";
  return (
    sandboxAvailable() ?? (realDocker() ? undefined : "the Docker CLI with Compose is required")
  );
}

function realDocker(): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "docker");
    if (directory && existsSync(candidate) && !candidate.includes("crash-points")) return candidate;
  }
  return undefined;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function secret(): string {
  return randomBytes(32).toString("hex");
}

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  options: { timeoutMs: number; intervalMs?: number; what: string },
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
  }
  throw new Error(
    `Timed out waiting for ${options.what}${last instanceof Error ? `: ${last.message}` : ""}`,
  );
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Submission {
  status: number;
  jobId?: string;
  body: unknown;
}

export interface JobView {
  id: string;
  status: string;
  error?: string;
  errorCode?: string;
  terminal: boolean;
}

export interface DockerMatch {
  /** The Docker command: `compose up`, `pull`, `run`, `inspect`, ... */
  command:
    | "compose up"
    | "compose stop"
    | "compose restart"
    | "compose start"
    | "pull"
    | "run"
    | "container inspect"
    | "container ls"
    | "manifest inspect"
    | "info"
    /** Any Compose command that changes containers. */
    | "compose"
    | "any";
  /** A Compose service named by the invocation, or the helper for `run`. */
  service?: string;
  caller?: Caller;
  /** A text one of the arguments contains. */
  contains?: string;
}

export interface HeldEffect {
  /** Resolves when a matching invocation reached the engine and is held. */
  readonly entered: Promise<Invocation>;
  /** Lets the held invocation take effect. */
  release(): void;
  /** Answers the held invocation with a Docker error instead. */
  fail(message?: string): void;
}

interface RoleProcess {
  role: Role;
  process: ContainedProcess;
  killedByTest: boolean;
}

function matches(match: DockerMatch, invocation: Invocation): boolean {
  if (match.caller && invocation.caller !== match.caller) return false;
  const words = invocation.args;
  const has = (word: string) => words.includes(word);
  switch (match.command) {
    case "compose up":
      if (!(words[0] === "compose" && (has("up") || has("create")))) return false;
      break;
    case "compose stop":
      if (!(words[0] === "compose" && (has("stop") || has("kill")))) return false;
      break;
    case "compose start":
      if (!(words[0] === "compose" && has("start"))) return false;
      break;
    case "compose restart":
      if (!(words[0] === "compose" && has("restart"))) return false;
      break;
    case "pull":
      if (!(words[0] === "pull" || (words[0] === "image" && words[1] === "pull"))) return false;
      break;
    case "run":
      if (!(words[0] === "run" || (words[0] === "container" && words[1] === "run"))) return false;
      break;
    case "container inspect":
      if (!((words[0] === "container" && words[1] === "inspect") || words[0] === "inspect"))
        return false;
      break;
    case "container ls":
      if (!((words[0] === "container" && words[1] === "ls") || words[0] === "ps")) return false;
      break;
    case "manifest inspect":
      if (!(words[0] === "manifest" && words[1] === "inspect")) return false;
      break;
    case "compose":
      if (words[0] !== "compose" || !isEffect(words)) return false;
      break;
    case "info":
      if (words[0] !== "info") return false;
      break;
    case "any":
      break;
  }
  if (match.contains && !words.some((word) => word.includes(match.contains as string)))
    return false;
  if (match.service) {
    if (match.command === "run")
      return words.some((word) => word.includes(match.service as string));
    return words.at(-1) === match.service || words.includes(match.service);
  }
  return true;
}

export class CrashHost {
  readonly root: string;
  readonly hostDir: string;
  readonly infraDir: string;
  private readonly binDir: string;
  private readonly workDir: string;
  private readonly engine: FakeDockerEngine;
  private readonly proxies: Record<Link, FaultProxy>;
  private readonly ports: Record<Role, number>;
  private readonly roles = new Map<Role, RoleProcess>();
  private readonly helpers = new Set<ContainedProcess>();
  private readonly environment: Record<string, string>;
  private databaseUrl = "";
  private databaseName = "";
  private admin?: { cookie: string; userId: string };
  private closed = false;
  private bundles?: RuntimeBundles;
  /** Release image name by image id, for `docker run` of a release image. */
  private readonly imageNames = new Map<string, string>();
  readonly release = { current: "", next: "", nextDigest: "" };

  private constructor(root: string, ports: Record<Role, number>) {
    this.root = root;
    this.hostDir = join(root, "host");
    this.infraDir = join(this.hostDir, "infra", "docker");
    this.binDir = join(root, "bin");
    this.workDir = join(root, "work");
    this.ports = ports;
    this.environment = {};
    const docker = realDocker();
    if (!docker) throw new Error("The Docker CLI with Compose is required");
    this.engine = new FakeDockerEngine({
      realDocker: docker,
      startRole: (service, container) =>
        this.startRoleProcess(ROLE_OF_SERVICE[service] as Role, container),
      stopRole: async (service) => this.stopRoleProcess(ROLE_OF_SERVICE[service] as Role),
      roleState: (service) => this.roleState(ROLE_OF_SERVICE[service] as Role),
      runContainer: (container, request) => this.runContainer(container, request.env),
    });
    this.proxies = {
      "api->agent": new FaultProxy(`http://127.0.0.1:${ports.agent}`),
      "agent->dm": new FaultProxy(`http://127.0.0.1:${ports.dm}`),
      "dm->agent": new FaultProxy(`http://127.0.0.1:${ports.agent}`),
      "api->dm": new FaultProxy(`http://127.0.0.1:${ports.dm}`),
    };
  }

  /** A fresh installation on release N, with release N+1 published. */
  static async open(): Promise<CrashHost> {
    const root = mkdtempSync(join(tmpdir(), "openmapx-crash-"));
    chmodSync(root, 0o755);
    const host = new CrashHost(root, {
      api: await freePort(),
      agent: await freePort(),
      dm: await freePort(),
    });
    try {
      await host.provision();
      return host;
    } catch (error) {
      await host.close();
      throw error;
    }
  }

  private async provision() {
    mkdirSync(this.binDir, { recursive: true, mode: 0o755 });
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(this.binDir, "docker"),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(SHIM)} "$@"\n`,
      { mode: 0o755 },
    );
    this.step("build the runtime bundles");
    this.bundles = await runtimeBundles(REPO);
    this.copyCheckout();
    this.engine.traceFile = join(this.workDir, "docker-trace.jsonl");
    await this.engine.listen();
    for (const proxy of Object.values(this.proxies)) await proxy.listen();
    await this.createDatabase();
    this.publishReleases();
    this.writeEnvironment();
    this.step("select release N");
    await this.cliOk(["compose", "release"]);
    this.step("render");
    await this.cliOk(["compose", "render"]);
    this.publishThirdPartyImages();
    this.step("compose up");
    await this.cliOk(["compose", "up"]);
    this.step("wait for the roles");
    await this.waitReady(["api", "dm", "agent"]);
    // A fresh data-manager runs its startup data jobs; one that fails keeps
    // admission closed until its interrupted-job reconciler has observed it.
    // The installation counts as settled once a data job is admitted again.
    this.step("wait for data admission");
    await waitFor(async () => ((await this.submitDataJob()).status === 200 ? true : undefined), {
      timeoutMs: 180_000,
      intervalMs: 2000,
      what: "the data-manager to admit a data job",
    });
    this.step("publish and check release N+1");
    this.publishNextRelease();
    const checked = await this.checkForUpdate();
    if (checked.releaseId !== this.release.next)
      throw new Error(`The update check found ${checked.releaseId}, not ${this.release.next}`);
    this.step("installed");
  }

  /** Asks the data-manager to start a short data job (a dataset reload), as
   * the API does on an operator's behalf. 200 is admitted; 409 is busy. */
  async submitDataJob(): Promise<Submission> {
    const response = await fetch(`${this.proxies["api->dm"].url}/datasets/reload`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.environment.DATA_MANAGER_AUTH_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: response.status, body };
  }

  private step(message: string) {
    if (process.env.OPENMAPX_CRASH_DEBUG === "1")
      process.stderr.write(`[crash-points ${new Date().toISOString()}] ${message}\n`);
  }

  private copyCheckout() {
    mkdirSync(this.hostDir, { recursive: true, mode: 0o755 });
    // The release's service manifests and service files, without anything a
    // build or an earlier run left in the checkout.
    const skipped = new Set(["node_modules", "dist", "coverage", ".turbo", ".next"]);
    for (const entry of [
      "services",
      "integrations",
      "pnpm-workspace.yaml",
      "package.json",
      "turbo.json",
    ])
      cpSync(join(REPO, entry), join(this.hostDir, entry), {
        recursive: true,
        filter: (source) => !skipped.has(source.split("/").at(-1) as string),
      });
    const infraSource = join(REPO, "infra", "docker");
    for (const file of [
      ".env.example",
      "feeds-overlay.example.json",
      "feeds-overlay.schema.json",
      "gbfs-catalog.lock.json",
      "gbfs-catalog.lock.schema.json",
      "transitous.lock.json",
      "transport-apis.lock.json",
      "transport-apis.lock.schema.json",
      "secrets/README.md",
      "secrets/.gitignore",
      "dashboards/transit-providers.json",
    ]) {
      const target = join(this.infraDir, file);
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      cpSync(join(infraSource, file), target);
    }
    for (const path of [
      this.hostDir,
      join(this.hostDir, "infra"),
      this.infraDir,
      join(this.infraDir, "secrets"),
    ])
      chmodSync(path, 0o755);
    chmodSync(join(this.infraDir, "secrets"), 0o700);
  }

  private async createDatabase() {
    const admin = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} });
    this.databaseName = `crash_${randomBytes(6).toString("hex")}`;
    // The roles refuse a placeholder password in production mode: each host
    // gets its own owner role with a random one.
    const password = randomBytes(24).toString("base64url");
    try {
      await admin.unsafe(`CREATE ROLE ${this.databaseName} LOGIN SUPERUSER PASSWORD '${password}'`);
      await admin.unsafe(`CREATE DATABASE ${this.databaseName} OWNER ${this.databaseName}`);
    } finally {
      await admin.end({ timeout: 2 });
    }
    const url = new URL(process.env.DATABASE_URL as string);
    url.pathname = `/${this.databaseName}`;
    url.username = this.databaseName;
    url.password = password;
    this.databaseUrl = url.toString();
    const database = postgres(this.databaseUrl, { max: 1, onnotice: () => {} });
    try {
      await database`CREATE EXTENSION IF NOT EXISTS postgis`;
    } finally {
      await database.end({ timeout: 2 });
    }
  }

  private releaseManifest(release: string, images: Record<string, string>) {
    const builtAt = "2026-11-01T12:00:00.000Z";
    const sourceRevision = createHash("sha1").update(release).digest("hex");
    return `${JSON.stringify({
      buildMetadata: {
        images: Object.fromEntries(
          [...RELEASE_IMAGES]
            .sort((a, b) => a.localeCompare(b))
            .map((name) => [
              name,
              { builtAt, coldRefreshedAt: builtAt, inputHash: "0".repeat(64), sourceRevision },
            ]),
        ),
        version: 1,
      },
      images: Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b))),
      producer: {
        event: "push",
        repository: "openmapx/openmapx",
        runAttempt: 1,
        runId: 1,
        sourceRevision,
        workflowPath: ".github/workflows/ci.yml",
      },
      release,
      schemaVersion: 1,
    })}`;
  }

  /** Release N is selected at install; N+1 is what `main` points at afterwards. */
  private publishReleases() {
    const publish = (release: string) => {
      const images: Record<string, string> = {};
      for (const name of RELEASE_IMAGES) {
        const { digest, imageId } = this.engine.publishImage([`${REGISTRY}/${name}:${release}`], {
          labels: {
            "org.opencontainers.image.version": release,
            "openmapx.configuration-handoff.version": "1",
          },
        });
        this.imageNames.set(imageId, name);
        images[name] = `${REGISTRY}/${name}@${digest}`;
      }
      const manifest = this.releaseManifest(release, images);
      const published = this.engine.publishImage([`${MANIFEST_REPOSITORY}:${release}`], {
        files: { "/release-manifest.json": manifest },
        healthcheck: false,
      });
      return { ...published, manifest };
    };
    this.release.current = "crash-release-n";
    this.release.next = "crash-release-n1";
    const current = publish(this.release.current);
    const next = publish(this.release.next);
    this.engine.retag(`${MANIFEST_REPOSITORY}:main`, current.imageId);
    this.nextManifestImage = next.imageId;
  }

  private nextManifestImage = "";

  /** Points the followed release channel at N+1, as a new publication would. */
  publishNextRelease() {
    this.engine.retag(`${MANIFEST_REPOSITORY}:main`, this.nextManifestImage);
  }

  private publishThirdPartyImages() {
    const config = spawnText(
      realDocker() as string,
      [
        "compose",
        "--env-file",
        join(this.infraDir, ".env"),
        "-f",
        join(this.infraDir, "state/ops-agent/configuration/current/docker-compose.generated.yml"),
        "config",
        "--format",
        "json",
      ],
      this.infraDir,
    );
    const model = JSON.parse(config) as { services: Record<string, { image: string }> };
    for (const spec of Object.values(model.services)) {
      if (spec.image.startsWith(`${REGISTRY}/`)) continue;
      this.engine.publishImage([spec.image]);
      this.engine.preload(spec.image);
    }
  }

  private writeEnvironment() {
    const values = {
      DOMAIN: "localhost",
      ACME_EMAIL: "crash-points@example.org",
      POSTGRES_PASSWORD: secret(),
      BETTER_AUTH_SECRET: secret(),
      OPENMAPX_SECRETS_KEY: secret(),
      DATA_MANAGER_AUTH_TOKEN: secret(),
      OPENMAPX_LOCAL_ADMIN_TOKEN: secret(),
      OPENMAPX_HOST_DIR: this.hostDir,
      DOCKER_GID: String(process.getegid?.() ?? 0),
      TRANSITOUS_COUNTRIES: "de",
      TRANSITOUS_SYNC_CRON: "disabled",
      OPENMAPX_RELEASE: "main",
      OPENMAPX_RELEASE_MANIFEST_REPOSITORY: MANIFEST_REPOSITORY,
      OPENMAPX_DOCKER_CONFIG_DIR: join(this.root, "docker-config"),
    };
    mkdirSync(values.OPENMAPX_DOCKER_CONFIG_DIR, { recursive: true, mode: 0o700 });
    Object.assign(this.environment, values);
    writeFileSync(
      join(this.infraDir, ".env"),
      `${Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n")}\n`,
      { mode: 0o600 },
    );
  }

  /** The PATH every process of this host sees: the Docker shim first. */
  private path(): string {
    return [
      this.binDir,
      dirname(process.execPath),
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].join(":");
  }

  private roleEnvironment(role: Role, container: ContainerRecord): Record<string, string> {
    const env: Record<string, string> = {};
    for (const entry of container.Config.Env) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    delete env.REDIS_URL;
    delete env.REDIS_PASSWORD_FILE;
    delete env.NODE_OPTIONS;
    Object.assign(env, {
      PATH: this.path(),
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(this.ports[role]),
      OPENMAPX_CRASH_DOCKER_ENGINE: this.engine.url,
      OPENMAPX_CRASH_ROLE: role,
    });
    if (role === "api") {
      env.DATABASE_URL = this.databaseUrl;
      env.OPS_AGENT_URL = this.proxies["api->agent"].url;
      env.DATA_MANAGER_URL = this.proxies["api->dm"].url;
    } else if (role === "dm") {
      env.DATABASE_URL = this.databaseUrl;
      env.OPS_AGENT_URL = this.proxies["dm->agent"].url;
      env.APP_API_BASE_URL = `http://127.0.0.1:${this.ports.api}`;
    } else {
      env.DATA_MANAGER_URL = this.proxies["agent->dm"].url;
    }
    return env;
  }

  private binds(container: ContainerRecord): BindMount[] {
    return container.Mounts.filter((mount) => mount.Type === "bind").map((mount) => ({
      source: mount.Source,
      target: mount.Destination,
      readOnly: !mount.RW,
    }));
  }

  private identity(container: ContainerRecord) {
    const [uid, gid] = container.Config.User.split(":").map(Number);
    return {
      uid: Number.isInteger(uid) ? (uid as number) : (process.geteuid?.() ?? 0),
      gid: Number.isInteger(gid) ? (gid as number) : (process.getegid?.() ?? 0),
      groups: (container.HostConfig.GroupAdd ?? []).map(Number).filter(Number.isInteger),
    };
  }

  /** The image command of a role, as its Dockerfile runs it. */
  private roleCommand(role: Role): { argv: string[]; cwd: string } {
    const bundles = this.bundles as RuntimeBundles;
    if (role === "agent")
      return {
        argv: [process.execPath, join(bundles.opsAgent, "agent.mjs")],
        cwd: join(REPO, "apps/ops-agent"),
      };
    if (role === "dm")
      return {
        argv: [process.execPath, join(bundles.dataManager, "supervisor.mjs")],
        cwd: join(REPO, "services/data-manager"),
      };
    return {
      argv: [process.execPath, "--import", TSX, join(REPO, "apps/api/src/server.ts")],
      cwd: join(REPO, "apps/api"),
    };
  }

  private async startRoleProcess(role: Role, container: ContainerRecord) {
    await this.stopRoleProcess(role);
    const command = this.roleCommand(role);
    const launched = launchContained({
      name: `${role}-${Date.now()}`,
      workDir: this.workDir,
      argv: command.argv,
      env: this.roleEnvironment(role, container),
      binds: this.binds(container),
      ...this.identity(container),
      cwd: command.cwd,
    });
    const record: RoleProcess = { role, process: launched, killedByTest: false };
    this.roles.set(role, record);
    await launched.started;
    const startedAt = Date.now();
    void launched.exited.then(({ code, signal }) => {
      writeFileSync(
        join(this.workDir, `${role}.log`),
        `${launched.output()}\n[crash-points] ${role} exited (${code ?? signal})\n`,
        { flag: "a" },
      );
      if (this.closed || record.killedByTest || this.roles.get(role) !== record) return;
      // The container's restart policy: a crashed process comes back, with
      // Docker's doubling delay while it keeps crashing right away.
      const quick = Date.now() - startedAt < 10_000;
      const delay = quick ? Math.min((this.restartDelays.get(role) ?? 500) * 2, 15_000) : 1000;
      this.restartDelays.set(role, delay);
      setTimeout(() => {
        if (this.closed || this.roles.get(role) !== record) return;
        void this.startRoleProcess(role, container);
      }, delay);
    });
  }

  private readonly restartDelays = new Map<Role, number>();

  private async stopRoleProcess(role: Role) {
    const current = this.roles.get(role);
    if (!current) return;
    this.roles.delete(role);
    current.killedByTest = true;
    current.process.kill("SIGTERM");
    const exited = await Promise.race([
      current.process.exited.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exited) {
      current.process.kill("SIGKILL");
      await current.process.exited;
    }
  }

  private roleState(role: Role): "running" | "starting" | "exited" {
    const current = this.roles.get(role);
    if (!current || current.killedByTest) return "exited";
    return "running";
  }

  /** `docker run` of a release image: its command runs from the matching bundle. */
  private runContainer(container: ContainerRecord, callerEnv: Record<string, string>) {
    const bundles = this.bundles as RuntimeBundles;
    const env: Record<string, string> = { HOME: "/tmp" };
    for (const entry of container.Config.Env) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      // As Docker does: a bare name takes the client's value, or is unset.
      else if (callerEnv[entry] !== undefined) env[entry] = callerEnv[entry] as string;
    }
    const helper = container.Config.Cmd.some((value) => value.includes("configuration-handoff"));
    Object.assign(env, {
      PATH: this.path(),
      OPENMAPX_CRASH_DOCKER_ENGINE: this.engine.url,
      OPENMAPX_CRASH_ROLE: helper ? "helper" : "container",
    });
    const image = this.imageNames.get(container.Image);
    const command = [...(container.Config.Entrypoint ?? []), ...container.Config.Cmd];
    // The image's init process only forwards signals; the PID namespace's
    // first process takes its place.
    if (command[0]?.endsWith("/tini")) command.splice(0, command[1] === "--" ? 2 : 1);
    if (image !== "ops-agent" || command.length === 0)
      return {
        exited: Promise.resolve({
          code: 127,
          stdout: "",
          stderr: `crash-point engine runs only the operations-agent image's commands\n`,
        }),
      };
    const argv = command.map((value, index) =>
      index === 0 && value === "node"
        ? process.execPath
        : value.startsWith("dist/")
          ? join(bundles.opsAgent, value.slice("dist/".length))
          : value,
    );
    const launched = launchContained({
      name: `${helper ? "helper" : "container"}-${Date.now()}`,
      workDir: this.workDir,
      argv,
      env,
      binds: this.binds(container),
      ...this.identity(container),
      cwd: join(REPO, "apps/ops-agent"),
    });
    this.helpers.add(launched);
    const exited = launched.exited.then(({ code }) => {
      if (helper) writeFileSync(join(this.workDir, "helper.log"), launched.output(), { flag: "a" });
      this.helpers.delete(launched);
      return { code: code ?? 137, stdout: launched.stdout(), stderr: launched.stderr() };
    });
    return { exited };
  }

  private async waitReady(roles: Role[], timeoutMs = 180_000) {
    for (const role of roles) {
      await waitFor(
        async () => {
          const current = this.roles.get(role);
          if (!current) return undefined;
          const response = await fetch(`http://127.0.0.1:${this.ports[role]}${READINESS[role]}`, {
            signal: AbortSignal.timeout(2000),
          });
          return response.status === 200 ? true : undefined;
        },
        { timeoutMs, what: `${role} to answer`, intervalMs: 500 },
      ).catch((error) => {
        throw new Error(`${(error as Error).message}\n${this.logs(role).slice(-4000)}`);
      });
    }
  }

  logs(role: Role | "helper"): string {
    const live = role === "helper" ? "" : (this.roles.get(role)?.process.output() ?? "");
    const file = join(this.workDir, `${role}.log`);
    return `${existsSync(file) ? readFileSync(file, "utf8") : ""}${live}`;
  }

  async cli(args: string[], options: { env?: Record<string, string> } = {}): Promise<CliResult> {
    return new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", TSX, join(REPO, "packages/cli/src/index.ts"), ...args],
        {
          cwd: this.hostDir,
          env: {
            HOME: process.env.HOME ?? this.root,
            PATH: this.path(),
            OPENMAPX_ROOT_DIR: this.hostDir,
            OPENMAPX_CRASH_DOCKER_ENGINE: this.engine.url,
            OPENMAPX_CRASH_ROLE: "host-cli",
            ...options.env,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  private async cliOk(args: string[]) {
    const result = await this.cli(args);
    if (result.code !== 0)
      throw new Error(
        `openmapx ${args.join(" ")} exited ${result.code}\n${result.stdout}\n${result.stderr}\nunsupported docker: ${this.engine.unsupported.join("\n")}`,
      );
    return result;
  }

  get unsupportedDocker(): readonly string[] {
    return this.engine.unsupported;
  }

  async kill(role: Role): Promise<void> {
    const current = this.roles.get(role);
    if (!current) return;
    current.killedByTest = true;
    current.process.kill("SIGKILL");
    await current.process.exited;
  }

  /** Starts a killed role again in its existing container, as Docker's restart policy would. */
  async restart(role: Role): Promise<void> {
    const container = [...this.engine.containers.values()].find(
      (value) => value.service === SERVICE_OF_ROLE[role],
    );
    if (!container) throw new Error(`No container runs ${role}`);
    await this.startRoleProcess(role, container);
    await this.waitReady([role]);
  }

  /** Holds the first matching Docker invocation until released. */
  blockDocker(match: DockerMatch, options: { skip?: number } = {}): HeldEffect {
    const rule: FaultRule = this.engine.hold((invocation) => matches(match, invocation), options);
    // A run that never reaches the effect fails with what the engine saw last,
    // instead of hanging until the suite's own timeout.
    const entered = Promise.race([
      rule.entered,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `No Docker invocation matched ${JSON.stringify(match)} within 180 s; last calls:\n${this.engine.trace
                  .slice(-12)
                  .map(
                    (call) =>
                      `${call.caller} ${call.code ?? "…"} ${call.args.join(" ").slice(0, 200)}`,
                  )
                  .join("\n")}`,
              ),
            ),
          180_000,
        );
        void rule.entered.then(() => clearTimeout(timer));
      }),
    ]);
    entered.catch(() => undefined);
    return {
      entered,
      release: () => rule.release(),
      fail: (message = "Error response from daemon: injected failure") =>
        rule.release({ fail: message }),
    };
  }

  /** Fails matching Docker invocations. */
  failDocker(
    match: DockerMatch,
    options: { times?: number; skip?: number; message?: string } = {},
  ) {
    const rule = this.engine.fail((invocation) => matches(match, invocation), options);
    return { entered: rule.entered };
  }

  /** The next container created for the service reports unhealthy. */
  unhealthyAfterRecreate(service: string) {
    this.engine.unhealthyServices.add(service);
  }

  registryOutage(down: boolean) {
    this.engine.registryDown = down;
  }

  dropReply(link: Link, match: ReplyMatch): Promise<ProxiedRequest> {
    return this.proxies[link].dropReply(match);
  }

  requests(link: Link): readonly ProxiedRequest[] {
    return this.proxies[link].requests;
  }

  dockerTrace(): readonly Invocation[] {
    return this.engine.trace;
  }

  /** Invocations that change containers or images. */
  dockerEffects(filter: Partial<DockerMatch> & { since?: number } = {}): Invocation[] {
    const { since = 0, ...match } = filter;
    return this.engine.trace.filter(
      (invocation) =>
        invocation.seq > since &&
        isEffect(invocation.args) &&
        matches({ command: match.command ?? "any", ...match } as DockerMatch, invocation),
    );
  }

  /** Every Docker invocation of a caller, read-only ones included. */
  dockerCalls(filter: Partial<DockerMatch> & { since?: number } = {}): Invocation[] {
    const { since = 0, ...match } = filter;
    return this.engine.trace.filter(
      (invocation) =>
        invocation.seq > since &&
        matches({ command: match.command ?? "any", ...match } as DockerMatch, invocation),
    );
  }

  /** A point in the Docker trace; later filters count only what follows it. */
  mark(): number {
    return this.engine.trace.at(-1)?.seq ?? 0;
  }

  /** The image each Compose service's container runs. */
  runningImages(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const container of this.engine.containers.values())
      if (container.service) out[container.service] = container.Image;
    return out;
  }

  /** The image id release N+1 uses for a release image name. */
  releaseImageId(release: "current" | "next", name: (typeof RELEASE_IMAGES)[number]): string {
    const tag = release === "current" ? this.release.current : this.release.next;
    const entry = this.engine.registry.get(`${REGISTRY}/${name}:${tag}`);
    if (!entry) throw new Error(`Unknown release image ${name}`);
    return entry.imageId;
  }

  private async adminSession(): Promise<{ cookie: string; userId: string }> {
    if (this.admin) return this.admin;
    const email = `admin-${randomUUID()}@example.org`;
    const password = `Crash-${secret()}`;
    const base = `http://127.0.0.1:${this.ports.api}`;
    const signUp = await fetch(`${base}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://localhost" },
      body: JSON.stringify({ email, password, name: "Crash point administrator" }),
    });
    if (signUp.status >= 400)
      throw new Error(`Administrator sign-up failed: ${signUp.status} ${await signUp.text()}`);
    const database = postgres(this.databaseUrl, { max: 1, onnotice: () => {} });
    let userId: string;
    try {
      const [row] = await database<{ id: string }[]>`
        UPDATE "user" SET role = 'admin', email_verified = true WHERE email = ${email} RETURNING id`;
      if (!row) throw new Error("The administrator account was not created");
      userId = row.id;
    } finally {
      await database.end({ timeout: 2 });
    }
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://localhost" },
      body: JSON.stringify({ email, password }),
    });
    if (signIn.status >= 400)
      throw new Error(`Administrator sign-in failed: ${signIn.status} ${await signIn.text()}`);
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    this.admin = { cookie, userId };
    return this.admin;
  }

  /** An authenticated administrator request to the API. */
  async api(
    method: string,
    path: string,
    body?: unknown,
    options: { fresh?: boolean; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: unknown }> {
    const { cookie } = await this.adminSession();
    // Maintenance requests are rate limited per client network. A request that
    // must reach admission comes from its own loopback address, as a request
    // from another administrator's workstation would.
    const localAddress = options.fresh
      ? `127.0.0.${10 + (this.clientCounter++ % 240)}`
      : "127.0.0.1";
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: this.ports.api,
          path,
          method,
          localAddress,
          headers: {
            cookie,
            origin: "https://localhost",
            ...options.headers,
            ...(payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                }),
          },
          timeout: 60_000,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown = text;
            try {
              parsed = JSON.parse(text);
            } catch {
              // Not JSON.
            }
            resolve({ status: response.statusCode ?? 0, body: parsed });
          });
        },
      );
      request.on("error", reject);
      request.on("timeout", () => request.destroy(new Error(`API ${method} ${path} timed out`)));
      request.end(payload);
    });
  }

  private clientCounter = 0;

  /** Checks for an update through the API and waits for the check to finish. */
  async checkForUpdate(): Promise<{ releaseId?: string; digest?: string }> {
    const check = await this.api("POST", "/api/admin/system/updates/check", {}, { fresh: true });
    if (check.status !== 200)
      throw new Error(`Update check refused: ${check.status} ${JSON.stringify(check.body)}`);
    const jobId = (check.body as { jobId: string }).jobId;
    await this.waitForJob(jobId);
    const system = await this.api("GET", "/api/admin/system");
    const release = (
      system.body as { release?: { availableReleaseId?: string; availableDigest?: string } }
    ).release;
    // The admin panel applies exactly what the check reported.
    if (release?.availableReleaseId === this.release.next && release.availableDigest)
      this.release.nextDigest = release.availableDigest;
    return { releaseId: release?.availableReleaseId, digest: release?.availableDigest };
  }

  /** Submits the system update to release N+1, as the admin panel does. */
  async submitUpdate(options: { backup?: boolean } = {}): Promise<Submission> {
    const response = await this.api(
      "POST",
      "/api/admin/system/updates/apply",
      {
        confirmation: "UPDATE OPENMAPX",
        createBackup: options.backup ?? false,
        releaseId: this.release.next,
        expectedDigest: this.release.nextDigest,
      },
      { fresh: true },
    );
    return {
      status: response.status,
      body: response.body,
      ...(typeof (response.body as { jobId?: unknown })?.jobId === "string"
        ? { jobId: (response.body as { jobId: string }).jobId }
        : {}),
    };
  }

  /** Starts, stops or restarts one service from the admin panel. */
  async serviceAction(service: string, action: "start" | "stop" | "restart"): Promise<Submission> {
    const response = await this.api(
      "POST",
      `/api/admin/services/${service}/action`,
      { action },
      // The admin panel names each intent with a key it keeps for retries.
      { fresh: true, headers: { "idempotency-key": `crash-point-${randomUUID()}` } },
    );
    const jobId = (response.body as { jobId?: unknown })?.jobId;
    return {
      status: response.status,
      body: response.body,
      ...(typeof jobId === "string" ? { jobId } : {}),
    };
  }

  /** The agent operations the API submitted, as the agent admitted them. */
  agentOperations(
    kind?: string,
  ): Array<{ kind: string; operationId: string; operationKey?: string }> {
    const seen = new Map<string, { kind: string; operationId: string; operationKey?: string }>();
    for (const entry of this.proxies["api->agent"].requests) {
      if (entry.method !== "POST" || !entry.kind || !entry.operationId) continue;
      if (kind && entry.kind !== kind) continue;
      seen.set(entry.operationId, {
        kind: entry.kind,
        operationId: entry.operationId,
        ...(entry.operationKey ? { operationKey: entry.operationKey } : {}),
      });
    }
    return [...seen.values()];
  }

  /** A request to the agent's operations contract, as the API makes it. */
  async agentRequest(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const token = readFileSync(
      join(this.infraDir, "secrets", "ops-agent-api-token"),
      "utf8",
    ).trim();
    const response = await fetch(`${this.proxies["api->agent"].url}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-ops-protocol-version": String(OPS_PROTOCOL_VERSION),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Not JSON.
    }
    return { status: response.status, body: parsed };
  }

  /** The agent's account of one operation: its state, or why it has none. */
  async operation(
    operationId: string,
  ): Promise<{ status: number; state?: string; errorClass?: string }> {
    const response = await this.agentRequest("GET", `/v1/operations/${operationId}`);
    const body = response.body as {
      result?: { state?: string; error?: { class?: string } };
      error?: { class?: string };
    };
    return {
      status: response.status,
      ...(body.result?.state ? { state: body.result.state } : {}),
      ...(body.result?.error?.class || body.error?.class
        ? { errorClass: body.result?.error?.class ?? body.error?.class }
        : {}),
    };
  }

  /** A job as the admin Activity view reports it. */
  async job(id: string): Promise<JobView> {
    const response = await this.api("GET", `/api/admin/jobs/${id}`);
    if (response.status !== 200) throw new Error(`Job ${id} is unavailable: ${response.status}`);
    const job = response.body as {
      id: string;
      status: string;
      error?: string | null;
      result?: { errorCode?: string } | null;
      logs?: unknown;
    };
    this.lastJobs.set(id, job);
    return {
      id: job.id,
      status: job.status,
      ...(job.error ? { error: job.error } : {}),
      ...(job.result?.errorCode ? { errorCode: job.result.errorCode } : {}),
      terminal: ["success", "failed", "canceled"].includes(job.status),
    };
  }

  private readonly lastJobs = new Map<string, unknown>();

  /** The job once terminal, or as it stands when the wait ends: an update the
   * system holds for the operator stays unfinished on purpose. */
  async settledJob(id: string, timeoutMs: number): Promise<JobView> {
    try {
      return await this.waitForJob(id, { timeoutMs });
    } catch {
      return this.job(id);
    }
  }

  async waitForJob(
    id: string,
    options: { timeoutMs?: number; until?: (job: JobView) => boolean } = {},
  ): Promise<JobView> {
    const until = options.until ?? ((job: JobView) => job.terminal);
    try {
      const job = await waitFor(
        async () => {
          const view = await this.job(id);
          return until(view) ? view : undefined;
        },
        { timeoutMs: options.timeoutMs ?? 240_000, what: `job ${id}`, intervalMs: 500 },
      );
      this.step(
        `job ${id}: ${JSON.stringify(this.lastJobs.get(id)).slice(0, 8000)}\nunsupported docker: ${this.engine.unsupported.join("\n")}`,
      );
      return job;
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nlast seen: ${JSON.stringify(this.lastJobs.get(id)).slice(0, 6000)}`,
      );
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const role of [...this.roles.keys()]) {
      const current = this.roles.get(role);
      if (!current) continue;
      current.killedByTest = true;
      current.process.kill("SIGKILL");
      await current.process.exited;
    }
    for (const helper of this.helpers) {
      helper.kill("SIGKILL");
      await helper.exited;
    }
    await this.engine.close();
    for (const proxy of Object.values(this.proxies)) await proxy.close().catch(() => undefined);
    if (this.databaseName && process.env.OPENMAPX_CRASH_KEEP !== "1") {
      const admin = postgres(process.env.DATABASE_URL as string, { max: 1, onnotice: () => {} });
      try {
        await admin.unsafe(`DROP DATABASE IF EXISTS ${this.databaseName} WITH (FORCE)`);
        await admin.unsafe(`DROP ROLE IF EXISTS ${this.databaseName}`);
      } catch {
        // A database left behind is removed with its disposable server.
      } finally {
        await admin.end({ timeout: 2 });
      }
    }
    if (process.env.OPENMAPX_CRASH_KEEP !== "1")
      rmSync(this.root, { recursive: true, force: true });
  }
}

function spawnText(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
