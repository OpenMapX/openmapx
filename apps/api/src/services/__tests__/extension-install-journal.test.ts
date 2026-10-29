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
  it("preserves a historical upgraded artifact without an exact publication ownership receipt", async () => {
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

    await expect(
      reconcileExtensionInstallJournal(root, journal.path, async () => false),
    ).rejects.toThrow(/ownership receipt/);
    expect(readFileSync(join(target, "version"), "utf8")).toBe("new");
    expect(existsSync(backup)).toBe(true);
    expect(existsSync(journal.path)).toBe(true);
  });

  it("preserves an unprovable historical fresh artifact instead of removing a later writer", async () => {
    const root = fixture();
    const target = join(root, "custom_integrations", "probe");
    mkdirSync(target);
    const journal = createExtensionInstallJournal(root, "extension-probe", { version: "1" });
    appendIntegrationJournalEntry(journal, { id: "probe", backupDirectory: null });
    markIntegrationJournalEntryInstalled(journal, "probe");

    await expect(
      reconcileExtensionInstallJournal(root, journal.path, async () => false),
    ).rejects.toThrow(/ownership receipt/);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(journal.path)).toBe(true);
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

it.each([false, true])(
  "settles an actual shared publication from retained bundle journal (bookkeeping=%s)",
  async (committed) => {
    const root = fixture();
    mkdirSync(join(root, "services"));
    const { createDeterministicTarGz } = await import(
      "../../../../../packages/integration-framework/src/deterministic-tar"
    );
    const { installIntegration, removeIntegration } = await import(
      "@openmapx/integration-framework/installer"
    );
    const { recordIntegrationPublicationPrepared } = await import("../extension-install-journal");
    const archive = join(root, "fixture.tar.gz");
    writeFileSync(
      archive,
      createDeterministicTarGz([
        {
          path: "manifest.json",
          contents: Buffer.from(
            JSON.stringify({
              id: "bundle-fixture",
              name: "Bundle",
              version: "1.0.0",
              platform: "1.0",
              quality: "community",
              domains: ["map-overlay"],
            }),
          ),
        },
      ]),
    );
    const journal = createExtensionInstallJournal(root, "bundle", { version: "1.0.0" });
    appendIntegrationJournalEntry(journal, {
      id: "bundle-fixture",
      backupDirectory: null,
      transactional: true,
    });
    await installIntegration({
      rootDir: root,
      source: archive,
      sourceKind: "artifact",
      expectedId: "bundle-fixture",
      retainPublication: true,
      beforePublish: (receipt) =>
        recordIntegrationPublicationPrepared(journal, "bundle-fixture", receipt),
    });
    expect(() => removeIntegration({ rootDir: root, id: "bundle-fixture" })).toThrow(/busy/);
    await reconcileExtensionInstallJournal(root, journal.path, async () => committed);
    expect(existsSync(join(root, "custom_integrations", "bundle-fixture"))).toBe(committed);
    expect(existsSync(journal.path)).toBe(false);
    if (committed)
      expect(() => removeIntegration({ rootDir: root, id: "bundle-fixture" })).not.toThrow();
  },
);
it("does not delete a current integration when a transactional install never reached publication", async () => {
  const root = fixture(),
    target = join(root, "custom_integrations", "unmodified");
  mkdirSync(target);
  writeFileSync(join(target, "keep"), "original");
  const journal = createExtensionInstallJournal(root, "bundle", { version: "1.0.0" });
  appendIntegrationJournalEntry(journal, {
    id: "unmodified",
    backupDirectory: null,
    transactional: true,
  });
  await reconcileExtensionInstallJournal(root, journal.path, async () => false);
  expect(readFileSync(join(target, "keep"), "utf8")).toBe("original");
});
