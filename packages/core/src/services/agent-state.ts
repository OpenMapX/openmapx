import { lstatSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

/**
 * Where the operations agent keeps its own state: the job journal, the
 * self-update handoff record, the trusted-configuration snapshot queue it
 * shares with app-api, and its privacy-extraction scratch.
 *
 * It lives in `infra/docker/state/ops-agent`, beside `infra/docker/data`
 * rather than inside it: data-manager mounts the whole data directory
 * read-write as the same uid, so nothing there can be the agent's.
 */
export interface AgentStatePaths {
  directory: string;
  journal: string;
  handoff: string;
  trustedConfig: string;
  privacyExtraction: string;
  /** Written once the agent has imported, or declined, what the old location held. */
  legacyImport: string;
}

export function agentStatePaths(infraDir: string): AgentStatePaths {
  const directory = join(infraDir, "state", "ops-agent");
  return {
    directory,
    journal: join(directory, "jobs-v1.json"),
    handoff: join(directory, "agent-handoff.json"),
    trustedConfig: join(directory, "trusted-config"),
    privacyExtraction: join(directory, "privacy-extraction"),
    legacyImport: join(directory, "legacy-import.json"),
  };
}

/** The same state where releases before it kept it, inside data-manager's mount. */
export function legacyAgentStatePaths(infraDir: string) {
  const directory = join(infraDir, "data", "ops-agent");
  return {
    directory,
    journal: join(directory, "jobs-v1.json"),
    handoff: join(directory, "agent-handoff.json"),
    trustedConfig: join(directory, "trusted-config"),
    privacyExtraction: join(infraDir, "data", "privacy-extraction"),
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
 * Prepares the directories containers bind-mount from the agent's state: the
 * trusted-configuration queue and the privacy-extraction scratch. Run by every
 * configuration generation commit, under the writer lock, because that is
 * where their mounts move from the old location to the new one.
 *
 * An old directory is renamed rather than copied: a container still running
 * with the old mount (the agent after a self-update, app-api until it is
 * recreated) keeps the same directory. Anything other than a real directory at
 * the old path is left alone, and a missing target is created owner-only.
 */
export function prepareAgentStateDirectories(infraDir: string): void {
  const current = agentStatePaths(infraDir);
  const legacy = legacyAgentStatePaths(infraDir);
  mkdirSync(current.directory, { recursive: true, mode: 0o700 });
  for (const [from, to] of [
    [legacy.trustedConfig, current.trustedConfig],
    [legacy.privacyExtraction, current.privacyExtraction],
  ] as const) {
    if (entryKind(to) === "missing" && entryKind(from) === "directory") renameSync(from, to);
    if (entryKind(to) === "missing") mkdirSync(to, { mode: 0o700 });
  }
}
