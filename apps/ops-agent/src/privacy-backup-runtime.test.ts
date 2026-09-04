import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

vi.mock("./administrative-runtime", () => ({
  inspectBackupInventory: vi.fn(() => ({ backups: [], warningCount: 0 })),
  inspectPrivacyBackupLease: vi.fn(),
  readVerifiedPrivacyBackupInputs: vi.fn(() => ({
    manifest: { openmapxVersion: "1.0.0" },
    inputs: [
      {
        serviceId: "postgis",
        volumeId: "database",
        file: "postgis__database.sql.gz",
        mode: "pg_dump",
        sizeBytes: 10,
        sha256: "a".repeat(64),
      },
    ],
  })),
}));

import { readVerifiedPrivacyBackupInputs } from "./administrative-runtime";
import {
  createPrivacyBackupExtractionRuntime,
  janitorPrivacyBackupScratch,
  probePrivacyBackupRuntime,
} from "./privacy-backup-runtime";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeBackup() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-privacy-backup-runtime-"));
  chmodSync(root, 0o700);
  const backupId = "backup-1";
  const backupDirectory = join(root, "infra", "docker", "backups", backupId);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const contents = "safe-dump\n";
  const file = "postgis__database.sql.gz";
  writeFileSync(join(backupDirectory, file), contents, { mode: 0o400 });
  const manifest = {
    name: backupId,
    createdAt: "2026-09-04T10:00:00.000Z",
    openmapxVersion: "1.0.0",
    formatVersion: 2,
    services: [
      {
        id: "postgis",
        version: "1.0.0",
        volumes: [
          {
            name: "database",
            file,
            mode: "pg_dump",
            sizeBytes: Buffer.byteLength(contents),
            sha256: digest(contents),
          },
        ],
      },
    ],
  };
  const manifestContents = JSON.stringify(manifest);
  writeFileSync(join(backupDirectory, "manifest.json"), manifestContents, { mode: 0o400 });
  return { root, backupId, manifestDigest: digest(manifestContents) };
}

function request(backupId: string, manifestDigest: string) {
  return {
    version: 1 as const,
    requestId: randomUUID(),
    taskId: randomUUID(),
    backupId,
    manifestDigest,
    cutoff: "2026-09-04T09:00:00.000Z",
    collectorContract: "openmapx-subject-export-v1" as const,
    capability: "ignored-by-runtime",
    subjectLocator: { kind: "user_id" as const, value: "subject-1" },
  };
}

describe("privacy backup extraction runtime", () => {
  it("reports ready only from a readable inventory and the exact local collector image", async () => {
    const backup = makeBackup();
    const collectorImage = `ghcr.io/openmapx/privacy-backup@sha256:${"a".repeat(64)}`;
    const spawn = vi.fn(() => {
      const child = {
        killed: false,
        kill: vi.fn(() => true),
        once: vi.fn((event: string, listener: (...values: unknown[]) => void) => {
          if (event === "close") queueMicrotask(() => listener(0));
          return child;
        }),
      };
      return child;
    });

    await expect(
      probePrivacyBackupRuntime({
        rootDir: backup.root,
        collectorImage,
        enabled: true,
        spawnImpl: spawn as never,
      }),
    ).resolves.toEqual({ ready: true, inventoryReadable: true, collectorImage });
    expect(spawn).toHaveBeenCalledWith("docker", ["image", "inspect", collectorImage], {
      stdio: "ignore",
    });
  });

  it("passes the exact Dawarich database and attachment-storage sources to the collector", async () => {
    vi.mocked(readVerifiedPrivacyBackupInputs).mockReturnValueOnce({
      manifest: {
        openmapxVersion: "1.0.0",
        privacySourceProvenance: {
          managedDawarich: {
            version: "1.10.3",
            image: "freikin/dawarich",
            imageDigest: `sha256:${"d".repeat(64)}`,
            upstreamCommit: "c".repeat(40),
            schemaContract: "dawarich-1.10.3",
          },
        },
      },
      inputs: [
        {
          serviceId: "dawarich-postgis",
          volumeId: "openmapx-dawarich-db-data",
          file: "dawarich-postgis__openmapx-dawarich-db-data.sql.gz",
          mode: "pg_dump",
          sizeBytes: 10,
          sha256: "a".repeat(64),
        },
        {
          serviceId: "dawarich-app",
          volumeId: "openmapx-dawarich-storage",
          file: "dawarich-app__openmapx-dawarich-storage.tar.gz",
          mode: "tar",
          sizeBytes: 10,
          sha256: "b".repeat(64),
        },
      ],
    } as never);
    const backup = makeBackup();
    let body = "";
    const spawn = vi.fn(() => {
      const listeners = new Map<string, (...values: unknown[]) => void>();
      return {
        killed: false,
        stdout: Readable.from([Buffer.from("tar")]),
        stderr: Readable.from([]),
        stdin: {
          end: vi.fn((value: string) => {
            body = value;
            setTimeout(() => listeners.get("close")?.(0, null), 1);
          }),
        },
        kill: vi.fn(),
        once: vi.fn((event: string, listener: (...values: unknown[]) => void) => {
          listeners.set(event, listener);
        }),
      };
    });
    const runtime = createPrivacyBackupExtractionRuntime({
      rootDir: backup.root,
      collectorImage: `ghcr.io/openmapx/privacy-backup@sha256:${"a".repeat(64)}`,
      spawnImpl: spawn as never,
    });
    const input = request(backup.backupId, backup.manifestDigest);
    const output = await runtime.runCollector(input, {} as never, new AbortController().signal);
    for await (const _chunk of output) void _chunk;
    expect(JSON.parse(body)).toMatchObject({
      sources: [
        { family: "dawarich", schemaContract: "dawarich-1.10.3" },
        { family: "dawarich-storage", schemaContract: "dawarich-storage-1.10.3" },
      ],
    });
  });

  it("uses an egress-free, read-only, capability-free Docker argv and cleans scratch", async () => {
    const backup = makeBackup();
    const scratchRoot = join(backup.root, "scratch");
    const spawn = vi.fn((_file: string, args: readonly string[]) => {
      if (args[0] === "rm")
        return {
          once: vi.fn(),
        };
      const listeners = new Map<string, (...values: unknown[]) => void>();
      const stdout = Readable.from([Buffer.from("tar\n")]);
      const child = {
        killed: false,
        stdout,
        stderr: Readable.from([]),
        stdin: { end: vi.fn(() => setTimeout(() => listeners.get("close")?.(0, null), 5)) },
        kill: vi.fn(() => {
          child.killed = true;
          return true;
        }),
        once: vi.fn((event: string, listener: (...values: unknown[]) => void) => {
          listeners.set(event, listener);
          return child;
        }),
      };
      expect(args).toEqual(
        expect.arrayContaining([
          "--network",
          "none",
          "--read-only",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "256",
          "--mount",
          expect.stringContaining("dst=/input,readonly"),
          "--tmpfs",
          expect.stringContaining("/scratch:rw,noexec,nosuid,nodev"),
          "--entrypoint",
          "/usr/local/bin/openmapx-backup-subject-export",
        ]),
      );
      expect(args).not.toContain("--privileged");
      expect(args.join(" ")).not.toContain("subject-1");
      return child;
    });
    const runtime = createPrivacyBackupExtractionRuntime({
      rootDir: backup.root,
      scratchRoot,
      collectorImage: `ghcr.io/openmapx/privacy-backup@sha256:${"a".repeat(64)}`,
      spawnImpl: spawn as unknown as typeof import("node:child_process").spawn,
    });
    const input = request(backup.backupId, backup.manifestDigest);
    const source = await runtime.runCollector(
      input,
      {
        backupId: input.backupId,
        manifestDigest: input.manifestDigest,
        platformVersion: "1.0.0",
        formatVersion: 2,
        verified: true,
      },
      new AbortController().signal,
    );
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("tar\n");
    expect(spawn.mock.calls[0]?.[1]).toContain("run");
    expect(readdirSync(scratchRoot)).toEqual([]);
  });

  it("never accepts an unpinned collector or a scratch root outside the trusted boundary", async () => {
    const backup = makeBackup();
    const input = request(backup.backupId, backup.manifestDigest);
    const unpinned = createPrivacyBackupExtractionRuntime({
      rootDir: backup.root,
      collectorImage: "ghcr.io/openmapx/privacy-backup:latest",
    });
    expect(unpinned.enabled).toBe(false);
    await expect(
      unpinned.runCollector(
        input,
        {
          backupId: input.backupId,
          manifestDigest: input.manifestDigest,
          platformVersion: "1.0.0",
          formatVersion: 2,
          verified: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "not_configured" });

    const outside = createPrivacyBackupExtractionRuntime({
      rootDir: backup.root,
      scratchRoot: join(tmpdir(), "openmapx-untrusted-scratch"),
      collectorImage: `ghcr.io/openmapx/privacy-backup@sha256:${"b".repeat(64)}`,
    });
    await expect(
      outside.runCollector(
        input,
        {
          backupId: input.backupId,
          manifestDigest: input.manifestDigest,
          platformVersion: "1.0.0",
          formatVersion: 2,
          verified: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/outside the repository/);
  });

  it("janitors only old, marker-owned case directories", () => {
    const backup = makeBackup();
    const scratchRoot = join(backup.root, "scratch");
    mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const oldCase = join(scratchRoot, "case-old");
    mkdirSync(oldCase, { mode: 0o700 });
    writeFileSync(
      join(oldCase, "marker.json"),
      JSON.stringify({
        marker: "openmapx-privacy-backup-extraction-v1",
        requestId: randomUUID(),
        backupId: backup.backupId,
      }) + "\n",
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 3 * 60 * 60 * 1_000);
    utimesSync(oldCase, old, old);
    const foreign = join(scratchRoot, "case-foreign");
    mkdirSync(foreign, { mode: 0o700 });
    writeFileSync(join(foreign, "marker.json"), "{}\n", { mode: 0o600 });
    expect(janitorPrivacyBackupScratch(backup.root, scratchRoot)).toEqual({
      removed: 1,
      retained: 1,
    });
    expect(statSync(foreign).isDirectory()).toBe(true);
  });
});
