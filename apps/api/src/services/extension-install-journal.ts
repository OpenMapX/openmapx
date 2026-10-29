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
import { basename, dirname, join, resolve } from "node:path";
import { AnchoredDirectory } from "@openmapx/core/build-artifacts";
import {
  discardInstalledIntegrationBackup,
  type IntegrationPublicationReceipt,
  type IntegrationRollbackBackup,
  inspectIntegrationPublication,
  integrationPublicationReceiptSchema,
  removeIntegration,
  restoreInstalledIntegration,
  restoreIntegrationPublication,
  settleIntegrationPublication,
} from "@openmapx/integration-framework/installer";
import z from "zod/v4";

const JOURNAL_PREFIX = ".extension-install-journal-";
const JOURNAL_RE = /^\.extension-install-journal-[a-f0-9]{24}\.json$/;

type EntryPhase = "prepared" | "installed" | "restoring" | "restored";

interface JournalEntry {
  id: string;
  backupDirectory: string | null;
  phase: EntryPhase;
  transactional?: true;
  publication?: IntegrationPublicationReceipt;
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
  if (!JOURNAL_RE.test(basename(journal.path))) throw Error("Invalid extension journal path");
  const bytes = JSON.stringify(journal.data);
  if (Buffer.byteLength(bytes) > 2 * 1024 ** 2)
    throw Error("Extension integration journal exceeds its metadata limit");
  const directory = new AnchoredDirectory(dirname(journal.path));
  try {
    directory.write(basename(journal.path), bytes);
  } finally {
    directory.close();
  }
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
  entry: { id: string; backupDirectory: string | null; transactional?: true },
): void {
  if (journal.data.integrations.some((candidate) => candidate.id === entry.id)) {
    throw new Error(`Integration ${entry.id} is already present in the extension install journal`);
  }
  journal.data.integrations.push({ ...entry, phase: "prepared" });
  persist(journal);
}

/** Called synchronously by the actual publisher before its first directory effect. */
export function recordIntegrationPublicationPrepared(
  journal: ExtensionInstallJournal,
  id: string,
  receipt: IntegrationPublicationReceipt,
): void {
  const entry = journal.data.integrations.find((candidate) => candidate.id === id);
  if (
    !entry?.transactional ||
    entry.publication ||
    receipt.integrationId !== id ||
    receipt.outcome !== "prepared"
  )
    throw Error("Integration publication journal mismatch");
  entry.publication = integrationPublicationReceiptSchema.parse(receipt);
  persist(journal);
}
async function settleTransactionalEntry(
  rootDir: string,
  entry: JournalEntry,
  decision: "commit" | "restore",
) {
  if (!entry.publication) {
    if (decision === "commit") throw Error("Integration publication receipt missing");
    return;
  }
  const receipt = inspectIntegrationPublication({
    rootDir,
    preparation: entry.publication.preparation,
    transactionId: entry.publication.transactionId,
  });
  if (receipt.integrationId !== entry.id) throw Error("Integration journal component changed");
  const publication = await restoreIntegrationPublication({
    rootDir,
    receipt,
    signal: new AbortController().signal,
  });
  await settleIntegrationPublication(publication, decision, new AbortController().signal);
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

const journalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  extensionId: z.string().min(1).max(128),
  targetManifest: z.record(z.string(), z.unknown()),
  integrations: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
        backupDirectory: z.string().max(4096).nullable(),
        phase: z.enum(["prepared", "installed", "restoring", "restored"]),
        transactional: z.literal(true).optional(),
        publication: integrationPublicationReceiptSchema.optional(),
      }),
    )
    .max(256),
});
function readJournal(rootDir: string, path: string): ExtensionInstallJournal {
  if (!JOURNAL_RE.test(basename(path)) || resolve(dirname(path)) !== resolve(customDir(rootDir)))
    throw Error("Invalid extension install journal path");
  const directory = new AnchoredDirectory(customDir(rootDir));
  try {
    const data = journalSchema.parse(
      JSON.parse(directory.read(basename(path), 2 * 1024 ** 2).toString("utf8")),
    );
    return { path, data };
  } finally {
    directory.close();
  }
}

export async function reconcileExtensionInstallJournal(
  rootDir: string,
  path: string,
  isBookkeepingCommitted: (journal: ExtensionInstallJournalData) => Promise<boolean>,
): Promise<void> {
  const journal = readJournal(rootDir, path);
  if (await isBookkeepingCommitted(journal.data)) {
    for (const entry of journal.data.integrations) {
      if (entry.transactional) {
        await settleTransactionalEntry(rootDir, entry, "commit");
        continue;
      }
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
    if (entry.transactional) {
      await settleTransactionalEntry(rootDir, entry, "restore");
      entry.phase = "restored";
      persist(journal);
      continue;
    }
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
      throw Error(
        "Historical integration removal lacks a publication ownership receipt; preserve the current integration and reconcile the original journal",
      );
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
          "Preserve its current files and original backups until explicit integration reconciliation completes.",
        { cause: error },
      );
    }
  }
}
