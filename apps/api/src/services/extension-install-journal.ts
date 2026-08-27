import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  discardInstalledIntegrationBackup,
  type IntegrationRollbackBackup,
  removeIntegration,
  restoreInstalledIntegration,
} from "@openmapx/integration-framework/installer";

const JOURNAL_PREFIX = ".extension-install-journal-";
const JOURNAL_RE = /^\.extension-install-journal-[a-f0-9]{24}\.json$/;

type EntryPhase = "prepared" | "installed" | "restoring" | "restored";

interface JournalEntry {
  id: string;
  backupDirectory: string | null;
  phase: EntryPhase;
}

export interface ExtensionInstallJournalData {
  schemaVersion: 1;
  extensionId: string;
  targetManifest: Record<string, unknown>;
  integrations: JournalEntry[];
}

export interface ExtensionInstallJournal {
  path: string;
  data: ExtensionInstallJournalData;
}

function customDir(rootDir: string): string {
  return join(rootDir, "custom_integrations");
}

function persist(journal: ExtensionInstallJournal): void {
  const temporary = `${journal.path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(journal.data, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, journal.path);
}

export function createExtensionInstallJournal(
  rootDir: string,
  extensionId: string,
  targetManifest: Record<string, unknown>,
): ExtensionInstallJournal {
  mkdirSync(customDir(rootDir), { recursive: true });
  const path = join(customDir(rootDir), `${JOURNAL_PREFIX}${randomBytes(12).toString("hex")}.json`);
  const journal: ExtensionInstallJournal = {
    path,
    data: { schemaVersion: 1, extensionId, targetManifest, integrations: [] },
  };
  persist(journal);
  return journal;
}

export function appendIntegrationJournalEntry(
  journal: ExtensionInstallJournal,
  entry: { id: string; backupDirectory: string | null },
): void {
  if (journal.data.integrations.some((candidate) => candidate.id === entry.id)) {
    throw new Error(`Integration ${entry.id} is already present in the extension install journal`);
  }
  journal.data.integrations.push({ ...entry, phase: "prepared" });
  persist(journal);
}

export function markIntegrationJournalEntryInstalled(
  journal: ExtensionInstallJournal,
  id: string,
): void {
  const entry = journal.data.integrations.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Integration ${id} is missing from the extension install journal`);
  entry.phase = "installed";
  persist(journal);
}

export function markExtensionInstallJournalRestoring(journal: ExtensionInstallJournal): void {
  for (const entry of journal.data.integrations) {
    if (entry.phase !== "restored") entry.phase = "restoring";
  }
  persist(journal);
}

function readJournal(path: string): ExtensionInstallJournal {
  if (!JOURNAL_RE.test(basename(path))) throw new Error("Invalid extension install journal path");
  const data = JSON.parse(readFileSync(path, "utf8")) as ExtensionInstallJournalData;
  if (
    data.schemaVersion !== 1 ||
    typeof data.extensionId !== "string" ||
    !data.targetManifest ||
    typeof data.targetManifest !== "object" ||
    !Array.isArray(data.integrations)
  ) {
    throw new Error(`Invalid extension install journal ${basename(path)}`);
  }
  return { path, data };
}

export async function reconcileExtensionInstallJournal(
  rootDir: string,
  path: string,
  isBookkeepingCommitted: (journal: ExtensionInstallJournalData) => Promise<boolean>,
): Promise<void> {
  const journal = readJournal(path);
  if (await isBookkeepingCommitted(journal.data)) {
    for (const entry of journal.data.integrations) {
      if (entry.backupDirectory && existsSync(entry.backupDirectory)) {
        discardInstalledIntegrationBackup(rootDir, {
          id: entry.id,
          backupDirectory: entry.backupDirectory,
        });
      }
    }
    rmSync(path, { force: true });
    return;
  }

  for (const entry of [...journal.data.integrations].reverse()) {
    const target = join(customDir(rootDir), entry.id);
    if (entry.phase === "restored") continue;
    const previousPhase = entry.phase;
    if (
      entry.backupDirectory &&
      !existsSync(entry.backupDirectory) &&
      (previousPhase !== "restoring" || !existsSync(target))
    ) {
      throw new Error(`Integration rollback backup is missing for ${entry.id}`);
    }
    entry.phase = "restoring";
    persist(journal);
    if (entry.backupDirectory) {
      const backup: IntegrationRollbackBackup = {
        id: entry.id,
        backupDirectory: entry.backupDirectory,
      };
      if (existsSync(entry.backupDirectory)) restoreInstalledIntegration(rootDir, backup);
    } else if (existsSync(target)) {
      removeIntegration({ rootDir, id: entry.id });
    }
    entry.phase = "restored";
    persist(journal);
  }
  rmSync(path, { force: true });
}

export async function reconcileExtensionInstallJournals(
  rootDir: string,
  isBookkeepingCommitted: (journal: ExtensionInstallJournalData) => Promise<boolean>,
): Promise<void> {
  const directory = customDir(rootDir);
  if (!existsSync(directory)) return;
  const journals = readdirSync(directory)
    .filter((name) => JOURNAL_RE.test(name))
    .sort();
  for (const name of journals) {
    const path = join(directory, name);
    try {
      await reconcileExtensionInstallJournal(rootDir, path, isBookkeepingCommitted);
    } catch (error) {
      throw new Error(
        `Extension install journal ${path} could not be reconciled: ${(error as Error).message}. ` +
          "If its integration backups were removed deliberately, delete this journal and restart.",
        { cause: error },
      );
    }
  }
}
