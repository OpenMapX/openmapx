import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { services } from "@openmapx/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { releaseProvenance } from "../../core/src/services/__fixtures__/release-provenance";

const applied = vi.hoisted(() => ({ release: null as services.GenerationRelease | null }));
vi.mock("../src/lib/backup-release", async (original) => ({
  ...(await original<typeof import("../src/lib/backup-release")>()),
  readAppliedRelease: () => applied.release,
}));

import { preflightRestore } from "../src/commands/backup";
import { nameAppliedMigration, runningMigrationHead } from "../src/lib/backup-release";

const builtJournal = (
  JSON.parse(
    readFileSync(
      new URL("../../../apps/api/src/db/migrations/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as { entries: { tag: string; when: number }[] }
).entries.map(({ tag, when }) => ({ tag, when }));

let root: string;

function pinned(head: { tag: string; when: number }): services.GenerationRelease {
  return {
    manifest: {
      schemaVersion: 1,
      release: "release-2",
      images: {} as services.ReleaseManifest["images"],
      ...releaseProvenance(),
      databaseMigrationHead: head,
    },
    manifestDigest: "d".repeat(64),
  };
}

function writeCheckoutJournal(entries: { tag: string; when: number }[]): void {
  const meta = join(root, "apps/api/src/db/migrations/meta");
  mkdirSync(meta, { recursive: true });
  writeFileSync(join(meta, "_journal.json"), JSON.stringify({ entries }));
}

function writeBackup(name: string, databaseMigration: { tag: string | null; when: number }) {
  const dir = join(root, "infra/docker/backups", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      formatVersion: 1,
      name,
      createdAt: "now",
      release: { release: "release-1", manifestDigest: "c".repeat(64) },
      databaseMigration,
      services: [{ id: "postgis", version: "1.0.0", volumes: [] }],
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-backup-release-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "services"), { recursive: true });
  applied.release = null;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("naming the backed-up schema", () => {
  it("names the applied release's head", () => {
    const release = pinned({ tag: "0002_head", when: 2000 });
    expect(nameAppliedMigration(2000, release, root)).toEqual({ tag: "0002_head", when: 2000 });
  });

  it("names an entry of the checkout's journal", () => {
    writeCheckoutJournal([
      { tag: "0000_baseline", when: 1000 },
      { tag: "0001_next", when: 1500 },
    ]);
    const release = pinned({ tag: "0002_head", when: 2000 });
    expect(nameAppliedMigration(1500, release, root)).toEqual({ tag: "0001_next", when: 1500 });
  });

  it("keeps only the time of a migration neither names, and still backs up", () => {
    writeCheckoutJournal([{ tag: "0000_baseline", when: 1000 }]);
    const release = pinned({ tag: "0002_head", when: 2000 });
    expect(nameAppliedMigration(3000, release, root)).toEqual({ tag: null, when: 3000 });
  });

  it("uses the journal the CLI was built with where there is no checkout", () => {
    const newest = builtJournal.at(-1);
    if (!newest) throw new Error("The API migration journal has no entries");
    expect(runningMigrationHead(null, root)).toEqual(newest);
    expect(nameAppliedMigration(newest.when, null, root)).toEqual(newest);
  });
});

describe("restoring onto a pinned release", () => {
  it("refuses a backup whose schema is newer than the release's head", () => {
    applied.release = pinned({ tag: "0002_head", when: 2000 });
    expect(runningMigrationHead(applied.release, root)).toEqual({ tag: "0002_head", when: 2000 });
    writeBackup("newer", { tag: null, when: 3000 });
    expect(preflightRestore({ rootDir: root, name: "newer" }).versionError).toMatch(
      /newer than the running release release-2 \(backup created_at 3000, running 0002_head\)\. Apply the backup's release \(release-1\) first/,
    );
  });

  it("allows a backup at or behind the release's head", () => {
    applied.release = pinned({ tag: "0002_head", when: 2000 });
    writeBackup("same", { tag: "0002_head", when: 2000 });
    writeBackup("older", { tag: "0001_next", when: 1500 });
    expect(preflightRestore({ rootDir: root, name: "same" }).versionError).toBeUndefined();
    expect(preflightRestore({ rootDir: root, name: "older" }).versionError).toBeUndefined();
  });
});
