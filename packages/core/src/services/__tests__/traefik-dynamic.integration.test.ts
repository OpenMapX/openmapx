import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { dump, load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentStatePaths, prepareAgentStateDirectories } from "../agent-state";
import {
  type ConfigurationInput,
  commitConfigurationGeneration,
} from "../configuration-generation";
import { CURRENT_CONFIGURATION, GENERATED_COMPOSE_FILE } from "../deployment";
import { TRAEFIK_ROUTES_FILE } from "../traefik-files";
import type { LoadedService, ServiceManifest } from "../types";

// A real Traefik, mounted as the rendered stack mounts it: its static file
// from the generation, its dynamic directory from the agent's state. CI pulls
// the pinned image first and passes it, so the test spends no registry budget.
const runTraefikTests = process.env.OPENMAPX_RUN_TRAEFIK_TESTS === "1";
const repoRoot = resolve(__dirname, "../../../../..");
const releaseTraefik = join(repoRoot, "services", "traefik");
const manifest = JSON.parse(
  readFileSync(join(releaseTraefik, "service.json"), "utf8"),
) as ServiceManifest;
const pinned = `${manifest.container.image}:${manifest.container.tag}@${manifest.container.digest}`;
const pulled = process.env.OPENMAPX_TRAEFIK_TEST_IMAGE;
const image = pulled || pinned;

const APPS = Array.from({ length: 16 }, (_, index) => `app-${String(index + 1).padStart(2, "0")}`);
const MANY = APPS;
// No app here strips its prefix, so this file has no middlewares at all.
const FEW = APPS.slice(0, 3);
const STRIPPED = "app-16";

let root: string;
let infraDir: string;
let services: LoadedService[];
const containers: string[] = [];
const volumes: string[] = [];

function docker(...args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Docker Desktop's file sharing shows the Linux VM a rename on the Mac as a
// removal and a creation, so a reader there briefly finds no file; a Linux
// host's bind mount, as on a server and in CI, keeps rename atomic.
const sharedFromAnotherKernel = () =>
  runTraefikTests && docker("info", "--format", "{{.OperatingSystem}}").includes("Docker Desktop");

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function app(id: string): LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: "example/app", tag: "1", expose: [3000] },
      exposure: { proxy: { enabled: true, pathPrefix: `/${id}`, stripPrefix: id === STRIPPED } },
    },
    directory: join(root, "services", id),
    isBuiltIn: true,
    enabled: false,
  };
}

function input(apps: readonly string[]): ConfigurationInput {
  return {
    domain: "maps.example.test",
    selectedRoots: ["traefik", ...apps],
    serviceConfigs: [],
    integrationConfigs: [],
    serviceSecrets: [],
  };
}

/** A render as the CLI and the agent run it: the state's directories first, so the generation mounts them. */
function render(apps: readonly string[]) {
  prepareAgentStateDirectories(infraDir);
  return commitConfigurationGeneration({
    infraDir,
    services,
    input: input(apps),
    legacyTraefikDynamicMounted: false,
  });
}

/** `docker run` volume flags for Traefik's rendered volumes, a fresh one for each named volume. */
function renderedTraefikVolumes(): string[] {
  const generation = join(infraDir, CURRENT_CONFIGURATION);
  const compose = load(readFileSync(join(generation, GENERATED_COMPOSE_FILE), "utf8")) as {
    services: Record<string, { volumes?: string[] }>;
  };
  const entries = compose.services.traefik?.volumes ?? [];
  expect(entries.length).toBeGreaterThan(0);
  return entries.flatMap((entry) => {
    const [source = "", target = "", mode] = entry.split(":");
    if (source.startsWith(".") || isAbsolute(source)) {
      // Compose resolves these against the `current` path as named.
      const path = resolve(generation, source);
      return ["--volume", `${path}:${target}${mode ? `:${mode}` : ""}`];
    }
    const volume = docker(
      "volume",
      "create",
      `openmapx-traefik-test-${randomBytes(4).toString("hex")}`,
    );
    volumes.push(volume);
    return ["--volume", `${volume}:${target}`];
  });
}

function startTraefik(): string {
  const id = docker(
    "run",
    "--detach",
    ...(pulled ? ["--pull", "never"] : []),
    "--network",
    "none",
    ...renderedTraefikVolumes(),
    image,
  );
  containers.push(id);
  return id;
}

/** The routers Traefik serves from its file provider, from inside its container. */
function fileRouters(id: string): string[] | null {
  try {
    const body = docker("exec", id, "wget", "-qO-", "http://127.0.0.1:8080/api/http/routers");
    return (JSON.parse(body) as Array<{ name: string; provider: string }>)
      .filter((router) => router.provider === "file")
      .map((router) => router.name)
      .sort();
  } catch {
    return null;
  }
}

const routerNames = (apps: readonly string[]) => apps.map((name) => `${name}@file`).sort();

async function waitForRouters(id: string, apps: readonly string[]): Promise<void> {
  const expected = routerNames(apps);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (JSON.stringify(fileRouters(id)) === JSON.stringify(expected)) return;
    await sleep(200);
  }
  expect(fileRouters(id)).toEqual(expected);
}

const started = (id: string) =>
  docker("inspect", "--format", "{{.State.StartedAt}} {{.RestartCount}}", id);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-traefik-dynamic-"));
  infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  // The release's files, with the API served on Traefik's own entry point so
  // the test can ask which routers it loaded.
  const traefik = join(root, "services", "traefik");
  const dynamic = join(traefik, "config", "dynamic");
  mkdirSync(dynamic, { recursive: true });
  const staticConfiguration = load(
    readFileSync(join(releaseTraefik, "config", "traefik.yml"), "utf8"),
  ) as Record<string, unknown>;
  staticConfiguration.api = { insecure: true };
  staticConfiguration.log = { level: "DEBUG", format: "json" };
  writeFileSync(join(traefik, "config", "traefik.yml"), dump(staticConfiguration));
  copyFileSync(
    join(releaseTraefik, "config", "dynamic", "middlewares.yml"),
    join(dynamic, "middlewares.yml"),
  );
  services = [{ manifest, directory: traefik, isBuiltIn: true, enabled: false }, ...APPS.map(app)];
});

afterEach(() => {
  for (const id of containers.splice(0)) docker("rm", "--force", id);
  for (const volume of volumes.splice(0)) docker("volume", "rm", "--force", volume);
  rmSync(root, { recursive: true, force: true });
});

const digest = (bytes: Buffer) => createHash("md5").update(bytes).digest("hex");

/**
 * Starts Traefik on the rendered stack with the few routes, then has render
 * replace its routes over and over while, inside its container, one loop reads
 * the file as Traefik does and another asks Traefik which routers it serves.
 */
async function replaceUnderTraefik() {
  await render(MANY);
  const routes = join(agentStatePaths(infraDir).traefikDynamic, TRAEFIK_ROUTES_FILE);
  const whole = new Set([digest(readFileSync(routes))]);
  await render(FEW);
  whole.add(digest(readFileSync(routes)));

  const traefik = startTraefik();
  await waitForRouters(traefik, FEW);
  const before = started(traefik);
  docker(
    "exec",
    "--detach",
    traefik,
    "sh",
    "-c",
    `while :; do md5sum /etc/traefik/dynamic/${TRAEFIK_ROUTES_FILE} >> /tmp/digests 2>&1; done`,
  );
  docker(
    "exec",
    "--detach",
    traefik,
    "sh",
    "-c",
    "while :; do wget -qO- http://127.0.0.1:8080/api/http/routers >> /tmp/routers 2>&1; echo >> /tmp/routers; sleep 0.05; done",
  );
  // Traefik applies the file provider's latest configuration at most every
  // two seconds (`providersThrottleDuration`), so two of the renders are held
  // longer: Traefik then serves each set while the replacing goes on.
  for (let round = 0; round < 30; round += 1) {
    await render(round % 2 === 0 ? MANY : FEW);
    await sleep(round === 10 || round === 21 ? 3_000 : 30 + (round % 5) * 20);
  }
  await waitForRouters(traefik, FEW);
  docker("exec", traefik, "pkill", "-f", "while :");

  // Each distinct line of the reader once, with how often it came.
  const reads = new Map<string, number>();
  for (const line of docker("exec", traefik, "sh", "-c", "sort /tmp/digests | uniq -c").split(
    "\n",
  )) {
    const [, count = "0", seen = ""] = /^\s*(\d+)\s+(.*)$/.exec(line) ?? [];
    reads.set(seen, Number(count));
  }
  let missing = 0;
  const read = new Map<string, number>();
  for (const [seen, count] of reads) {
    if (seen.includes("No such file")) missing += count;
    else read.set(seen.split(/\s+/)[0] ?? "", count);
  }
  const served = docker("exec", traefik, "cat", "/tmp/routers")
    .split("\n")
    .filter((line) => line.startsWith("["))
    .map((line) =>
      (JSON.parse(line) as Array<{ name: string; provider: string }>)
        .filter((router) => router.provider === "file")
        .map((router) => router.name)
        .sort(),
    );
  const fileProviderErrors = docker("logs", traefik)
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { level?: string; providerName?: string; error?: string })
    .filter((entry) => entry.providerName === "file" && entry.level === "error");
  return {
    traefik,
    before,
    whole,
    read,
    missing,
    served,
    fileProviderErrors,
  };
}

describe.runIf(runTraefikTests)("Traefik's dynamic directory in the agent's state", () => {
  it("serves a render's new routes without restarting Traefik", async () => {
    await render(FEW);
    const traefik = startTraefik();
    // Root, which reads the deployment user's owner-only files regardless.
    expect(docker("exec", traefik, "id", "-u")).toBe("0");
    expect(docker("exec", traefik, "stat", "-c", "%a", "/etc/traefik/dynamic")).toBe("700");
    await waitForRouters(traefik, FEW);
    const before = started(traefik);

    await render(MANY);
    await waitForRouters(traefik, MANY);
    await render(FEW);
    await waitForRouters(traefik, FEW);
    expect(started(traefik)).toBe(before);
  }, 120_000);

  it("never shows a reader of the routes a half-written file", async () => {
    const run = await replaceUnderTraefik();
    expect([...run.read.values()].reduce((sum, count) => sum + count, 0)).toBeGreaterThan(100);
    // Both versions were read, and nothing else.
    expect(new Set(run.read.keys())).toEqual(run.whole);
    expect(started(run.traefik)).toBe(run.before);
  }, 120_000);

  it.skipIf(sharedFromAnotherKernel())(
    "never shows Traefik a missing or partial route set while render replaces it",
    async () => {
      const run = await replaceUnderTraefik();
      expect(run.missing).toBe(0);
      expect(run.served.length).toBeGreaterThan(20);
      const sets = new Set(run.served.map((names) => JSON.stringify(names)));
      expect(sets).toEqual(
        new Set([JSON.stringify(routerNames(FEW)), JSON.stringify(routerNames(MANY))]),
      );
      expect(run.fileProviderErrors).toEqual([]);
      expect(started(run.traefik)).toBe(run.before);
    },
    120_000,
  );
});
