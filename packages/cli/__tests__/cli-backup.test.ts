import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertValidBackupName,
  type BackupManifest,
  createBackup,
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
  resolveBackupDir,
  restoreBackup,
} from "../src/commands/backup";

vi.mock("execa", () => ({ execa: vi.fn() }));

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
  vi.mocked(execa).mockReset();
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

  it("rejects dot, dot-dot, hidden, and flag-like names", () => {
    expect(isValidBackupName(".")).toBe(false);
    expect(isValidBackupName("..")).toBe(false);
    expect(isValidBackupName(".hidden")).toBe(false);
    expect(isValidBackupName("-rf")).toBe(false);
    expect(isValidBackupName("--name")).toBe(false);
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

describe("resolveBackupDir (shared containment guard)", () => {
  it("returns the named child directory of backups/", () => {
    expect(resolveBackupDir(tmp, "snap")).toBe(join(tmp, "infra", "docker", "backups", "snap"));
  });
  it("refuses a name that escapes the backups root", () => {
    expect(() => resolveBackupDir(tmp, "..")).toThrow(/outside backups/);
  });
  it("refuses the backups root itself", () => {
    expect(() => resolveBackupDir(tmp, ".")).toThrow(/outside backups/);
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

  it("reads versioned service metadata and remains compatible with legacy entries", () => {
    const dir = writeBackup("service-versions", {
      name: "service-versions",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        { id: "timeline", version: "2.3.4", volumes: [] },
        { id: "legacy", volumes: [] },
      ],
    });

    const manifest = readBackupManifest(join(dir, "manifest.json"));
    expect(manifest.services).toEqual([
      { id: "timeline", version: "2.3.4", volumes: [] },
      { id: "legacy", volumes: [] },
    ]);
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

  it("rejects a volume resolvedName that is a host path", () => {
    const dir = writeBackup("host-path", {
      name: "host-path",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "v",
              resolvedName: "/etc",
              mode: "tar",
              file: "postgis__v.tar.gz",
              sizeBytes: 1,
            },
          ],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid/);
  });

  it("rejects a volume resolvedName that starts with a dash", () => {
    const dir = writeBackup("dash-volume", {
      name: "dash-volume",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "v",
              resolvedName: "-v",
              mode: "tar",
              file: "postgis__v.tar.gz",
              sizeBytes: 1,
            },
          ],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid/);
  });

  it("rejects an unknown volume mode", () => {
    const dir = writeBackup("unknown-mode", {
      name: "unknown-mode",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "v",
              mode: "exec",
              file: "postgis__v.tar.gz",
              sizeBytes: 1,
            },
          ],
        },
      ],
    } as unknown as BackupManifest);
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid/);
  });

  it("rejects a traversing backup file", () => {
    const dir = writeBackup("traversing-file", {
      name: "traversing-file",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "v",
              mode: "tar",
              file: "../../../etc/passwd",
              sizeBytes: 1,
            },
          ],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid/);
  });

  it("rejects a postgres user that starts with a dash", () => {
    const dir = writeBackup("dash-user", {
      name: "dash-user",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "v",
              mode: "pg_dump",
              file: "postgis__v.sql.gz",
              sizeBytes: 1,
              postgresUser: "--host=evil",
            },
          ],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid/);
  });

  it("rejects a postgres database that starts with a dash", () => {
    const dir = writeBackup("dash-db", {
      name: "dash-db",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "postgis",
          volumes: [
            {
              name: "v",
              mode: "pg_dump",
              file: "postgis__v.sql.gz",
              sizeBytes: 1,
              postgresDb: "--host=evil",
            },
          ],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid/);
  });

  it("rejects compose interpolation in postgres backup metadata", () => {
    const dir = writeBackup("interpolated-postgres", {
      name: "interpolated-postgres",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "timeline",
          volumes: [
            {
              name: "database",
              mode: "pg_dump",
              file: "timeline__database.sql.gz",
              sizeBytes: 1,
              // biome-ignore lint/suspicious/noTemplateCurlyInString: test data is literal Compose interpolation syntax
              postgresUser: "${POSTGRES_USER:-timeline}",
              postgresDb: "timeline",
            },
          ],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid postgres user/);
  });

  it("rejects a service id that is not a slug", () => {
    const dir = writeBackup("bad-service", {
      name: "bad-service",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "--rm",
          volumes: [],
        },
      ],
    });
    expect(() => readBackupManifest(join(dir, "manifest.json"))).toThrow(/Invalid service id/);
  });

  it("accepts a complete portable manifest unchanged", () => {
    const manifest: BackupManifest = {
      name: "complete",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "tileserver",
          volumes: [
            {
              name: "tiles",
              resolvedName: "openmapx_openmapx-pgdata",
              mode: "tar",
              file: "tileserver__tiles.tar.gz",
              sizeBytes: 1,
            },
            {
              name: "database",
              mode: "pg_dump",
              file: "tileserver__database.sql.gz",
              sizeBytes: 2,
              postgresUser: "postgres",
              postgresDb: "openmapx",
            },
          ],
        },
      ],
    };
    const dir = writeBackup("complete", manifest);
    expect(readBackupManifest(join(dir, "manifest.json"))).toEqual(manifest);
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
  it("discovers one versioned pg_dump target and three versioned tar targets for Dawarich", async () => {
    process.env.OPENMAPX_ENABLED_SERVICES = "dawarich-app";

    const targets = await discoverBackupableServices({
      rootDir: process.cwd(),
      serviceIds: ["dawarich-postgis", "dawarich-app", "dawarich-sidekiq"],
    });

    expect(targets).toEqual([
      {
        id: "dawarich-app",
        version: "1.10.3",
        volumes: [
          {
            serviceId: "dawarich-app",
            volumeName: "openmapx-dawarich-public",
            mode: "tar",
          },
          {
            serviceId: "dawarich-app",
            volumeName: "openmapx-dawarich-watched",
            mode: "tar",
          },
          {
            serviceId: "dawarich-app",
            volumeName: "openmapx-dawarich-storage",
            mode: "tar",
          },
        ],
      },
      {
        id: "dawarich-postgis",
        version: "17-3.5",
        postgresUser: "postgres",
        postgresDb: "dawarich_production",
        volumes: [
          {
            serviceId: "dawarich-postgis",
            volumeName: "openmapx-dawarich-db-data",
            mode: "pg_dump",
          },
        ],
      },
    ]);
  });

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
    expect(pg?.version).toBe("1.0.0");
    expect(pg?.postgresUser).toBe("postgres");
    expect(pg?.postgresDb).toBe("openmapx");
    expect(pg?.volumes).toEqual([
      { serviceId: "postgis", volumeName: "openmapx-pgdata", mode: "pg_dump" },
    ]);
  });

  it("uses declared per-volume modes for any service while preserving legacy postgis fallback", async () => {
    writeManifest("timeline", {
      ...baseService,
      id: "timeline",
      container: {
        ...baseService.container,
        environment: {
          POSTGRES_USER: "timeline",
          POSTGRES_DB: "timeline",
          POSTGRES_PASSWORD: "secret",
        },
      },
      volumes: [
        { name: "openmapx-timeline-db", mountAt: "/db", backup: true, backupMode: "pg_dump" },
        { name: "openmapx-timeline-files", mountAt: "/files", backup: true, backupMode: "tar" },
      ],
    });
    writeManifest("postgis", {
      ...baseService,
      id: "postgis",
      container: {
        ...baseService.container,
        environment: { POSTGRES_USER: "postgres", POSTGRES_DB: "openmapx" },
      },
      volumes: [{ name: "openmapx-pgdata", mountAt: "/db", backup: true }],
    });

    process.env.OPENMAPX_ENABLED_SERVICES = "timeline,postgis";
    const targets = await discoverBackupableServices({
      rootDir: tmp,
      serviceIds: ["timeline", "postgis"],
    });

    expect(targets.find((target) => target.id === "timeline")).toMatchObject({
      postgresUser: "timeline",
      postgresDb: "timeline",
      volumes: [
        { volumeName: "openmapx-timeline-db", mode: "pg_dump" },
        { volumeName: "openmapx-timeline-files", mode: "tar" },
      ],
    });
    expect(targets.find((target) => target.id === "postgis")?.volumes[0]?.mode).toBe("pg_dump");
    expect(JSON.stringify(targets)).not.toContain("secret");
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

describe("backup volume modes", () => {
  function mockSuccessfulDocker(): void {
    vi.mocked(execa).mockImplementation(((command: string, args: string[]) => {
      if (command === "gunzip") {
        return Object.assign(Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }), {
          stdout: Readable.from(["dump"]),
        });
      }
      if (command === "docker" && args.includes("pg_dump")) {
        return Object.assign(Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }), {
          stdout: Readable.from(["dump"]),
        });
      }
      if (command === "docker" && args.includes("ps")) {
        return Promise.resolve({ exitCode: 0, stdout: '{"Service":"timeline"}\n', stderr: "" });
      }
      if (command === "docker" && args.includes("config")) {
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify({
            name: "openmapx",
            volumes: { "openmapx-files": { name: "openmapx_openmapx-files" } },
          }),
          stderr: "",
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
    }) as never);
  }

  function mockedCommandCalls(): Array<[string, string]> {
    return vi
      .mocked(execa)
      .mock.calls.map((call) => [
        typeof call[0] === "string" ? call[0] : call[0].toString(),
        Array.isArray(call[1]) ? call[1].join(" ") : "",
      ]);
  }

  it("creates generic mixed-mode backups with pg_dump before stopping for tar and writes service versions", async () => {
    writeManifest("timeline", {
      ...baseService,
      id: "timeline",
      version: "2.3.4",
      container: {
        ...baseService.container,
        environment: {
          POSTGRES_USER: "timeline_2026$archive",
          POSTGRES_DB: "timeline_2026$archive",
        },
      },
      volumes: [
        { name: "openmapx-db", mountAt: "/db", backup: true, backupMode: "pg_dump" },
        { name: "openmapx-files", mountAt: "/files", backup: true, backupMode: "tar" },
      ],
    });
    process.env.OPENMAPX_ENABLED_SERVICES = "timeline";
    mockSuccessfulDocker();

    const result = await createBackup({ rootDir: tmp, name: "mixed" });
    const calls = mockedCommandCalls();
    const pgDump = calls.findIndex(([, args]) => args.includes("pg_dump"));
    const stop = calls.findIndex(([, args]) => args.includes(" stop timeline"));
    const tar = calls.findIndex(([, args]) => args.includes("openmapx_openmapx-files:/source:ro"));

    expect(pgDump).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(pgDump);
    expect(tar).toBeGreaterThan(stop);
    expect(result.manifest.services).toEqual([
      expect.objectContaining({ id: "timeline", version: "2.3.4" }),
    ]);
    expect(result.manifest.services[0]?.volumes.map((volume) => volume.mode)).toEqual([
      "pg_dump",
      "tar",
    ]);
    expect(result.manifest.services[0]?.volumes[0]).toMatchObject({
      postgresUser: "timeline_2026$archive",
      postgresDb: "timeline_2026$archive",
    });
  });

  it("restores pg_dump volumes while running, then stops and restarts only for tar volumes", async () => {
    const dir = writeBackup("mixed-restore", {
      name: "mixed-restore",
      createdAt: "2026-04-19T00:00:00Z",
      services: [
        {
          id: "timeline",
          version: "2.3.4",
          volumes: [
            {
              name: "openmapx-db",
              mode: "pg_dump",
              file: "timeline__openmapx-db.sql.gz",
              sizeBytes: 0,
              postgresUser: "timeline_2026$archive",
              postgresDb: "timeline_2026$archive",
            },
            {
              name: "openmapx-files",
              mode: "tar",
              resolvedName: "openmapx_openmapx-files",
              file: "timeline__openmapx-files.tar.gz",
              sizeBytes: 0,
            },
          ],
        },
      ],
    });
    writeFileSync(join(dir, "timeline__openmapx-db.sql.gz"), "dump");
    writeFileSync(join(dir, "timeline__openmapx-files.tar.gz"), "tar");
    mockSuccessfulDocker();

    await restoreBackup({ rootDir: tmp, name: "mixed-restore", stopRunning: true });

    const calls = mockedCommandCalls();
    const psql = calls.findIndex(([, args]) => args.includes(" psql "));
    const stop = calls.findIndex(([, args]) => args.includes(" stop timeline"));
    const tar = calls.findIndex(([, args]) => args.includes("openmapx_openmapx-files:/target"));
    const start = calls.findIndex(([, args]) => args.includes(" start timeline"));

    expect(psql).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(psql);
    expect(tar).toBeGreaterThan(stop);
    expect(start).toBeGreaterThan(tar);
    expect(calls.some(([, args]) => args.includes("-U timeline_2026$archive"))).toBe(true);
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

  it("refuses to wipe the backups root itself (e.g. name '.')", () => {
    writeBackup("keep", { name: "keep", createdAt: "now", services: [] });
    const backupsRoot = join(tmp, "infra", "docker", "backups");
    expect(() => deleteBackup({ rootDir: tmp, name: "." })).toThrow(/Invalid backup name/);
    expect(existsSync(backupsRoot)).toBe(true);
    expect(existsSync(join(backupsRoot, "keep"))).toBe(true);
  });
});
