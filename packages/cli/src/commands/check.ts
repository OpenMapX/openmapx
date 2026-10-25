import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import type { Command } from "commander";
import { execa } from "execa";
import { assertCliDeploymentSecrets } from "../lib/deployment-secret-policy";
import { dockerCompose, dockerRun } from "../lib/docker";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";
import { transitousApiKeysLeftBehindWarning } from "../lib/transitous-api-keys";

interface PsLine {
  Service?: string;
  Name?: string;
  State?: string;
  Health?: string;
}

type DockerComposeResult = Awaited<ReturnType<typeof dockerCompose>>;

export async function dockerComposeAfterDeploymentSecretCheck(
  args: string[],
  dependencies: {
    env?: NodeJS.ProcessEnv;
    dockerCompose?: (args: string[]) => Promise<DockerComposeResult>;
  } = {},
): Promise<DockerComposeResult> {
  assertCliDeploymentSecrets(dependencies.env ?? process.env);
  return (dependencies.dockerCompose ?? dockerCompose)(args);
}

/**
 * Application-level deep probes per service, restored from the old
 * `manage.sh check` runbook. The renderer's docker healthcheck already covers
 * the "is the process up?" case via `docker compose ps`; this map adds the
 * "is it returning real responses?" check that catches wedged-but-running
 * states (Pelias indexer not finished, MOTIS missing config feeds, etc.).
 *
 * `path` is appended to `http://<service-id>:<port>` and probed from an
 * ephemeral curl container on the openmapx network — no dependency on what
 * tooling each service image happens to ship. `expect` is a substring grep on
 * the response body; omit to require any 2xx.
 */
export const DEEP_PROBES: Record<string, { port: number; path: string; expect?: string } | null> = {
  valhalla: { port: 8002, path: "/status", expect: "tileset_last_modified" },
  osrm: { port: 5000, path: "/nearest/v1/driving/13.405,52.52", expect: "waypoints" },
  motis: { port: 8080, path: "/api/v1/geocode?text=test", expect: "name" },
  otp: { port: 8080, path: "/otp/routers" },
  nominatim: { port: 8080, path: "/status" },
  photon: { port: 2322, path: "/api?q=test", expect: "features" },
  // The explicit `[timeout:25]` matters: a timeout-less query reaped under load
  // can orphan its query-hash-keyed shm segment, after which Overpass returns
  // `duplicate_query` for that exact string indefinitely. Bounding the query lets
  // it clean up. `node(1)` is a cheap liveness query — an empty `elements` array
  // is still a valid 2xx body.
  overpass: {
    port: 80,
    path: "/api/interpreter?data=%5Bout%3Ajson%5D%5Btimeout%3A25%5D%3Bnode(1)%3Bout%3B",
    expect: "elements",
  },
  tileserver: { port: 8080, path: "/health" },
  pelias: { port: 4000, path: "/v1/place?ids=whosonfirst:locality:101748479" },
  "app-api": { port: 3001, path: "/health" },
  martin: { port: 3000, path: "/health" },
  // Services whose engine-level healthcheck is the most useful probe — leave to docker.
  postgis: null,
  redis: null,
  elasticsearch: null,
  traefik: null,
  "app-web": null,
  "well-known": null,
  "data-manager": { port: 4000, path: "/status", expect: "ok" },
  "motis-feed-proxy": { port: 80, path: "/healthz" },
  "pelias-pip": { port: 4200, path: "/" },
  "pelias-placeholder": { port: 4100, path: "/parser/findbyid?ids=1" },
};

interface ProbeResult {
  status: "ok" | "fail" | "skipped";
  detail: string;
}

export function probeFailureDetail(stderr: string, exitCode: number): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !/^Run 'docker run --help' for more information\.?$/.test(line));
  return lines.at(-1) ?? `exit ${exitCode}`;
}

/**
 * The env file holds deployment credentials. Anything broader than owner-only
 * read/write means another local account on the host can read them. Returns a
 * warning string, or null when the mode is acceptable or the file is absent.
 */
export function envFilePermissionWarning(path: string, mode: number | null): string | null {
  if (mode === null) return null;
  const permissions = mode & 0o777;
  if ((permissions & 0o077) === 0) return null;
  const octal = permissions.toString(8).padStart(3, "0");
  return `${path} is mode 0${octal} — readable beyond its owner. Run: chmod 600 ${path}`;
}

export function composeNetworkName(configText: string): string | null {
  try {
    const config = JSON.parse(configText) as {
      name?: unknown;
      networks?: Record<string, { name?: unknown } | null>;
    };
    const explicitName = config.networks?.openmapx?.name;
    if (typeof explicitName === "string" && explicitName.trim()) return explicitName.trim();
    if (typeof config.name === "string" && config.name.trim()) {
      return `${config.name.trim()}_openmapx`;
    }
  } catch {
    // Fall back to the conventional reference-deployment network below.
  }
  return null;
}

/**
 * Probe image: a small, pinned curl container. curl's ENTRYPOINT is `curl`, so
 * everything after the image name is curl flags. `-f` turns non-2xx responses
 * into a non-zero exit (the "require any 2xx" contract); `-sS` keeps stdout to
 * the body while still surfacing transport errors on stderr.
 */
export const PROBE_IMAGE = "curlimages/curl:8.20.0";

/**
 * Build the argv (after `docker run`) for an in-network HTTP probe: a one-off
 * curl container attached to the compose network. This must run via `docker
 * run`, not `docker compose run` — the latter rejects `--network` ("unknown
 * flag") and treats the image as a service name.
 */
export function buildProbeArgs(network: string, url: string): string[] {
  return ["--rm", "--network", network, PROBE_IMAGE, "-fsS", "--max-time", "5", url];
}

async function runDeepProbe(serviceId: string, network: string): Promise<ProbeResult> {
  const probe = DEEP_PROBES[serviceId];
  if (probe === null) return { status: "skipped", detail: "no app-level probe" };
  if (probe === undefined) return { status: "skipped", detail: "unknown service" };

  const url = `http://${serviceId}:${probe.port}${probe.path}`;
  const result = await dockerRun(buildProbeArgs(network, url));

  if (result.exitCode !== 0) {
    return { status: "fail", detail: probeFailureDetail(result.stderr, result.exitCode) };
  }
  if (probe.expect && !result.stdout.toLowerCase().includes(probe.expect.toLowerCase())) {
    return { status: "fail", detail: `response missing "${probe.expect}"` };
  }
  return { status: "ok", detail: "" };
}

async function detectComposeNetwork(): Promise<string> {
  // Read the network name from this checkout's rendered config. `compose ls`
  // lists every project on the host and its first row may belong to an
  // unrelated deployment (for example the docs stack).
  const result = await dockerCompose(["config", "--format", "json"]);
  if (result.exitCode === 0) {
    const name = composeNetworkName(result.stdout);
    if (name) return name;
  }
  return "docker_openmapx";
}

/**
 * Installed integrations the operations agent does not load, and why: not
 * installed through it, changed since, or needing a reinstall after an
 * upgrade. Empty from source, where nothing is recorded.
 */
export function installedIntegrationWarnings(rootDir: string): string[] {
  if (!coreServices.embeddedBuiltInIntegrationManifests()) return [];
  try {
    return coreServices
      .loadTrustedIntegrationAuthority(rootDir)
      .problems.map(
        ({ integrationId, problem }) => `Integration "${integrationId}" is not loaded: ${problem}`,
      );
  } catch (error) {
    return [`Installed integrations could not be checked: ${(error as Error).message}`];
  }
}

/**
 * What stops stack commands or release updates until the operator acts: an
 * `.env` that is not the operator's alone, which every stack command refuses,
 * and an earlier release's selection that did not come over, which holds
 * automatic release selection.
 */
export function deploymentStateErrors(infraDir: string): string[] {
  return [
    coreServices.deploymentEnvironmentFileProblem(join(infraDir, ".env")),
    coreServices.releaseSelectionHold(infraDir),
  ].filter((error): error is string => error !== null);
}

interface ComposeConfigService {
  user?: unknown;
  volumes?: Array<{ type?: unknown; source?: unknown; read_only?: unknown }>;
}

/** The entries one check visits under writable mounts, in total. */
export const OWNERSHIP_ENTRY_LIMIT = 50_000;

/** How the ownership walk reads the filesystem: without following links. */
export interface OwnershipFilesystem {
  lstat(path: string): { uid: number; isDirectory(): boolean; isSymbolicLink(): boolean };
  readdir(path: string): string[];
}

const hostFilesystem: OwnershipFilesystem = {
  lstat: (path) => lstatSync(path),
  readdir: (path) => readdirSync(path),
};

/** How many paths another uid owns a report lists, and names in its chown. */
export const FOREIGN_ENTRY_DISPLAY_LIMIT = 20;

/** Control characters, which neither a report line nor a pasted command may carry raw. */
const CONTROL_CHARACTERS = /\p{Cc}/u;

/** A path as a report shows it: control characters escaped. */
function displayPath(path: string): string {
  return CONTROL_CHARACTERS.test(path) ? JSON.stringify(path) : path;
}

/**
 * A root command for the operator to paste: each path quoted for a POSIX
 * shell, after `--`, with `-h` so a symbolic link swapped in meanwhile has its
 * own owner changed, not its target's. Container-written names can hold shell
 * syntax; a name with control characters is left out, and said so.
 */
export function chownCommand(
  owner: string,
  paths: readonly string[],
  recursive: boolean,
): { command: string; omitted: string[] } {
  const quotable = paths.filter((path) => !CONTROL_CHARACTERS.test(path));
  const omitted = paths.filter((path) => CONTROL_CHARACTERS.test(path)).map(displayPath);
  const quoted = quotable.map((path) => `'${path.replaceAll("'", "'\\''")}'`);
  return {
    command: `sudo chown -h${recursive ? " -R" : ""} ${owner} -- ${quoted.join(" ")}`,
    omitted,
  };
}

function commandNote(fix: { command: string; omitted: string[] }): string {
  return fix.omitted.length > 0
    ? `${fix.command} (not in it, as their names hold control characters: ${fix.omitted.join(", ")})`
    : fix.command;
}

function within(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * Walk `root` without following links and collect each topmost entry `uid`
 * does not own, without descending into it: one `chown -R` of that entry
 * covers what is below it. Subtrees in `exempt` are not entered: a service
 * that runs as its image's own user writes them. A foreign directory that
 * encloses one of them goes into `shallow` instead, for a `chown` of itself
 * alone, and the walk continues inside it. A symbolic link's own owner
 * counts, and a linked directory is not entered; an entry that vanishes or
 * cannot be read is skipped. Returns false when the shared budget ran out
 * first.
 */
function collectForeignEntries(
  root: string,
  uid: number,
  filesystem: OwnershipFilesystem,
  budget: { left: number },
  exempt: readonly string[],
  found: Map<string, number>,
  shallow: Map<string, number>,
): boolean {
  const pending = [root];
  while (pending.length > 0) {
    const path = pending.pop() as string;
    if (exempt.some((subtree) => within(path, subtree))) continue;
    if (budget.left <= 0) return false;
    budget.left -= 1;
    let stats: ReturnType<OwnershipFilesystem["lstat"]>;
    try {
      stats = filesystem.lstat(path);
    } catch {
      continue;
    }
    const directory = stats.isDirectory() && !stats.isSymbolicLink();
    if (stats.uid !== uid) {
      const enclosesExempt = directory && exempt.some((subtree) => subtree.startsWith(`${path}/`));
      if (!enclosesExempt) {
        found.set(path, stats.uid);
        continue;
      }
      shallow.set(path, stats.uid);
    }
    if (!directory) continue;
    let names: string[];
    try {
      names = filesystem.readdir(path);
    } catch {
      continue;
    }
    for (const name of names) pending.push(join(path, name));
  }
  return true;
}

/**
 * How the deployment's user (UID and GID in .env) disagrees with the checkout's
 * owner, the uid running this check, the stack's running containers and the
 * host paths those containers write. Only services Compose runs as a user are
 * compared, and only their writable bind mounts under infra/docker; what a
 * service that runs as its image's own user writes is left out, also where an
 * enclosing mount reaches it.
 */
export function deploymentUserProblems(input: {
  infraDir: string;
  processUid: number | undefined;
  /** `docker compose config --format json`'s services, or null when it failed. */
  composeServices: Record<string, ComposeConfigService> | null;
  /** The user each running container was created with, by Compose service. */
  runningUsers: Map<string, string>;
  filesystem?: OwnershipFilesystem;
  /** The entries visited under writable mounts in total; see OWNERSHIP_ENTRY_LIMIT. */
  entryLimit?: number;
}): string[] {
  const problems: string[] = [];
  let assigned: { uid?: number; gid?: number };
  try {
    assigned = coreServices.readDeploymentUserAssignments(input.infraDir);
  } catch (error) {
    return [(error as Error).message];
  }
  const owner = coreServices.checkoutOwner(input.infraDir);
  if (assigned.uid === undefined || assigned.gid === undefined) {
    problems.push(
      `infra/docker/.env sets no ${assigned.uid === undefined ? "UID" : "GID"}: the next render writes UID and GID from the checkout's owner (uid ${owner.uid}, gid ${owner.gid}). Run \`pnpm openmapx compose render\`.`,
    );
    return problems;
  }
  const { uid, gid } = assigned as { uid: number; gid: number };
  if (uid !== owner.uid) {
    problems.push(
      `UID in infra/docker/.env is ${uid}, but the checkout belongs to uid ${owner.uid}: the stack's containers would not own the files they share with the checkout.`,
    );
  }
  if (input.processUid !== undefined && input.processUid !== uid) {
    problems.push(
      `This check runs as uid ${input.processUid}, not as the deployment's user (UID=${uid}): run renders and stack commands as that user.`,
    );
  }
  if (input.composeServices === null) return problems;
  const filesystem = input.filesystem ?? hostFilesystem;
  const budget = { left: input.entryLimit ?? OWNERSHIP_ENTRY_LIMIT };
  const writable = (volume: { type?: unknown; source?: unknown; read_only?: unknown }) =>
    volume.type === "bind" &&
    typeof volume.source === "string" &&
    volume.read_only !== true &&
    volume.source.startsWith(`${input.infraDir}/`);
  const mounts: string[] = [];
  // What a service without a user writes, its image's own user owns (valhalla's
  // OSM extracts, overpass's database): not compared, wherever an enclosing
  // mount of a service with a user reaches it. A read-only mount exempts nothing.
  const exempt: string[] = [];
  for (const [service, config] of Object.entries(input.composeServices)) {
    const runsAsUser = typeof config.user === "string" && config.user !== "";
    if (runsAsUser) {
      const running = input.runningUsers.get(service);
      if (running !== undefined && running !== config.user) {
        problems.push(
          `${service} runs as ${running ? `"${running}"` : "its image's default user"}, not "${config.user}": recreate it with \`pnpm openmapx services update ${service}\`.`,
        );
      }
    }
    for (const volume of config.volumes ?? []) {
      if (!writable(volume)) continue;
      const list = runsAsUser ? mounts : exempt;
      if (!list.includes(volume.source as string)) list.push(volume.source as string);
    }
  }
  // Mounts another one encloses are walked with it, once.
  const roots = mounts
    .sort((left, right) => left.length - right.length)
    .filter(
      (mount, index, sorted) => !sorted.slice(0, index).some((outer) => within(mount, outer)),
    );
  // An earlier release's containers wrote files as uid 1000 inside directories
  // the operator owns; Docker creates a missing bind source as root.
  const foreign = new Map<string, number>();
  const shallow = new Map<string, number>();
  const unchecked: string[] = [];
  for (const root of roots) {
    if (!collectForeignEntries(root, uid, filesystem, budget, exempt, foreign, shallow))
      unchecked.push(root);
  }
  if (shallow.size > 0) {
    const paths = [...shallow.keys()].sort();
    const shown = paths.slice(0, FOREIGN_ENTRY_DISPLAY_LIMIT);
    const more =
      paths.length > shown.length ? `; ${paths.length - shown.length} more are not shown` : "";
    problems.push(
      `${paths.length} director${paths.length === 1 ? "y" : "ies"} that containers running as ${uid}:${gid} write belong${paths.length === 1 ? "s" : ""} to another uid but hold${paths.length === 1 ? "s" : ""} data a service running as its image's user writes: ${shown.map((path) => `${displayPath(relative(input.infraDir, path))} (uid ${shallow.get(path)})`).join(", ")}${more}. Change the owner of the director${paths.length === 1 ? "y" : "ies"} alone, as root, not recursively: ${commandNote(chownCommand(`${uid}:${gid}`, shown, false))}`,
    );
  }
  if (foreign.size > 0) {
    const paths = [...foreign.keys()].sort();
    const shown = paths.slice(0, FOREIGN_ENTRY_DISPLAY_LIMIT);
    const more =
      paths.length > shown.length
        ? `; ${paths.length - shown.length} more are not shown, run check again once these are fixed`
        : "";
    problems.push(
      `${paths.length} path${paths.length === 1 ? "" : "s"} that containers running as ${uid}:${gid} write belong${paths.length === 1 ? "s" : ""} to another uid, which they cannot change: ${shown.map((path) => `${displayPath(relative(input.infraDir, path))} (uid ${foreign.get(path)})`).join(", ")}${more}. Fix once, as root: ${commandNote(chownCommand(`${uid}:${gid}`, shown, true))}`,
    );
  }
  if (unchecked.length > 0) {
    problems.push(
      `Stopped checking ownership after ${input.entryLimit ?? OWNERSHIP_ENTRY_LIMIT} entries; not fully checked: ${unchecked.map((mount) => relative(input.infraDir, mount)).join(", ")}. If containers fail to write there, change the owner of what they cannot write the same way.`,
    );
  }
  return problems;
}

/** The user each running stack container was created with, by Compose service. */
async function runningContainerUsers(names: string[]): Promise<Map<string, string>> {
  const users = new Map<string, string>();
  if (names.length === 0) return users;
  const result = await execa(
    "docker",
    [
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.service"}}\t{{.Config.User}}',
      ...names,
    ],
    { reject: false },
  );
  if (result.exitCode !== 0) return users;
  for (const line of String(result.stdout ?? "").split("\n")) {
    const [service, user = ""] = line.split("\t");
    if (service) users.set(service, user.trim());
  }
  return users;
}

export function registerCheckCommand(program: Command): void {
  program
    .command("check")
    .description("Run health checks against running services")
    .option("--no-probe", "Skip in-network HTTP deep probes (faster; engine-health only)")
    .action(async (options: { probe: boolean }) => {
      const envPath = join(repoPaths().infraDir, ".env");
      let envMode: number | null = null;
      try {
        envMode = statSync(envPath).mode;
      } catch {
        // A missing local .env is handled by compose; this advisory stays non-fatal.
      }
      const stateErrors = deploymentStateErrors(repoPaths().infraDir);
      for (const error of stateErrors) log.err(error);
      const permissionWarning =
        coreServices.deploymentEnvironmentFileProblem(envPath) === null
          ? envFilePermissionWarning(envPath, envMode)
          : null;
      if (permissionWarning) log.warn(permissionWarning);
      // Only the ops-agent's fixed CLI runs embedded manifests; from source the
      // checkout is what runs, so there is nothing to compare.
      const drift = coreServices.describeBuiltInServiceDrift(
        coreServices.inspectBuiltInServiceDrift(repoPaths().root),
      );
      if (drift) log.warn(drift);
      // Integrations the operations agent installed are trusted by its records;
      // only its fixed CLI reads them, so a check from source has none to report.
      for (const warning of installedIntegrationWarnings(repoPaths().root)) log.warn(warning);
      // The render reports a key file it did not copy once; this repeats it
      // while the keys are still missing.
      const keysLeftBehind = transitousApiKeysLeftBehindWarning();
      if (keysLeftBehind) log.warn(keysLeftBehind);

      const result = await dockerComposeAfterDeploymentSecretCheck(["ps", "--format", "json"]);
      if (result.exitCode !== 0) {
        log.err(result.stderr || "docker compose ps failed");
        process.exit(result.exitCode);
      }

      let rows: PsLine[];
      try {
        rows = coreServices.parseComposePsJson(result.stdout) as PsLine[];
      } catch (error) {
        log.err(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }

      // The deployment's user against the checkout, this process, the
      // running containers and the paths they write.
      const config = await dockerCompose(["config", "--format", "json"]);
      let composeServices: Record<string, ComposeConfigService> | null = null;
      if (config.exitCode === 0) {
        try {
          composeServices =
            (JSON.parse(config.stdout) as { services?: Record<string, ComposeConfigService> })
              .services ?? {};
        } catch {
          composeServices = null;
        }
      }
      const runningUsers = await runningContainerUsers(
        rows
          .filter((row) => row.State === "running" && typeof row.Name === "string")
          .map((row) => row.Name as string),
      );
      for (const problem of deploymentUserProblems({
        infraDir: repoPaths().infraDir,
        processUid: process.geteuid?.(),
        composeServices,
        runningUsers,
      })) {
        log.err(problem);
      }

      if (rows.length === 0) {
        log.warn("No compose services found in the current project.");
        return;
      }

      const network = options.probe ? await detectComposeNetwork() : "";

      type Report = {
        service: string;
        state: string;
        health: string;
        status: string;
        probe: string;
      };
      const report: Report[] = [];

      for (const row of rows) {
        const service = row.Service ?? "(unknown)";
        const state = (row.State ?? "unknown").toLowerCase();
        const health = (row.Health ?? "").toLowerCase();

        let status = "ok";
        if (state !== "running") status = "not-running";
        else if (health === "unhealthy") status = "unhealthy";
        else if (health === "starting") status = "starting";

        let probeDetail = "—";
        if (options.probe && state === "running" && health !== "starting") {
          const r = await runDeepProbe(service, network);
          probeDetail = r.status === "ok" ? "ok" : `${r.status}: ${r.detail}`;
          if (r.status === "fail" && status === "ok") status = "probe-fail";
        }

        report.push({
          service,
          state,
          health: health || "—",
          status,
          probe: probeDetail,
        });
      }

      console.log(
        table(
          [
            { key: "service", header: "Service" },
            { key: "state", header: "State" },
            { key: "health", header: "Health" },
            { key: "probe", header: "Probe" },
            { key: "status", header: "Status" },
          ],
          report,
        ),
      );

      const failures = report.filter(
        (row) =>
          row.status === "unhealthy" || row.status === "probe-fail" || row.state === "restarting",
      );
      const starting = report.filter((row) => row.status === "starting");
      const stopped = report.filter((row) => row.status === "not-running");

      if (stopped.length > 0) {
        log.warn(
          `${stopped.length} service${stopped.length === 1 ? "" : "s"} not running (skipped).`,
        );
      }
      if (starting.length > 0) {
        log.warn(`${starting.length} service${starting.length === 1 ? "" : "s"} still starting.`);
      }
      if (failures.length > 0) {
        log.err(
          `${failures.length} service${failures.length === 1 ? "" : "s"} unhealthy, restarting, or failing app-level probe.`,
        );
        process.exit(1);
      }

      log.ok("All running services look healthy.");
    });
}
