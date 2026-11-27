import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({ openMigrationSession: vi.fn() }));
vi.mock("../db/index", () => database);

const { applyExtensionMigrations, listMigrationFiles } = await import("../extension-migrations");
const { setVerifiedIntegrationFiles } = await import("../integration-files");

let root: string;
let dir: string;

function write(path: string, content: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "omx-extension-migrations-"));
  dir = join(root, "demo");
  write("manifest.json", "{}");
  write("migrations/0002_index.sql", "create index on items (id);");
  write("migrations/0001_init.sql", "create table items (id int);");
  write("migrations/README.md", "not a migration");
  write("migrations/0003_Upper.sql", "select 1;");
  write("migrations/notes.sql", "select 1;");
  write("migrations/0004_nested/0004_inner.sql", "select 1;");
  write("0005_root.sql", "select 1;");
});

afterEach(() => {
  setVerifiedIntegrationFiles([], new Map());
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("listMigrationFiles", () => {
  it("orders files by number and ignores other names", () => {
    expect(listMigrationFiles(dir, null)).toEqual(["0001_init.sql", "0002_index.sql"]);
  });

  it("counts only recorded paths when a verified file list is given", () => {
    expect(
      listMigrationFiles(dir, [
        "manifest.json",
        "migrations/0001_init.sql",
        "migrations/README.md",
        "migrations/0004_nested/0004_inner.sql",
        "0005_root.sql",
      ]),
    ).toEqual(["0001_init.sql"]);
    expect(listMigrationFiles(dir, [])).toEqual([]);
  });

  it("returns nothing when the directory has no migrations", () => {
    rmSync(join(dir, "migrations"), { recursive: true });
    expect(listMigrationFiles(dir, null)).toEqual([]);
  });
});

describe("applyExtensionMigrations", () => {
  it("opens no session when a recorded migration changed since installation", async () => {
    setVerifiedIntegrationFiles(
      [root],
      new Map([
        [
          dir,
          [
            { path: "manifest.json", sha256: sha256("{}") },
            { path: "migrations/0001_init.sql", sha256: sha256("create table items (id int);") },
            { path: "migrations/0002_index.sql", sha256: sha256("installed bytes") },
          ],
        ],
      ]),
    );

    await expect(
      applyExtensionMigrations({ integrationId: "demo", directory: dir }),
    ).rejects.toThrow("Migration 0002_index.sql of demo is missing or changed since installation");
    expect(database.openMigrationSession).not.toHaveBeenCalled();
  });

  it("refuses an id no schema can be derived from before opening a session", async () => {
    await expect(
      applyExtensionMigrations({ integrationId: "Not An Id", directory: dir }),
    ).rejects.toThrow("Invalid integration id");
    expect(database.openMigrationSession).not.toHaveBeenCalled();
  });
});
