import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
 * that was applied (`.trusted-config-current`). Every render reads the first
 * and writes the second; every stack command runs against the second.
 */
export const SERVICE_SELECTION_FILE = "service-selection.json";
export const CURRENT_CONFIGURATION = ".trusted-config-current";
export const CONFIGURATION_GENERATIONS = ".trusted-config-generations";
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
  return [
    "compose",
    ...(fileExists(envFile) ? ["--env-file", envFile] : []),
    "-f",
    paths.composePath,
    ...(fileExists(paths.composeReleasePath) ? ["-f", paths.composeReleasePath] : []),
  ];
}

export type DesiredSelectionSource = "env" | "file" | "default";

export interface DesiredSelection {
  source: DesiredSelectionSource;
  roots: string[];
}

export function serviceSelectionPath(infraDir: string): string {
  return join(infraDir, SERVICE_SELECTION_FILE);
}

/** The roots in `service-selection.json`, or null when there is no file. */
export function readServiceSelectionFile(infraDir: string): string[] | null {
  const path = serviceSelectionPath(infraDir);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf-8")) as { selected?: unknown };
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
  mkdirSync(infraDir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ selected: normalizeServiceIds(roots) }, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o644 },
  );
  renameSync(temporary, path);
}
