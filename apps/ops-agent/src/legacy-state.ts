import { lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite } from "@openmapx/core/release-files";
import { services } from "@openmapx/core/server";
import { isTerminalHandoff, readAgentHandoffFile, writeAgentHandoff } from "./agent-handoff";
import { readOpsJobJournalSnapshot } from "./journal";

const UNFINISHED = new Set(["queued", "running", "termination_pending"]);

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

/**
 * Removes the journal and handoff record left at the previous location once
 * they were imported and no helper could still roll back to an agent that
 * reads them. Only plain entries are unlinked; the directory goes when empty.
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
    // Not empty: an old trusted-config directory, or something an operator keeps.
  }
  return true;
}
