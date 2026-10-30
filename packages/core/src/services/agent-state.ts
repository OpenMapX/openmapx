import { chmodSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "../release-files";

/** Replaces one of the agent's state files atomically, creating its directory (0700) first. */
export function writeAgentStateFile(infraDir: string, name: string, contents: string): void {
  const directory = join(infraDir, "state", "ops-agent");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  atomicWrite(join(directory, name), contents);
}

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
  /** The community service repositories the agent installed. */
  community: string;
  /** The integrations the agent installed; app-api mounts it read-only. */
  customIntegrations: string;
  /** Written once both stores were copied from the checkout, with what was left behind. */
  storesMigration: string;
  /** Traefik's dynamic configuration, which Traefik mounts read-only and watches. */
  traefikDynamic: string;
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
    community: join(directory, "community"),
    customIntegrations: join(directory, "custom-integrations"),
    storesMigration: join(directory, "stores-migration.json"),
    traefikDynamic: join(directory, "traefik", "dynamic"),
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
 * trusted-configuration queue, the privacy-extraction scratch and Traefik's
 * dynamic configuration. Run under
 * the writer lock by every configuration generation commit, where their mounts
 * move from the old location to the new one, and by the agent at startup.
 *
 * On the same filesystem an old directory is renamed: app-api, while it still
 * runs with the old mount, keeps the same directory as the agent. When the
 * data directory is a filesystem of its own the rename is impossible, and a
 * fresh, empty directory is created instead. Nothing is copied from the old
 * one: data-manager could have written it. The old directory is left for the
 * containers still mounting it, and a snapshot queued there is not carried
 * over; its request ends uncommitted, as any request interrupted by an update.
 * Anything other than a real directory at the old path is left alone, and a
 * missing target is created owner-only.
 */
export function prepareAgentStateDirectories(infraDir: string): void {
  const current = agentStatePaths(infraDir);
  const legacy = legacyAgentStatePaths(infraDir);
  mkdirSync(current.directory, { recursive: true, mode: 0o700 });
  for (const [from, to] of [
    [legacy.trustedConfig, current.trustedConfig],
    [legacy.privacyExtraction, current.privacyExtraction],
  ] as const) {
    if (entryKind(to) === "missing" && entryKind(from) === "directory") {
      try {
        renameSync(from, to);
      } catch (error) {
        // A data directory on its own filesystem: start from an empty one below.
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      }
    }
    // data-manager can swap the old path for a symlink between the check and
    // the rename, and Compose would mount whatever a symlink here names. So
    // what arrived is checked again: anything but a real directory of this
    // user is moved aside, never followed, and replaced by a fresh one.
    const arrived = entryKind(to) === "directory" ? lstatSync(to) : null;
    if (!arrived || arrived.uid !== process.geteuid?.()) {
      if (entryKind(to) !== "missing") {
        renameSync(to, `${to}.rejected-${process.pid}-${Date.now()}`);
      }
      mkdirSync(to, { mode: 0o700 });
    }
    chmodSync(to, 0o700);
  }
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
