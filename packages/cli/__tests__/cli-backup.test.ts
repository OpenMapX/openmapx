import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertValidBackupName,
  type BackupManifest,
  defaultBackupName,
  deleteBackup,
  discoverBackupableServices,
  filterManifestServices,
  formatBackupsTable,
  isCompatiblePlatformVersion,
  isValidBackupName,
  listBackups,
  preflightRestore,
  readBackupManifest,
} from "../src/commands/backup";

let tmp: string;

function setupRepo(): void {
  // Workspace marker so findRepoRoot accepts this dir.
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  // OpenMapX-specific top-level dir.
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "backups"), { recursive: true });
}

function writeManifest(slug: string, body: Record<string, unknown>) {
  const dir = join(tmp, "services", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "service.json"), JSON.stringify(body), "utf-8");
}

function writeBackup(name: string, manifest: BackupManifest): string {
  const dir = join(tmp, "infra", "docker", "backups", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return dir;
}

const baseService = {
  name: "Test",
  version: "1.0.0",
  quality: "built-in",
  container: { image: "t/x", tag: "latest", expose: [80] },
};

beforeEach(() => {
  delete process.env.OPENMAPX_ENABLED_SERVICES;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-cli-backup-"));
  setupRepo();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── Name validation ──────────────────────────────────────────────────────

describe("isValidBackupName", () => {
  it("accepts ISO-style names", () => {
    expect(isValidBackupName("2026-04-19T15-23-00Z")).toBe(true);
  });

  it("accepts alphanumerics, dots, underscores, hyphens", () => {
    expect(isValidBackupName("backup_v1.0-final")).toBe(true);
  });

  it("rejects empty strings", () => {
    expect(isValidBackupName("")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidBackupName("../etc")).toBe(false);
    expect(isValidBackupName("foo/bar")).toBe(false);
  });

  it("rejects whitespace and shell metachars", () => {
    expect(isValidBackupName("foo bar")).toBe(false);
    expect(isValidBackupName("foo;rm")).toBe(false);
    expect(isValidBackupName("foo$bar")).toBe(false);
  });
});

describe("assertValidBackupName", () => {
  it("throws for invalid names", () => {
    expect(() => assertValidBackupName("../evil")).toThrow(/Invalid backup name/);
  });
  it("does not throw for valid names", () => {
    expect(() => assertValidBackupName("good-1.0")).not.toThrow();
  });
});

// ─── Default name ──────────────────────────────────────────────────────────

describe("defaultBackupName", () => {
  it("renders an ISO timestamp with `:` replaced by `-`", () => {
    const name = defaultBackupName(new Date("2026-04-19T15:23:00.000Z"));
    expect(name).toBe("2026-04-19T15-23-00Z");
    expect(isValidBackupName(name)).toBe(true);
  });
});

// ─── Version compat ───────────────────────────────────────────────────────

describe("isCompatiblePlatformVersion", () => {
  it("treats matching major.minor as fully compatible", () => {
    const r = isCompatiblePlatformVersion("1.0", "1.0");
    expect(r.compatible).toBe(true);
    expect(r.majorMismatch).toBe(false);
    expect(r.minorMismatch).toBe(false);
  });

  it("flags major mismatch as incompatible", () => {
    const r = isCompatiblePlatformVersion("2.0", "1.0");
    expect(r.compatible).toBe(false);
    expect(r.majorMismatch).toBe(true);
  });

  it("flags minor mismatch as a warning, not an error", () => {
    const r = isCompatiblePlatformVersion("1.5", "1.0");
    expect(r.compatible).toBe(true);
    expect(r.majorMismatch).toBe(false);
    expect(r.minorMismatch).toBe(true);
  });
});

// ─── Manifest reading + filtering ─────────────────────────────────────────

describe("readBackupManifest", () => {
  it("loads a well-formed manifest", () => {
    const dir = writeBackup("good", {
      name: "good",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [{ name: "openmapx-pgdata", mode: "pg_dump", file: "x", sizeBytes: 0 }],
        },
      ],
    });
    const m = readBackupManifest(join(dir, "manifest.json"));
    expect(m.name).toBe("good");
    expect(m.services).toHaveLength(1);
  });

  it("preserves resolvedName + postgresUser/postgresDb on tar / pg_dump entries", () => {
    const dir = writeBackup("with-resolved", {
      name: "with-resolved",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "openmapx-pgdata",
              mode: "pg_dump",
              file: "postgis__openmapx-pgdata.sql.gz",
              sizeBytes: 1024,
              postgresUser: "alice",
              postgresDb: "mydb",
            },
          ],
        },
        {
          id: "tileserver",
          volumes: [
            {
              name: "openmapx-tiles",
              resolvedName: "myproject_openmapx-tiles",
              mode: "tar",
              file: "tileserver__openmapx-tiles.tar.gz",
              sizeBytes: 2048,
            },
          ],
        },
      ],
    });
    const m = readBackupManifest(join(dir, "manifest.json"));
    const pg = m.services.find((s) => s.id === "postgis");
    expect(pg?.volumes[0]?.postgresUser).toBe("alice");
    expect(pg?.volumes[0]?.postgresDb).toBe("mydb");
    const tiles = m.services.find((s) => s.id === "tileserver");
    expect(tiles?.volumes[0]?.resolvedName).toBe("myproject_openmapx-tiles");
  });

  it("rejects a missing file", () => {
    expect(() => readBackupManifest(join(tmp, "missing.json"))).toThrow(/not found/);
  });

  it("rejects malformed manifests", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(path, JSON.stringify({ wrong: true }), "utf-8");
    expect(() => readBackupManifest(path)).toThrow(/Malformed/);
  });

  it("rejects manifests with malformed service entries", () => {
    const path = join(tmp, "bad.json");
    writeFileSync(
      path,
      JSON.stringify({
        name: "x",
        createdAt: "now",
        services: [{ id: "no-volumes" }],
      }),
      "utf-8",
    );
    expect(() => readBackupManifest(path)).toThrow(/Malformed service entry/);
  });
});

describe("filterManifestServices", () => {
  const m: BackupManifest = {
    name: "t",
    createdAt: "now",
    services: [
      { id: "postgis", volumes: [] },
      { id: "tileserver", volumes: [] },
    ],
  };

  it("restricts to a subset", () => {
    const out = filterManifestServices(m, ["postgis"]);
    expect(out.services.map((s) => s.id)).toEqual(["postgis"]);
  });

  it("throws when an id is unknown", () => {
    expect(() => filterManifestServices(m, ["does-not-exist"])).toThrow(/does not contain/);
  });
});

// ─── Discovery ─────────────────────────────────────────────────────────────

describe("discoverBackupableServices", () => {
  it("returns only services with backup-true volumes", async () => {
    writeManifest("postgis", {
      ...baseService,
      id: "postgis",
      container: {
        ...baseService.container,
        environment: { POSTGRES_USER: "postgres", POSTGRES_DB: "openmapx" },
      },
      volumes: [{ name: "openmapx-pgdata", mountAt: "/var/lib/postgresql", backup: true }],
    });
    writeManifest("tileserver", {
      ...baseService,
      id: "tileserver",
      volumes: [{ name: "openmapx-tiles", mountAt: "/data", backup: true }],
    });
    writeManifest("redis", {
      ...baseService,
      id: "redis",
      volumes: [{ name: "openmapx-redis", mountAt: "/data" }],
    });
    writeManifest("nodata", { ...baseService, id: "nodata" });

    const targets = await discoverBackupableServices({ rootDir: tmp });
    const ids = targets.map((t) => t.id).sort();
    expect(ids).toEqual(["postgis"]);

    const pg = targets.find((t) => t.id === "postgis");
    expect(pg?.isPostgres).toBe(true);
    expect(pg?.postgresUser).toBe("postgres");
    expect(pg?.postgresDb).toBe("openmapx");
  });

  it("respects the serviceIds allow-list", async () => {
    writeManifest("postgis", {
      ...baseService,
      id: "postgis",
      volumes: [{ name: "openmapx-pgdata", mountAt: "/var/lib/postgresql", backup: true }],
    });
    writeManifest("tileserver", {
      ...baseService,
      id: "tileserver",
      volumes: [{ name: "openmapx-tiles", mountAt: "/data", backup: true }],
    });
    const out = await discoverBackupableServices({ rootDir: tmp, serviceIds: ["postgis"] });
    expect(out.map((t) => t.id)).toEqual(["postgis"]);
  });

  it("includes backupable services from the local selection file", async () => {
    writeManifest("postgis", {
      ...baseService,
      id: "postgis",
      volumes: [{ name: "openmapx-pgdata", mountAt: "/var/lib/postgresql", backup: true }],
    });
    writeManifest("tileserver", {
      ...baseService,
      id: "tileserver",
      volumes: [{ name: "openmapx-tiles", mountAt: "/data", backup: true }],
    });
    mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
    writeFileSync(
      join(tmp, "infra", "docker", "service-selection.json"),
      JSON.stringify({ selected: ["postgis", "tileserver"] }),
      "utf-8",
    );

    const out = await discoverBackupableServices({ rootDir: tmp });

    expect(out.map((t) => t.id).sort()).toEqual(["postgis", "tileserver"]);
  });
});

// ─── List + format ────────────────────────────────────────────────────────

describe("listBackups", () => {
  it("returns [] when backups dir is empty", () => {
    expect(listBackups({ rootDir: tmp })).toEqual([]);
  });

  it("loads valid manifests, sorts by createdAt", () => {
    writeBackup("a", {
      name: "a",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "x",
          volumes: [{ name: "openmapx-x", mode: "tar", file: "x.tar.gz", sizeBytes: 100 }],
        },
      ],
    });
    writeBackup("b", {
      name: "b",
      createdAt: "2026-04-18T00:00:00Z",
      services: [],
    });
    const rows = listBackups({ rootDir: tmp });
    expect(rows.map((r) => r.name)).toEqual(["b", "a"]);
    expect(rows[0]?.totalBytes).toBe(0);
    expect(rows[1]?.totalBytes).toBe(100);
  });

  it("skips directories without a manifest.json (with warning)", () => {
    mkdirSync(join(tmp, "infra", "docker", "backups", "no-manifest"), { recursive: true });
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = listBackups({ rootDir: tmp });
    expect(rows).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("formats as a table", () => {
    writeBackup("a", {
      name: "a",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "x",
          volumes: [{ name: "openmapx-x", mode: "tar", file: "x.tar.gz", sizeBytes: 2048 }],
        },
      ],
    });
    const out = formatBackupsTable(listBackups({ rootDir: tmp }));
    expect(out).toContain("a");
    expect(out).toContain("2.0 KB");
  });

  it("returns a placeholder string when no backups exist", () => {
    expect(formatBackupsTable([])).toBe("(no backups)");
  });
});

// ─── Preflight (restore, no docker) ───────────────────────────────────────

describe("preflightRestore", () => {
  it("loads + filters the manifest by service id", () => {
    writeBackup("snap1", {
      name: "snap1",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        { id: "postgis", volumes: [] },
        { id: "tileserver", volumes: [] },
      ],
    });
    const pre = preflightRestore({
      rootDir: tmp,
      name: "snap1",
      serviceIds: ["postgis"],
    });
    expect(pre.targets.map((s) => s.id)).toEqual(["postgis"]);
    expect(pre.versionError).toBeUndefined();
  });

  it("flags major-version mismatch as an error", () => {
    writeBackup("snap2", {
      name: "snap2",
      createdAt: "now",
      openmapxVersion: "9.0",
      services: [],
    });
    const pre = preflightRestore({ rootDir: tmp, name: "snap2" });
    expect(pre.versionError).toMatch(/major-version mismatch/);
  });

  it("warns (does not error) on minor-version mismatch", () => {
    writeBackup("snap3", {
      name: "snap3",
      createdAt: "now",
      openmapxVersion: "1.99",
      services: [],
    });
    const pre = preflightRestore({ rootDir: tmp, name: "snap3" });
    expect(pre.versionError).toBeUndefined();
    expect(pre.versionWarning).toMatch(/minor mismatch/);
  });

  it("ignores version checks when manifest has no openmapxVersion", () => {
    writeBackup("snap4", { name: "snap4", createdAt: "now", services: [] });
    const pre = preflightRestore({ rootDir: tmp, name: "snap4" });
    expect(pre.versionError).toBeUndefined();
    expect(pre.versionWarning).toBeUndefined();
  });

  it("rejects an unknown service id in --services", () => {
    writeBackup("snap5", {
      name: "snap5",
      createdAt: "now",
      services: [{ id: "postgis", volumes: [] }],
    });
    expect(() => preflightRestore({ rootDir: tmp, name: "snap5", serviceIds: ["ghost"] })).toThrow(
      /does not contain/,
    );
  });

  it("rejects an invalid backup name", () => {
    expect(() => preflightRestore({ rootDir: tmp, name: "../etc" })).toThrow(/Invalid backup name/);
  });

  it("rejects when manifest.json is missing", () => {
    mkdirSync(join(tmp, "infra", "docker", "backups", "empty"), { recursive: true });
    expect(() => preflightRestore({ rootDir: tmp, name: "empty" })).toThrow(/not found/);
  });
});

// ─── Delete ──────────────────────────────────────────────────────────────

describe("deleteBackup", () => {
  it("removes the backup directory", () => {
    writeBackup("doomed", { name: "doomed", createdAt: "now", services: [] });
    expect(() => deleteBackup({ rootDir: tmp, name: "doomed" })).not.toThrow();
    expect(existsSync(join(tmp, "infra", "docker", "backups", "doomed"))).toBe(false);
  });

  it("throws when the backup does not exist", () => {
    expect(() => deleteBackup({ rootDir: tmp, name: "ghost" })).toThrow(/not found/);
  });

  it("rejects an invalid backup name (defense in depth)", () => {
    expect(() => deleteBackup({ rootDir: tmp, name: "../../etc" })).toThrow(/Invalid backup name/);
  });
});
