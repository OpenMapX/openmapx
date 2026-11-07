import filesystem, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackup } from "../src/commands/backup";
import {
  BackupWriterUnresolvedError,
  pgDumpToFile,
  tarVolumeToFile,
} from "../src/commands/backup-processes";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../src/commands/backup-processes", async (original) => ({
  ...(await original<typeof import("../src/commands/backup-processes")>()),
  pgDumpToFile: vi.fn(),
  tarVolumeToFile: vi.fn(),
}));

let root: string;
let events: string[];
let failedStops: Set<string>;
let failedStarts: Map<string, number>;

function service(id: string) {
  mkdirSync(join(root, "services", id), { recursive: true });
  writeFileSync(
    join(root, "services", id, "service.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: "synthetic/service", tag: "fixture" },
      volumes: [{ name: `openmapx-${id}-data`, mountAt: "/data", backup: true, backupMode: "tar" }],
    }),
  );
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-backup-lifecycle-"));
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  service("postgis");
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  vi.stubEnv("OPENMAPX_ENABLED_SERVICES", "postgis");
  vi.stubEnv("BACKUP_RETENTION_DAYS", "30");
  events = [];
  failedStops = new Set();
  failedStarts = new Map();
  vi.mocked(execa).mockImplementation(((_command: string, args: string[]) => {
    if (args.includes("config"))
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify({ name: "fixture" }),
        stderr: "",
      });
    const action = args.includes("start") ? "start" : args.includes("stop") ? "stop" : undefined;
    if (!action) throw Error(`Unexpected fixture operation ${args.join(" ")}`);
    const id = args.at(-1) ?? "";
    events.push(`${action}:${id}`);
    const failure = action === "stop" ? failedStops.delete(id) : (failedStarts.get(id) ?? 0) > 0;
    if (action === "start" && failure) failedStarts.set(id, (failedStarts.get(id) ?? 0) - 1);
    return Promise.resolve({
      exitCode: failure ? 1 : 0,
      stdout: "",
      stderr: failure ? "refused" : "",
    });
  }) as never);
  vi.mocked(pgDumpToFile).mockImplementation(async (_ctx, _service, _user, _db, output) => {
    writeFileSync(output, "synthetic SQL");
  });
  vi.mocked(tarVolumeToFile).mockImplementation(async (_volume, directory, name) => {
    events.push("archive");
    writeFileSync(join(directory, name), "synthetic archive");
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  vi.mocked(execa).mockReset();
  vi.mocked(pgDumpToFile).mockReset();
  vi.mocked(tarVolumeToFile).mockReset();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("keeps a published backup when restarting the service fails", async () => {
  failedStarts.set("postgis", 2);
  await expect(createBackup({ rootDir: root, name: "published" })).rejects.toThrow("refused");
  const manifest = join(root, "infra/docker/backups/published/manifest.json");
  expect(existsSync(manifest)).toBe(true);
  expect(JSON.parse(readFileSync(manifest, "utf8")).name).toBe("published");
});

it("retries only failed restarts after publication", async () => {
  service("tileserver");
  vi.stubEnv("OPENMAPX_ENABLED_SERVICES", "postgis,tileserver");
  failedStarts.set("postgis", 1);
  await expect(createBackup({ rootDir: root, name: "restart" })).rejects.toThrow("refused");
  expect(events.filter((event) => event === "start:tileserver")).toHaveLength(1);
  expect(events.filter((event) => event === "start:postgis")).toHaveLength(2);
});

it("restarts a service even when the stop acknowledgement fails", async () => {
  failedStops.add("postgis");
  await expect(createBackup({ rootDir: root, name: "stop" })).rejects.toThrow("refused");
  expect(events).toEqual(["stop:postgis", "start:postgis"]);
});

it("preserves incomplete files while an archive writer remains unresolved", async () => {
  vi.mocked(tarVolumeToFile).mockImplementation(async (_volume, directory, name) => {
    writeFileSync(join(directory, name), "partial");
    throw new BackupWriterUnresolvedError("Unresolved fixture writer");
  });
  await expect(createBackup({ rootDir: root, name: "unresolved" })).rejects.toThrow("Unresolved");
  const directory = join(root, "infra/docker/backups/unresolved");
  expect(existsSync(join(directory, "postgis__openmapx-postgis-data.tar.gz"))).toBe(true);
  expect(existsSync(join(directory, "manifest.json"))).toBe(false);
});

it("preserves the published manifest when its directory fsync reports failure", async () => {
  const manifest = join(root, "infra/docker/backups/ambiguous/manifest.json");
  const realFsync = filesystem.fsyncSync;
  let injected = false;
  vi.spyOn(filesystem, "fsyncSync").mockImplementation((fd) => {
    if (!injected && existsSync(manifest)) {
      injected = true;
      throw Error("Post-rename fsync failed");
    }
    realFsync(fd);
  });
  syncBuiltinESMExports();
  await expect(createBackup({ rootDir: root, name: "ambiguous" })).rejects.toThrow("Post-rename");
  expect(injected).toBe(true);
  expect(existsSync(manifest)).toBe(true);
});

it("checks cancellation after the final hash before publishing", async () => {
  const registration = vi.spyOn(process, "on");
  const forcedExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw Error("Unexpected forced exit");
  });
  const realRead = filesystem.createReadStream;
  const signalTasks: Promise<unknown>[] = [];
  let interrupted = false;
  vi.spyOn(filesystem, "createReadStream").mockImplementation((path, options) => {
    const stream = realRead(path, options);
    if (!interrupted && String(path).endsWith(".tar.gz")) {
      interrupted = true;
      const listener = registration.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      if (typeof listener !== "function") throw Error("Backup signal handler missing");
      // Invoke this backup's registered handler; never signal the test worker.
      queueMicrotask(() => {
        signalTasks.push(
          Promise.resolve(Reflect.apply(listener, process, [])).catch((error) => error),
        );
      });
    }
    return stream;
  });
  syncBuiltinESMExports();
  try {
    await expect(createBackup({ rootDir: root, name: "hash" })).rejects.toThrow(
      "Backup interrupted",
    );
    expect(interrupted).toBe(true);
    expect(existsSync(join(root, "infra/docker/backups/hash"))).toBe(false);
    expect(events.filter((event) => event === "start:postgis")).toHaveLength(1);
    expect(forcedExit).not.toHaveBeenCalled();
  } finally {
    await Promise.all(signalTasks);
  }
});

it("keeps a published backup when cancellation arrives during restart", async () => {
  const registration = vi.spyOn(process, "on");
  const forcedExit = vi.spyOn(process, "exit").mockImplementation(() => {
    throw Error("Unexpected forced exit");
  });
  const normal = vi.mocked(execa).getMockImplementation();
  if (!normal) throw Error("Missing Docker fixture");
  let interrupted = false;
  vi.mocked(execa).mockImplementation(((command: string, args: string[]) => {
    const result = Reflect.apply(normal, undefined, [command, args]);
    if (!interrupted && args.includes("start")) {
      interrupted = true;
      const listener = registration.mock.calls.find(([event]) => event === "SIGTERM")?.[1];
      if (typeof listener !== "function") throw Error("Backup signal handler missing");
      Reflect.apply(listener, process, []);
    }
    return result;
  }) as never);
  await expect(createBackup({ rootDir: root, name: "late" })).rejects.toThrow("Backup interrupted");
  expect(existsSync(join(root, "infra/docker/backups/late/manifest.json"))).toBe(true);
  expect(events.filter((event) => event === "start:postgis")).toHaveLength(2);
  expect(forcedExit).not.toHaveBeenCalled();
});
