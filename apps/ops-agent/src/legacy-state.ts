import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@openmapx/core/release-files";
import { services } from "@openmapx/core/server";
import { isTerminalHandoff, readAgentHandoffFile, writeAgentHandoff } from "./agent-handoff";
import { readOpsJobJournalSnapshot } from "./journal";

const UNFINISHED = new Set(["queued", "running", "termination_pending"]);
/**
 * An agent runs at most four operations at once. A journal with more
 * unfinished jobs than this was not left by one; importing it would fill the
 * job table with records that are never pruned and refuse every operation.
 */
const MAX_IMPORTED_UNFINISHED = 16;

/**
 * Releases before the agent's state moved to `infra/docker/state/ops-agent`
 * kept its journal and handoff record in `infra/docker/data/ops-agent`, which
 * data-manager can write. The first agent of this release imports them once,
 * then never reads that location again.
 *
 * - The jobs the previous agent left unfinished are copied, so they keep
 *   their records; its finished history is not. The old copy stays until no
 *   handoff helper is running: a helper that rolls back to the previous agent
 *   hands it its own journal.
 * - The handoff record is imported only while a helper container labelled
 *   with its ID runs, which proves a self-update into this agent is under way.
 *   Any other record there is discarded unread: its previous overlay would be
 *   restored on a rollback, and data-manager could have written it.
 */

export type LegacyImportOutcome = "imported" | "absent" | "discarded";

export interface LegacyStateImport {
  journal: LegacyImportOutcome;
  handoff: LegacyImportOutcome;
}

export interface LegacyStateOptions {
  rootDir: string;
  /** Whether a handoff helper container runs: for `handoffId`, or any at all. */
  handoffHelperRunning(handoffId?: string): Promise<boolean>;
  /** Whether any container, running or stopped, bind-mounts `path`. */
  containerMounts?(path: string): Promise<boolean>;
  /** Receives why an earlier directory was left in place. */
  report?(message: string): void;
}

function isRegularFile(path: string): boolean {
  try {
    const metadata = lstatSync(path);
    return metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function paths(rootDir: string) {
  const infraDir = join(rootDir, "infra", "docker");
  return {
    current: services.agentStatePaths(infraDir),
    legacy: services.legacyAgentStatePaths(infraDir),
  };
}

/** Imports the previous location's state once; later calls change nothing. */
export async function importLegacyAgentState(
  options: LegacyStateOptions,
): Promise<LegacyStateImport | null> {
  const { current, legacy } = paths(options.rootDir);
  mkdirSync(current.directory, { recursive: true, mode: 0o700 });
  if (exists(current.legacyImport)) return null;

  let journal: LegacyImportOutcome = "absent";
  if (isRegularFile(legacy.journal) && !exists(current.journal)) {
    try {
      // Only jobs the previous agent left unfinished. Opening the journal
      // turns each into a failed, recovery-required record, so the API learns
      // how it ended; none is run again. A finished record is not imported:
      // data-manager could have written its result, which would then answer
      // a lookup or a replayed submission in place of a real run.
      const unfinished = (await readOpsJobJournalSnapshot(legacy.journal)).filter((job) =>
        UNFINISHED.has(job.state),
      );
      if (unfinished.length > MAX_IMPORTED_UNFINISHED) throw new Error("implausible journal");
      atomicWrite(current.journal, JSON.stringify({ version: 1, jobs: unfinished }));
      journal = "imported";
    } catch {
      journal = "discarded";
    }
  }

  let handoff: LegacyImportOutcome = "absent";
  if (exists(legacy.handoff) && !exists(current.handoff)) {
    handoff = "discarded";
    try {
      const record = readAgentHandoffFile(legacy.handoff);
      if (
        record &&
        !isTerminalHandoff(record.phase) &&
        (await options.handoffHelperRunning(record.handoffId))
      ) {
        // Only its identity and phase are taken over. Its previous overlay is
        // not: a rollback would restore it, and data-manager can write the
        // file. A release application after this handoff derives its rollback
        // target from the agent's own release state instead.
        writeAgentHandoff(options.rootDir, {
          ...record,
          previousOverlay: null,
          importedFromLegacy: true,
        });
        handoff = "imported";
      }
    } catch {
      // Unreadable or unverifiable: nothing is imported.
    }
  }

  const outcome: LegacyStateImport = { journal, handoff };
  atomicWrite(
    current.legacyImport,
    `${JSON.stringify({ version: 1, ...outcome, importedAt: new Date().toISOString() })}\n`,
  );
  return outcome;
}

/** A real directory of this user, not a link: what this agent may remove. */
function ownDirectory(path: string): "missing" | "own" | string {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return `it cannot be inspected (${(error as NodeJS.ErrnoException).code ?? "error"})`;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "it is not a directory";
  const uid = process.geteuid?.();
  if (uid !== undefined && metadata.uid !== uid) {
    return `it belongs to uid ${metadata.uid}, not ${uid}`;
  }
  return "own";
}

/**
 * Removes the trusted-configuration queue and the privacy-extraction scratch
 * an earlier release kept in the data directory, once their state has moved:
 * each goes only when its replacement in the agent's state exists, no
 * container still mounts it, it is a directory of this user, and it is empty
 * (the queue may hold its own empty `.claimed`). rmdir refuses a directory
 * that is not empty, so an entry written meanwhile keeps it. Anything else
 * stays, and why is reported.
 */
async function retireLegacyAgentDirectories(options: LegacyStateOptions): Promise<void> {
  const { current, legacy } = paths(options.rootDir);
  const report = options.report ?? (() => undefined);
  for (const [directory, replacement, allowed] of [
    [legacy.trustedConfig, current.trustedConfig, [".claimed"]],
    [legacy.privacyExtraction, current.privacyExtraction, []],
  ] as const) {
    const leave = (reason: string) =>
      report(`Left the earlier directory ${directory} in place: ${reason}`);
    const kind = ownDirectory(directory);
    if (kind === "missing") continue;
    if (kind !== "own") {
      leave(kind);
      continue;
    }
    if (ownDirectory(replacement) !== "own") {
      leave(`its replacement ${replacement} is not in place yet`);
      continue;
    }
    try {
      if (await options.containerMounts?.(directory)) {
        leave("a container still mounts it; it goes once that container is recreated");
        continue;
      }
    } catch {
      leave("whether a container still mounts it could not be checked");
      continue;
    }
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      leave("it cannot be listed");
      continue;
    }
    const other = entries.filter((name) => !(allowed as readonly string[]).includes(name));
    if (other.length > 0) {
      leave(`it is not empty (${other.slice(0, 5).join(", ")}${other.length > 5 ? ", …" : ""})`);
      continue;
    }
    try {
      for (const name of entries) {
        const nested = join(directory, name);
        const nestedKind = ownDirectory(nested);
        if (nestedKind !== "own") throw new Error(`${name}: ${nestedKind}`);
        rmdirSync(nested);
      }
      rmdirSync(directory);
    } catch (error) {
      leave((error as Error).message);
    }
  }
}

/**
 * Removes the journal and handoff record left at the previous location once
 * they were imported and no helper could still roll back to an agent that
 * reads them, and the earlier queue and scratch directories once empty. Only
 * plain entries are unlinked; the directory goes when empty.
 */
export async function retireLegacyAgentState(options: LegacyStateOptions): Promise<boolean> {
  const { current, legacy } = paths(options.rootDir);
  if (!exists(current.legacyImport)) return false;
  let helperRunning: boolean;
  try {
    helperRunning = await options.handoffHelperRunning();
  } catch {
    return false;
  }
  if (helperRunning) return false;
  await retireLegacyAgentDirectories(options);
  let names: string[];
  try {
    names = readdirSync(legacy.directory);
  } catch {
    return true;
  }
  // The files themselves, and the temporaries their writers leave behind.
  const leftovers =
    /^(?:jobs-v1\.json|agent-handoff\.json)(?:\.tmp-.+)?$|^\.jobs-v1\.json\.[a-f0-9]{24}\.tmp$/;
  for (const name of names) {
    if (!leftovers.test(name)) continue;
    try {
      unlinkSync(join(legacy.directory, name));
    } catch {
      // Already gone, or not ours to remove.
    }
  }
  try {
    rmdirSync(legacy.directory);
  } catch {
    // Not empty: an earlier queue left in place, or something an operator keeps.
  }
  return true;
}
