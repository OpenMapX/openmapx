import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWrite } from "../release-files";
import {
  DEFAULT_SELECTED_SERVICE_IDS,
  normalizeServiceIds,
  parseServiceIdList,
  SERVICE_SELECTION_ENV,
} from "./selection";

/**
 * The deployment has two pieces of state, shared by the CLI and the admin
 * panel alike: the selection an operator wants (`service-selection.json`,
 * overridden by `OPENMAPX_ENABLED_SERVICES`) and the configuration generation
 * that was applied (the `current` pointer). Every render reads the first and
 * writes the second; every stack command runs against the second.
 *
 * Both live in the operations agent's state directory, which only its user can
 * reach, so nothing in them is trusted because of `infra/docker`'s own modes.
 * The host CLI runs as that user and shares them. Paths are relative to
 * `infra/docker`.
 */
export const SERVICE_SELECTION_FILE = "service-selection.json";
export const CONFIGURATION_DIRECTORY = "state/ops-agent/configuration";
export const CURRENT_CONFIGURATION = `${CONFIGURATION_DIRECTORY}/current`;
export const CONFIGURATION_GENERATIONS = `${CONFIGURATION_DIRECTORY}/generations`;
/** Where releases before this one kept them, in `infra/docker` itself. */
export const LEGACY_CURRENT_CONFIGURATION = ".trusted-config-current";
export const LEGACY_CONFIGURATION_GENERATIONS = ".trusted-config-generations";
export const LEGACY_SERVICE_SELECTION_FILE = SERVICE_SELECTION_FILE;
export const GENERATED_COMPOSE_FILE = "docker-compose.generated.yml";
export const GENERATED_HARDLINK_PLAN_FILE = "docker-compose.generated.hardlinks.json";
export const CONFIGURATION_GENERATION_BASE_PREFIX = `${CONFIGURATION_DIRECTORY}/.base-`;

export function configurationGenerationBasePath(infraDir: string, revisionId: string): string {
  if (!/^cfg1_[A-Za-z0-9_-]{43}$/.test(revisionId))
    throw new Error("Unsafe generation Compose base");
  return join(infraDir, `${CONFIGURATION_GENERATION_BASE_PREFIX}${revisionId}`);
}
/** A fixed same-depth alias preserves legacy relative paths and pins its own secrets. */
export function readConfigurationGenerationBase(infraDir: string, revisionId: string): string {
  const base = configurationGenerationBasePath(infraDir, revisionId),
    stat = lstatSync(base);
  if (
    !stat.isSymbolicLink() ||
    stat.uid !== (process.geteuid?.() ?? 0) ||
    stat.nlink !== 1 ||
    readlinkSync(base) !== `generations/${revisionId}`
  )
    throw new Error("Unsafe generation Compose base");
  return base;
}

/**
 * The Compose project of the stack, written into the generated compose file:
 * the name Compose gave `infra/docker` before the file moved into generations.
 */
export const STACK_PROJECT = "docker";

export interface StackPaths {
  infraDir: string;
  /** The applied generation's compose file. */
  composePath: string;
  composeReleasePath: string;
}

export function currentConfigurationFile(infraDir: string, name: string): string {
  return join(infraDir, CURRENT_CONFIGURATION, name);
}

/**
 * The `docker` arguments that address the stack. Compose reads `.env` from the
 * first file's directory, which for a generation is not `infra/docker`, so the
 * deployment environment is named explicitly.
 */
export function stackComposeArgs(
  paths: StackPaths,
  fileExists?: (path: string) => boolean,
): string[] {
  const envFile = join(paths.infraDir, ".env");
  const hasEnvFile = (fileExists ?? existsSync)(envFile);
  if (hasEnvFile) {
    assertDeploymentEnvironmentFile(envFile);
    const inherited = deploymentUserEnvironmentProblem(paths.infraDir);
    if (inherited) throw new Error(inherited);
  }
  const hasOverlay = (fileExists ?? ownedStateFilePresent)(paths.composeReleasePath);
  // Compose records this path in container provenance. Pin the generation,
  // rather than the movable current symlink, so deselection retains cleanup authority.
  let composePath = paths.composePath;
  let projectArgs: string[] = [];
  let existing = false;
  try {
    composePath = realpathSync(composePath);
    existing = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    const infra = realpathSync(paths.infraDir);
    if (
      dirname(dirname(composePath)) === join(infra, CONFIGURATION_GENERATIONS) &&
      basename(composePath) === GENERATED_COMPOSE_FILE
    ) {
      const base = readConfigurationGenerationBase(infra, basename(dirname(composePath)));
      if (realpathSync(base) !== dirname(composePath))
        throw new Error("Unsafe generation Compose base");
      projectArgs = ["--project-name", STACK_PROJECT, "--project-directory", base];
    }
  }
  return [
    "compose",
    ...projectArgs,
    ...(hasEnvFile ? ["--env-file", envFile] : []),
    "-f",
    composePath,
    ...(hasOverlay ? ["-f", paths.composeReleasePath] : []),
  ];
}

const DEPLOYMENT_USER_ASSIGNMENT = /^\s*(?:export\s+)?(UID|GID)\s*=\s*(.*?)\s*$/;

function parseDeploymentId(name: "UID" | "GID", raw: string, source: string): number {
  const value = raw.replace(/^(["'])(.*)\1$/, "$2");
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} in ${source} must be a numeric id, not "${raw}"`);
  }
  return Number(value);
}

/**
 * The deployment's user as `.env` assigns it, `UID` and `GID` (see
 * deployment-user.ts); commented lines don't count.
 */
export function readDeploymentUserAssignments(infraDir: string): {
  uid?: number;
  gid?: number;
} {
  const path = join(infraDir, ".env");
  const bytes = readOwnedStateFile(path, 1024 * 1024);
  if (bytes === null) return {};
  const found: { uid?: number; gid?: number } = {};
  for (const line of bytes.toString("utf8").split(/\r?\n/)) {
    const match = DEPLOYMENT_USER_ASSIGNMENT.exec(line);
    if (!match) continue;
    const id = parseDeploymentId(match[1] as "UID" | "GID", match[2] as string, path);
    if (match[1] === "UID") found.uid = id;
    else found.gid = id;
  }
  return found;
}

/**
 * Compose takes a variable from its own environment over `--env-file`, so a
 * UID or GID this process inherited would replace `.env`'s for every stack
 * container. `.env` is the deployment's: an inherited value that differs is
 * refused, with the fix.
 */
export function deploymentUserEnvironmentProblem(
  infraDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const assigned = readDeploymentUserAssignments(infraDir);
  for (const [name, value] of [
    ["UID", assigned.uid],
    ["GID", assigned.gid],
  ] as const) {
    const inherited = env[name]?.trim();
    if (value === undefined || !inherited || inherited === String(value)) continue;
    return `${name}=${inherited} in this process's environment differs from ${name}=${value} in infra/docker/.env, and Compose would run the stack's containers with the environment's: unset ${name} in the environment, or set it in infra/docker/.env`;
  }
  return null;
}

/**
 * Whether a file of the agent's state is there: false when it is missing, and
 * true only for a regular file of this user with one link and no group or
 * other write. Anything else in its place is refused, never passed on.
 */
export function ownedStateFilePresent(path: string): boolean {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const owner = process.geteuid?.();
  if (
    !stats.isFile() ||
    stats.nlink !== 1 ||
    (owner !== undefined && stats.uid !== owner) ||
    (stats.mode & 0o022) !== 0
  ) {
    throw new Error(
      `${path} must be a regular file owned by uid ${owner}, with one link and no group or other write`,
    );
  }
  return true;
}

/**
 * `infra/docker/.env` holds the deployment's credentials and settings, and
 * Compose interpolates it into every service. Like a file under `secrets/`, it
 * must be a regular file owned by the operator's user, with one link and no
 * group or other write. Anything else is refused, never repaired: the
 * operator decides what it holds. Git never writes it.
 */
export function deploymentEnvironmentFileProblem(path: string): string | null {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const owner = process.geteuid?.();
  const problems: string[] = [];
  if (!stats.isFile() || stats.isSymbolicLink()) problems.push("is not a regular file");
  if (owner !== undefined && stats.uid !== owner) {
    problems.push(`is owned by uid ${stats.uid}, not ${owner}`);
  }
  if (stats.nlink !== 1) problems.push("has more than one link");
  if ((stats.mode & 0o022) !== 0) {
    problems.push(`is writable by its group or others (mode 0${(stats.mode & 0o777).toString(8)})`);
  }
  if (problems.length === 0) return null;
  return `${path} ${problems.join(", ")}. It must be a regular file owned by the deployment's user with no group or other write; fix it with: chown $(id -u) ${path} && chmod 600 ${path}`;
}

export function assertDeploymentEnvironmentFile(path: string): void {
  const problem = deploymentEnvironmentFileProblem(path);
  if (problem) throw new Error(problem);
}

export type DesiredSelectionSource = "env" | "file" | "default";

export interface DesiredSelection {
  source: DesiredSelectionSource;
  roots: string[];
}

export function serviceSelectionPath(infraDir: string): string {
  return join(infraDir, "state", "ops-agent", SERVICE_SELECTION_FILE);
}

/**
 * A file of the agent's state, as only its user writes them: a regular file of
 * at most `maxBytes`, owned by the current user, one link, no group or other
 * write. Opened without following a symbolic link. Null when it is missing.
 */
export function readOwnedStateFile(path: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`${path} must be a regular file, not a symbolic link`);
  }
  try {
    const stats = fstatSync(fd);
    const owner = process.geteuid?.();
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (owner !== undefined && stats.uid !== owner) ||
      (stats.mode & 0o022) !== 0 ||
      stats.size > maxBytes
    ) {
      throw new Error(
        `${path} must be a regular file owned by uid ${owner}, with one link and no group or other write`,
      );
    }
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The roots in `service-selection.json`, or null when there is no file. */
export function readServiceSelectionFile(infraDir: string): string[] | null {
  const path = serviceSelectionPath(infraDir);
  const bytes = readOwnedStateFile(path, 64 * 1024);
  if (bytes === null) return null;
  const raw = JSON.parse(bytes.toString("utf-8")) as { selected?: unknown };
  if (!Array.isArray(raw.selected) || raw.selected.some((id) => typeof id !== "string")) {
    throw new Error(`Malformed service selection file at ${path}: expected "selected" array`);
  }
  return normalizeServiceIds(raw.selected as string[]);
}

/**
 * The selection a render applies: the operator's `OPENMAPX_ENABLED_SERVICES`,
 * else `service-selection.json`, else the defaults.
 */
export function readDesiredSelection(
  infraDir: string,
  env: NodeJS.ProcessEnv = process.env,
): DesiredSelection {
  const fromEnv = parseServiceIdList(env[SERVICE_SELECTION_ENV]);
  if (fromEnv) return { source: "env", roots: fromEnv };
  const fromFile = readServiceSelectionFile(infraDir);
  if (fromFile) return { source: "file", roots: fromFile };
  return { source: "default", roots: [...DEFAULT_SELECTED_SERVICE_IDS] };
}

/**
 * The config schema of every integration in the checkout, by id: the same
 * set the ops-agent reads, so both renders pass the same integration settings
 * through to app-api.
 */
export function loadIntegrationSchemas(rootDir: string): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  const installed = join(rootDir, "infra", "docker", "state", "ops-agent", "custom-integrations");
  for (const base of [join(rootDir, "integrations"), installed]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.name.startsWith("_") || !entry.isDirectory()) continue;
      const path = join(base, entry.name, "manifest.json");
      if (!existsSync(path)) continue;
      const manifest = JSON.parse(readFileSync(path, "utf-8")) as {
        id?: unknown;
        configSchema?: unknown;
      };
      if (manifest.id !== entry.name) continue;
      const schema = manifest.configSchema ?? {};
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        found.set(entry.name, schema as Record<string, unknown>);
      }
    }
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)));
}

/** Replace `service-selection.json` atomically. */
export function writeServiceSelectionFile(infraDir: string, roots: Iterable<string>): void {
  const path = serviceSelectionPath(infraDir);
  mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
  atomicWrite(
    path,
    `${JSON.stringify({ selected: normalizeServiceIds(roots) }, null, 2)}\n`,
    0o600,
  );
}
