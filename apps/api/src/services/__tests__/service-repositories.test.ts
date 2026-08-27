import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  communityDir: `/tmp/openmapx-service-repositories-${process.pid}`,
  clone: vi.fn(),
  dbWhere: vi.fn(),
  dbSet: vi.fn(),
  dbUpdate: vi.fn(),
  dbLimit: vi.fn(),
  dbSelectWhere: vi.fn(),
  dbFrom: vi.fn(),
  dbSelect: vi.fn(),
  findServiceManifestDirs: vi.fn<(dir: string) => string[]>(() => []),
}));

// Keep git and the process database isolated while exercising the real
// repository filesystem behavior in a per-process temporary directory.
vi.mock("@openmapx/core/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core/server")>();
  return {
    ...actual,
    findRepoRoot: () => "/unused",
    repoPaths: () => ({ communityDir: testState.communityDir }),
    gitShallowCloneSnapshot: async (options: { url: string; targetDir: string }) => {
      await testState.clone(options);
      return {
        directory: options.targetDir,
        canonicalUrl: options.url,
        commit: "a".repeat(40),
      };
    },
    services: {
      ...actual.services,
      findServiceManifestDirs: testState.findServiceManifestDirs,
    },
  };
});
vi.mock("../../db", () => ({
  db: { select: testState.dbSelect, update: testState.dbUpdate },
}));
vi.mock("../../db/schema", () => ({ serviceRepository: { hash: "hash" } }));

import {
  backupRepo,
  discardRepoBackup,
  discardStagedRepo,
  hashUrl,
  prepareRepo,
  publishStagedRepo,
  reconcileRepoBackups,
  restoreRepo,
  stageRepo,
} from "../service-repositories";

beforeEach(() => {
  rmSync(testState.communityDir, { recursive: true, force: true });
  mkdirSync(testState.communityDir, { recursive: true });
  testState.dbWhere.mockResolvedValue(undefined);
  testState.dbSet.mockReturnValue({ where: testState.dbWhere });
  testState.dbUpdate.mockReturnValue({ set: testState.dbSet });
  testState.dbSelectWhere.mockReturnValue({ limit: testState.dbLimit });
  testState.dbFrom.mockReturnValue({ where: testState.dbSelectWhere });
  testState.dbSelect.mockReturnValue({ from: testState.dbFrom });
  testState.findServiceManifestDirs.mockReturnValue([]);
  testState.clone.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(testState.communityDir, { recursive: true, force: true });
});

describe("hashUrl", () => {
  it("is deterministic", () => {
    expect(hashUrl("https://github.com/x/y")).toBe(hashUrl("https://github.com/x/y"));
  });

  it("differs for different URLs", () => {
    expect(hashUrl("https://github.com/x/y")).not.toBe(hashUrl("https://github.com/x/z"));
  });

  it("returns a 16-char hex string", () => {
    expect(hashUrl("https://example.com")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("repository rollback backups", () => {
  const url = "https://github.com/openmapx/example-service";
  const snapshot = {
    hash: hashUrl(url),
    url,
    displayName: "Old service",
    lastFetchedAt: new Date("2026-08-01T00:00:00Z"),
    lastSha: "a".repeat(40),
    autoUpdate: false,
    pinnedRef: "v1.0.0",
    managedByExtension: "bundle-one",
    createdAt: new Date("2026-08-01T00:00:00Z"),
  };

  it("keeps the installed checkout available while preparing a rollback backup", () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");

    const backup = backupRepo(snapshot);

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(backup.backupDir)).toBe(true);
  });

  it("restores the exact previous files and metadata", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");

    const backup = backupRepo(snapshot);

    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    await restoreRepo(backup);

    expect(existsSync(backup.backupDir)).toBe(false);
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(testState.dbSet).toHaveBeenCalledWith({
      displayName: snapshot.displayName,
      lastFetchedAt: snapshot.lastFetchedAt,
      lastSha: snapshot.lastSha,
      autoUpdate: snapshot.autoUpdate,
      pinnedRef: snapshot.pinnedRef,
      managedByExtension: snapshot.managedByExtension,
    });
  });

  it("retains the rollback snapshot when metadata restore fails so a retry can converge", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    const backup = backupRepo(snapshot);

    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    testState.dbWhere.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(restoreRepo(backup)).rejects.toThrow("database unavailable");
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(backup.backupDir)).toBe(true);

    await restoreRepo(backup);

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(backup.backupDir)).toBe(false);
  });

  it("reconciles an interrupted replacement when files changed before metadata", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    const backup = backupRepo(snapshot);
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    testState.dbLimit.mockResolvedValueOnce([snapshot]);

    await reconcileRepoBackups();

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(backup.backupDir)).toBe(false);
  });

  it("restores service selection with an interrupted existing-repository update", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    backupRepo(snapshot, { selectionBefore: ["postgis"] });
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    testState.dbLimit.mockResolvedValueOnce([snapshot]);
    const restoreSelection = vi.fn();

    await reconcileRepoBackups({ restoreSelection });

    expect(restoreSelection).toHaveBeenCalledWith(
      ["postgis"],
      expect.stringMatching(/^recovery_[a-f0-9]{64}$/),
    );
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
  });

  it("reports runtime recovery for services touched by an interrupted existing-repository update", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    backupRepo(snapshot, {
      selectionBefore: ["postgis", "example"],
      touchedServiceIds: ["example", "example-worker"],
      previouslyEnabledServiceIds: ["example"],
    });
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    testState.dbLimit.mockResolvedValueOnce([snapshot]);

    const recovery = await reconcileRepoBackups({ restoreSelection: vi.fn() });

    expect(recovery).toEqual({
      runtimeRecoveryNeeded: true,
      orphanedServiceIds: ["example", "example-worker"],
      restartServiceIds: ["example"],
      incidentId: expect.stringMatching(/^recovery_[0-9a-f]{64}$/),
    });
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
  });

  it("keeps a replacement whose filesystem and metadata commit both completed", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    const backup = backupRepo(snapshot);
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    testState.dbLimit.mockResolvedValueOnce([
      {
        ...snapshot,
        displayName: "New service",
        lastFetchedAt: new Date("2026-08-02T00:00:00Z"),
        lastSha: "b".repeat(40),
        pinnedRef: "v2.0.0",
      },
    ]);

    await reconcileRepoBackups();

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("new");
    expect(existsSync(backup.backupDir)).toBe(false);
    expect(testState.dbUpdate).not.toHaveBeenCalled();
  });

  it("finishes a journaled restore after metadata failed and the process restarted", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    const backup = backupRepo(snapshot);
    rmSync(target, { recursive: true });
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "new");
    testState.dbWhere.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(restoreRepo(backup)).rejects.toThrow("database unavailable");

    testState.dbUpdate.mockClear();
    testState.dbLimit.mockResolvedValueOnce([
      {
        ...snapshot,
        displayName: "New service",
        lastFetchedAt: new Date("2026-08-02T00:00:00Z"),
        lastSha: "b".repeat(40),
      },
    ]);

    await reconcileRepoBackups();

    expect(testState.dbUpdate).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(backup.backupDir)).toBe(false);
  });

  it("cleans an unjournaled rollback copy when the live checkout is intact", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    const backup = backupRepo(snapshot);
    rmSync(`${backup.backupDir}.json`);

    await reconcileRepoBackups();

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("old");
    expect(existsSync(backup.backupDir)).toBe(false);
  });

  it("retains an unjournaled rollback copy when the live checkout is missing", async () => {
    const target = join(testState.communityDir, snapshot.hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "old");
    const backup = backupRepo(snapshot);
    rmSync(`${backup.backupDir}.json`);
    rmSync(target, { recursive: true });

    await reconcileRepoBackups();

    expect(existsSync(target)).toBe(false);
    expect(readFileSync(join(backup.backupDir, "version.txt"), "utf8")).toBe("old");
  });

  it("refuses a forged backup path outside the community directory", () => {
    expect(() =>
      discardRepoBackup({ snapshot, backupDir: `/tmp/.rollback-${snapshot.hash}-000000000000` }),
    ).toThrow(/rollback backup path/i);
  });
});

describe("community repository preflight", () => {
  const url = "https://github.com/openmapx/community-service";

  it("publishes the single validated staged checkout without recloning", async () => {
    const target = join(testState.communityDir, hashUrl(url));
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "installed-version");
    testState.clone.mockImplementation(async ({ targetDir }: { targetDir: string }) => {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(join(targetDir, "version.txt"), "validated-stage");
      writeFileSync(
        join(targetDir, "service.json"),
        JSON.stringify({
          id: "community-service",
          name: "Community Service",
          version: "1.0.0",
          quality: "community",
          container: { image: "example/community-service", tag: "1.0.0" },
        }),
      );
    });
    testState.findServiceManifestDirs.mockImplementation((dir: string) => [dir]);

    const staged = await stageRepo(url);
    expect(testState.clone).toHaveBeenCalledTimes(1);

    await publishStagedRepo(staged);

    expect(testState.clone).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("validated-stage");
  });

  it("cleans an unpublished staged checkout", async () => {
    testState.clone.mockImplementation(async ({ targetDir }: { targetDir: string }) => {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(
        join(targetDir, "service.json"),
        JSON.stringify({
          id: "community-service",
          name: "Community Service",
          version: "1.0.0",
          quality: "community",
          container: { image: "example/community-service", tag: "1.0.0" },
        }),
      );
    });
    testState.findServiceManifestDirs.mockImplementation((dir: string) => [dir]);

    const staged = await stageRepo(url);
    discardStagedRepo(staged);

    expect(readdirSync(testState.communityDir)).toEqual([]);
  });

  it("rejects an update with a community bind mount before replacing its installed checkout", async () => {
    const target = join(testState.communityDir, hashUrl(url));
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "installed-version");
    testState.clone.mockImplementation(async ({ targetDir }: { targetDir: string }) => {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(
        join(targetDir, "service.json"),
        JSON.stringify({
          id: "community-service",
          name: "Community Service",
          version: "1.0.0",
          quality: "community",
          container: { image: "example/community-service", tag: "1.0.0" },
          bindMounts: [{ source: "runtime/state", target: "/state" }],
        }),
      );
    });
    testState.findServiceManifestDirs.mockImplementation((dir: string) => [dir]);

    await expect(prepareRepo(url)).rejects.toThrow("community_bind_mount_forbidden");

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("installed-version");
    expect(existsSync(target)).toBe(true);
  });
});

describe("new repository preparation journals", () => {
  const url = "https://github.com/openmapx/new-service";
  const hash = hashUrl(url);
  const prepared = {
    hash,
    url,
    displayName: "New service",
    lastFetchedAt: new Date("2026-08-20T00:00:00Z"),
    lastSha: "c".repeat(40),
    pinnedRef: "v1.0.0",
    managedByExtension: "bundle-one",
  };

  function writePreparationJournal(selectionBefore?: string[]): string {
    const path = join(testState.communityDir, `.prepare-${hash}-aaaaaaaaaaaa.json`);
    writeFileSync(path, JSON.stringify({ version: 1, repository: prepared, selectionBefore }));
    return path;
  }

  it("removes a published checkout when its database transaction never committed", async () => {
    const target = join(testState.communityDir, hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "uncommitted");
    const journal = writePreparationJournal();
    testState.dbLimit.mockResolvedValueOnce([]);

    await reconcileRepoBackups();

    expect(existsSync(target)).toBe(false);
    expect(existsSync(journal)).toBe(false);
  });

  it("restores the previous service selection for an uncommitted checkout", async () => {
    const target = join(testState.communityDir, hash);
    mkdirSync(target);
    const journal = writePreparationJournal();
    writeFileSync(
      journal,
      JSON.stringify({
        version: 1,
        repository: prepared,
        selectionBefore: ["postgis", "redis"],
        touchedServiceIds: ["new-service"],
        previouslyEnabledServiceIds: [],
      }),
    );
    const restoreSelection = vi.fn();
    testState.dbLimit.mockResolvedValueOnce([]);

    const recovery = await reconcileRepoBackups({ restoreSelection });

    expect(restoreSelection).toHaveBeenCalledWith(
      ["postgis", "redis"],
      expect.stringMatching(/^recovery_[a-f0-9]{64}$/),
    );
    expect(existsSync(target)).toBe(false);
    expect(existsSync(journal)).toBe(false);
    expect(recovery).toEqual({
      orphanedServiceIds: ["new-service"],
      restartServiceIds: [],
      runtimeRecoveryNeeded: true,
      incidentId: expect.stringMatching(/^recovery_[0-9a-f]{64}$/),
    });
  });

  it("persists runtime recovery intent before deleting its source journal or checkout", async () => {
    const target = join(testState.communityDir, hash);
    mkdirSync(target);
    const journal = writePreparationJournal();
    writeFileSync(
      journal,
      JSON.stringify({
        version: 1,
        repository: prepared,
        touchedServiceIds: ["new-service"],
        previouslyEnabledServiceIds: ["old-service"],
      }),
    );
    testState.dbLimit.mockResolvedValueOnce([]);
    const persistRuntimeRecovery = vi.fn(async (recovery) => {
      expect(existsSync(journal)).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(recovery).toEqual({
        runtimeRecoveryNeeded: true,
        incidentId: expect.stringMatching(/^recovery_[0-9a-f]{64}$/),
        orphanedServiceIds: ["new-service"],
        restartServiceIds: ["old-service"],
      });
      throw new Error("runtime journal fsync failed");
    });

    await expect(reconcileRepoBackups({ persistRuntimeRecovery })).rejects.toThrow(
      "runtime journal fsync failed",
    );
    expect(existsSync(journal)).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  it("assigns distinct durable incident IDs to repeated same-service recoveries", async () => {
    const target = join(testState.communityDir, hash);
    mkdirSync(target);
    const firstJournal = writePreparationJournal();
    writeFileSync(
      firstJournal,
      JSON.stringify({
        version: 1,
        repository: prepared,
        selectionBefore: ["postgis"],
        touchedServiceIds: ["example"],
      }),
    );
    testState.dbLimit.mockResolvedValueOnce([]);
    const first = await reconcileRepoBackups();

    mkdirSync(target);
    const secondJournal = writePreparationJournal();
    writeFileSync(
      secondJournal,
      JSON.stringify({
        version: 1,
        repository: prepared,
        selectionBefore: ["redis"],
        touchedServiceIds: ["example"],
      }),
    );
    testState.dbLimit.mockResolvedValueOnce([]);
    const second = await reconcileRepoBackups();

    expect(first.orphanedServiceIds).toEqual(["example"]);
    expect(second.orphanedServiceIds).toEqual(["example"]);
    expect(first.incidentId).not.toBe(second.incidentId);
  });

  it("names the journal file when a preparation journal cannot be reconciled", async () => {
    const target = join(testState.communityDir, hash);
    mkdirSync(target);
    const journal = writePreparationJournal();
    testState.dbLimit.mockResolvedValueOnce([
      { ...prepared, lastSha: "d".repeat(40), autoUpdate: false, createdAt: new Date() },
    ]);

    await expect(reconcileRepoBackups()).rejects.toThrow(journal);
    expect(existsSync(journal)).toBe(true);
  });

  it("keeps a checkout whose matching database transaction committed", async () => {
    const target = join(testState.communityDir, hash);
    mkdirSync(target);
    writeFileSync(join(target, "version.txt"), "committed");
    const journal = writePreparationJournal();
    testState.dbLimit.mockResolvedValueOnce([
      {
        ...prepared,
        autoUpdate: false,
        createdAt: new Date("2026-08-20T00:00:00Z"),
      },
    ]);

    await reconcileRepoBackups();

    expect(readFileSync(join(target, "version.txt"), "utf8")).toBe("committed");
    expect(existsSync(journal)).toBe(false);
  });
});
