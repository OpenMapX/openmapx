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
} from "node:fs";
import { join } from "node:path";
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
  fileExists: (path: string) => boolean = existsSync,
): string[] {
  const envFile = join(paths.infraDir, ".env");
  const hasEnvFile = fileExists(envFile);
  if (hasEnvFile) assertDeploymentEnvironmentFile(envFile);
  return [
    "compose",
    ...(hasEnvFile ? ["--env-file", envFile] : []),
    "-f",
    paths.composePath,
    ...(fileExists(paths.composeReleasePath) ? ["-f", paths.composeReleasePath] : []),
  ];
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
  for (const base of [join(rootDir, "integrations"), join(rootDir, "custom_integrations")]) {
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
