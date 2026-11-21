import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../release-files";

/** Replaces one of the agent's state files atomically, creating its directory (0700) first. */
export function writeAgentStateFile(infraDir: string, name: string, contents: string): void {
  const directory = join(infraDir, "state", "ops-agent");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(join(directory, name), contents);
}

/**
 * Where the operations agent keeps its own state: the job journal and the
 * configuration candidates the API hands it.
 *
 * It lives in `infra/docker/state/ops-agent`, beside `infra/docker/data`
 * rather than inside it: data-manager mounts the whole data directory
 * read-write as the same uid, so nothing there can be the agent's.
 */
export interface AgentStatePaths {
  directory: string;
  journal: string;
  /** Prepared configuration candidates, written only by the agent. */
  configurationCandidates: string;
  /** The community service repositories the agent installed. */
  community: string;
  /** The integrations the agent installed; the API mounts it read-only. */
  customIntegrations: string;
  /** Traefik's dynamic configuration, which Traefik mounts read-only and watches. */
  traefikDynamic: string;
}

export function agentStatePaths(infraDir: string): AgentStatePaths {
  const directory = join(infraDir, "state", "ops-agent");
  return {
    directory,
    journal: join(directory, "jobs-v1.json"),
    configurationCandidates: join(directory, "configuration-candidates"),
    community: join(directory, "community"),
    customIntegrations: join(directory, "custom-integrations"),
    traefikDynamic: join(directory, "traefik", "dynamic"),
  };
}

function entryKind(path: string): "missing" | "directory" | "other" {
  try {
    const metadata = lstatSync(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink() ? "directory" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/**
 * Prepares the agent's state directory and Traefik's dynamic configuration.
 * Run under the writer lock by every configuration generation commit, and by
 * the agent at startup.
 */
export function prepareAgentStateDirectories(infraDir: string): void {
  mkdirSync(agentStatePaths(infraDir).directory, { recursive: true, mode: 0o700 });
  ensureTraefikDynamicDirectory(infraDir);
}

/**
 * Traefik's dynamic directory, which Traefik mounts read-only: in place,
 * owner-only, before a generation mounts it, so Docker never creates it as
 * root. Refuses one that is a link or not the agent's own.
 */
export function ensureTraefikDynamicDirectory(infraDir: string): string {
  const paths = agentStatePaths(infraDir);
  const parent = dirname(paths.traefikDynamic);
  mkdirSync(dirname(parent), { recursive: true, mode: 0o700 });
  for (const directory of [parent, paths.traefikDynamic]) {
    if (entryKind(directory) === "missing") mkdirSync(directory, { mode: 0o700 });
    const stats = lstatSync(directory);
    if (!stats.isDirectory() || stats.uid !== process.geteuid?.()) {
      throw new Error(
        `Traefik's dynamic directory at ${directory} is not the agent's own directory`,
      );
    }
    chmodSync(directory, 0o700);
  }
  return paths.traefikDynamic;
}
