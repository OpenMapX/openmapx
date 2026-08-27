import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendIntegrationJournalEntry,
  createExtensionInstallJournal,
  markIntegrationJournalEntryInstalled,
  reconcileExtensionInstallJournal,
} from "../extension-install-journal";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-extension-journal-"));
  roots.push(root);
  mkdirSync(join(root, "custom_integrations"));
  return root;
}

describe("extension integration install journal", () => {
  it("restores upgraded artifacts when bookkeeping did not commit", async () => {
    const root = fixture();
    const target = join(root, "custom_integrations", "probe");
    const backup = join(root, "custom_integrations", ".rollback-integration-probe-aaaaaaaaaaaa");
    mkdirSync(target);
    writeFileSync(join(target, "version"), "old");
    cpSync(target, backup, { recursive: true });
    writeFileSync(join(target, "version"), "new");

    const journal = createExtensionInstallJournal(root, "extension-probe", { version: "2" });
    appendIntegrationJournalEntry(journal, { id: "probe", backupDirectory: backup });
    markIntegrationJournalEntryInstalled(journal, "probe");

    await reconcileExtensionInstallJournal(root, journal.path, async () => false);

    expect(readFileSync(join(target, "version"), "utf8")).toBe("old");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(journal.path)).toBe(false);
  });

  it("removes a fresh artifact when bookkeeping did not commit", async () => {
    const root = fixture();
    const target = join(root, "custom_integrations", "probe");
    mkdirSync(target);
    const journal = createExtensionInstallJournal(root, "extension-probe", { version: "1" });
    appendIntegrationJournalEntry(journal, { id: "probe", backupDirectory: null });
    markIntegrationJournalEntryInstalled(journal, "probe");

    await reconcileExtensionInstallJournal(root, journal.path, async () => false);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(journal.path)).toBe(false);
  });

  it("keeps installed artifacts and discards backups after committed bookkeeping", async () => {
    const root = fixture();
    const target = join(root, "custom_integrations", "probe");
    const backup = join(root, "custom_integrations", ".rollback-integration-probe-aaaaaaaaaaaa");
    mkdirSync(target);
    writeFileSync(join(target, "version"), "new");
    mkdirSync(backup);
    writeFileSync(join(backup, "version"), "old");
    const journal = createExtensionInstallJournal(root, "extension-probe", { version: "2" });
    appendIntegrationJournalEntry(journal, { id: "probe", backupDirectory: backup });
    markIntegrationJournalEntryInstalled(journal, "probe");

    await reconcileExtensionInstallJournal(root, journal.path, async () => true);

    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(journal.path)).toBe(false);
  });

  it("does not treat an unexplained missing rollback backup as a completed restore", async () => {
    const root = fixture();
    const target = join(root, "custom_integrations", "probe");
    const missingBackup = join(
      root,
      "custom_integrations",
      ".rollback-integration-probe-aaaaaaaaaaaa",
    );
    mkdirSync(target);
    writeFileSync(join(target, "version"), "new");
    const journal = createExtensionInstallJournal(root, "extension-probe", { version: "2" });
    appendIntegrationJournalEntry(journal, {
      id: "probe",
      backupDirectory: missingBackup,
    });
    markIntegrationJournalEntryInstalled(journal, "probe");

    await expect(
      reconcileExtensionInstallJournal(root, journal.path, async () => false),
    ).rejects.toThrow("Integration rollback backup is missing for probe");
    await expect(
      reconcileExtensionInstallJournal(root, journal.path, async () => false),
    ).rejects.toThrow("Integration rollback backup is missing for probe");

    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(journal.path)).toBe(true);
  });
});
