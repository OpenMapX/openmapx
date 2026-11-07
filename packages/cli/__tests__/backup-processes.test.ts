import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackup } from "../src/commands/backup";
import {
  BackupWriterUnresolvedError,
  pgDumpToFile,
  tarVolumeToFile,
} from "../src/commands/backup-processes";
import { withCliExecutionDeadline } from "../src/lib/execution-deadline";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-backup-transport-"));
  mkdirSync(join(root, "services/postgis"), { recursive: true });
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    join(root, "services/postgis/service.json"),
    JSON.stringify({
      id: "postgis",
      name: "Synthetic database",
      version: "1.0.0",
      quality: "built-in",
      container: {
        image: "synthetic/postgres",
        tag: "fixture",
        environment: { POSTGRES_USER: "postgres", POSTGRES_DB: "synthetic" },
      },
      volumes: [{ name: "openmapx-pgdata", mountAt: "/db", backup: true, backupMode: "pg_dump" }],
    }),
  );
  // Only these fixed transport calls are accepted. Nothing can reach real Docker.
  writeFileSync(
    join(root, "bin/docker"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const file = name => path.join(process.env.BACKUP_FIXTURE_ROOT, name);
const mode = process.env.BACKUP_FIXTURE_MODE;
fs.appendFileSync(file('commands'), JSON.stringify(args) + '\\n');
if (args[0] === 'compose' && args.includes('config')) {
  process.stdout.write(JSON.stringify({name:'fixture',volumes:{'openmapx-pgdata':{name:'fixture_pgdata'}}}));
  process.exit(0);
}
if (args[0] === 'compose' && (args.includes('start') || args.includes('stop'))) process.exit(0);
if (args[0] === 'rm') {
  if (!args[2].startsWith('openmapx-backup-tar-') || args.includes('-v')) process.exit(73);
  if (fs.existsSync(file('container'))) {
    const state = JSON.parse(fs.readFileSync(file('container')));
    if (state.name !== args[2]) process.exit(74);
    let alive = false;
    try { process.kill(state.pid, 0); alive = true; } catch {}
    if (alive) { console.error('client not reaped'); process.exit(76); }
    if (mode === 'tar-unresolved') process.exit(1);
    fs.unlinkSync(file('container'));
  }
  process.exit(0);
}
if (args[0] === 'ps') {
  if (fs.existsSync(file('container'))) {
    const state = JSON.parse(fs.readFileSync(file('container')));
    if (!args.includes('label=' + state.label)) process.exit(75);
    process.stdout.write('a'.repeat(64) + '\\n');
  }
  process.exit(0);
}
if (args[0] === 'run') {
  if (mode === 'tar-init-missing') { console.error('docker-init not found'); process.exit(125); }
  const oldBind = args.find(arg => arg.endsWith(':/backup'));
  const bind = args.find(arg => arg.startsWith('type=bind,'));
  const dir = oldBind ? oldBind.slice(0,-8) : bind.split(',').find(arg => arg.startsWith('source=')).slice(7);
  const output = args[args.indexOf('-czf') + 1].slice('/backup/'.length);
  fs.writeFileSync(path.join(dir,output),'synthetic archive');
  if (mode.startsWith('tar-hold') || mode === 'tar-unresolved') {
    fs.writeFileSync(file('container'),JSON.stringify({name:args[args.indexOf('--name')+1],label:args[args.indexOf('--label')+1],pid:process.pid}));
    fs.writeFileSync(file('started.partial'),String(process.pid));
    fs.renameSync(file('started.partial'),file('started'));
    process.on('SIGTERM', () => {
      fs.writeFileSync(file('finished'),'client ended');
      process.exit(130);
    });
    setInterval(() => {},1000);
  } else {
    if (mode === 'tar-chatty') {
      process.stdout.write('progress'.repeat(15000));
      process.stderr.write('warning'.repeat(15000));
    }
    process.exitCode = 0;
  }
} else if (args[0] !== 'compose' || !args.includes('exec') || !args.includes('pg_dump')) {
  console.error('Unexpected fixture command'); process.exit(71);
} else if (mode === 'docker-refused') {
  process.stderr.write('service postgis is not running');
  process.exitCode = 1;
} else {
const marker = args.indexOf('openmapx-backup-pg-dump');
const token = marker >= 0 ? args[marker + 1] : 'unconfirmed';
if (mode.startsWith('hold')) {
  fs.writeFileSync(file('started.partial'), String(process.pid));
  fs.renameSync(file('started.partial'), file('started'));
  process.stdout.on('error', () => {});
  let ending = false;
  const finish = () => {
    if (ending) return;
    ending = true;
    setTimeout(() => {
      fs.writeFileSync(file('finished'), 'settled');
      process.stderr.write('\\n' + token + ' DONE 130\\n');
      process.exit(130);
    }, 100);
  };
  process.stdin.on('end', () => { if (mode !== 'hold-ignore') finish(); });
  process.stdin.resume();
  process.on('SIGTERM', () => { if (mode !== 'hold-ignore') finish(); });
  process.on('SIGINT', () => { if (mode !== 'hold-ignore') finish(); });
  setInterval(() => process.stdout.write('SELECT 1;\\n'), 20);
} else {
  process.stdout.write('SELECT 1;\\n');
  if (mode === 'bash-missing') process.exit(127);
  if (mode !== 'unconfirmed') {
    if (mode === 'diagnostics') process.stderr.write('x'.repeat(100000) + '\\nno trailing newline');
    const actual = mode === 'wrong-token' ? 'another-token' : token;
    const record = '\\n' + actual + ' DONE ' + (mode === 'failed-dump' ? 7 : 0) + '\\n';
    process.stderr.write(record);
    if (mode === 'duplicate') process.stderr.write(record);
  }
  process.exitCode = 0;
}
}
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`);
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  vi.stubEnv("OPENMAPX_ENABLED_SERVICES", "postgis");
  vi.stubEnv("BACKUP_RETENTION_DAYS", "30");
  vi.stubEnv("BACKUP_FIXTURE_MODE", "complete");
  vi.stubEnv("BACKUP_FIXTURE_ROOT", root);
});

it.each(["wrong-token", "duplicate"])("refuses a %s completion record", async (mode) => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", mode);
  await expect(createBackup({ rootDir: root, name: "malformed" })).rejects.toThrow(
    /dump completion.*unconfirmed/i,
  );
});

it("refuses a failed dump even when its Docker client exits zero", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "failed-dump");
  await expect(createBackup({ rootDir: root, name: "failed" })).rejects.toThrow(/pg_dump failed/);
});

it("recovers a completion line after oversized diagnostics and a missing newline", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "diagnostics");
  await expect(createBackup({ rootDir: root, name: "diagnostics" })).resolves.toMatchObject({
    name: "diagnostics",
  });
});

it("reports a missing Bash prerequisite distinctly", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "bash-missing");
  await expect(createBackup({ rootDir: root, name: "missing" })).rejects.toThrow(
    "Bash unavailable in postgis image",
  );
});

it("keeps Docker diagnostics and exit status when the dump has no completion record", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "docker-refused");
  await expect(createBackup({ rootDir: root, name: "refused" })).rejects.toThrow(
    "pg_dump completion is unconfirmed for postgis (exit 1): service postgis is not running",
  );
});

it.each(["hold", "hold-ignore"])(
  "drains the %s client before cancellation returns",
  async (mode) => {
    vi.stubEnv("BACKUP_FIXTURE_MODE", mode);
    const controller = new AbortController();
    const run = pgDumpToFile(
      { cwd: root, composeArgs: ["compose"] },
      "postgis",
      "postgres",
      "synthetic",
      join(root, "partial.gz"),
      controller.signal,
    );
    const observed = run.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true));
      const pid = Number(readFileSync(join(root, "started"), "utf8"));
      controller.abort(Error("Operator cancelled"));
      expect(await observed).toEqual(Error("Operator cancelled"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(join(root, "finished"))).toBe(mode === "hold");
    } finally {
      controller.abort();
      await observed;
    }
  },
);

it("waits for the client when the output file fails", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "hold");
  await expect(
    pgDumpToFile({ cwd: root, composeArgs: ["compose"] }, "postgis", "postgres", "synthetic", root),
  ).rejects.toMatchObject({ code: "EISDIR" });
  expect(existsSync(join(root, "finished"))).toBe(true);
});

it("does not launch an already cancelled dump", async () => {
  const controller = new AbortController();
  controller.abort(Error("Already cancelled"));
  await expect(
    pgDumpToFile(
      { cwd: root, composeArgs: ["compose"] },
      "postgis",
      "postgres",
      "synthetic",
      join(root, "absent.gz"),
      controller.signal,
    ),
  ).rejects.toThrow("Already cancelled");
  expect(existsSync(join(root, "absent.gz"))).toBe(false);
});

it("spends the existing CLI deadline and drains the client before refusing completion", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "hold");
  vi.stubEnv("OPENMAPX_CLI_DEADLINE_AT", String(Date.now() + 1000));
  await expect(
    withCliExecutionDeadline(["backup", "create"], () =>
      pgDumpToFile(
        { cwd: root, composeArgs: ["compose"] },
        "postgis",
        "postgres",
        "synthetic",
        join(root, "deadline.gz"),
      ),
    ),
  ).rejects.toThrow("Execution deadline elapsed");
  expect(existsSync(join(root, "finished"))).toBe(true);
  const pid = Number(readFileSync(join(root, "started"), "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

it("refuses a clean Docker exit without a dump completion record", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "unconfirmed");
  await expect(createBackup({ rootDir: root, name: "incomplete" })).rejects.toThrow(
    /dump completion.*unconfirmed/i,
  );
});

it("keeps the existing SQL gzip and manifest format after confirmed completion", async () => {
  const result = await createBackup({ rootDir: root, name: "complete" });
  const volume = result.manifest.services[0]?.volumes[0];
  if (!volume) throw Error("Missing fixture backup volume");
  expect(result.manifest.formatVersion).toBe(2);
  expect(volume).toMatchObject({
    mode: "pg_dump",
    postgresUser: "postgres",
    postgresDb: "synthetic",
  });
  expect(volume?.file).toBe("postgis__openmapx-pgdata.sql.gz");
  expect(gunzipSync(readFileSync(join(result.directory, volume.file))).toString()).toBe(
    "SELECT 1;\n",
  );
});

it("gives the tar writer an init process and a non-recreating backup bind", async () => {
  const manifestPath = join(root, "services/postgis/service.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.volumes[0].backupMode = "tar";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await createBackup({ rootDir: root, name: "archive" });
  const commands = readFileSync(join(root, "commands"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  const run = commands.find((args) => args[0] === "run");
  expect(run).toContain("--init");
  expect(run).toContain("--mount");
  expect(run).toContain(
    `type=bind,source=${join(root, "infra/docker/backups/archive")},target=/backup`,
  );
});

it("drains chatty archive output without terminating a successful writer", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "tar-chatty");
  await expect(tarVolumeToFile("fixture_volume", root, "archive.gz")).resolves.toBeUndefined();
  expect(readFileSync(join(root, "archive.gz"), "utf8")).toBe("synthetic archive");
});

it("refuses a comma in the tar bind path before stopping services", async () => {
  const oldRoot = root;
  root = `${root},comma`;
  renameSync(oldRoot, root);
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  vi.stubEnv("BACKUP_FIXTURE_ROOT", root);
  vi.stubEnv("PATH", `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`);
  const manifestPath = join(root, "services/postgis/service.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.volumes[0].backupMode = "tar";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await expect(createBackup({ rootDir: root, name: "unsupported" })).rejects.toThrow(
    /unsupported backup bind path/i,
  );
  expect(existsSync(join(root, "commands"))).toBe(false);
});

it("reaps the tar client before removing only its named and labelled helper", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "tar-hold");
  const controller = new AbortController();
  const observed = tarVolumeToFile("fixture_volume", root, "archive.gz", controller.signal).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true));
    controller.abort(Error("Cancel archive"));
    expect(await observed).toEqual(Error("Cancel archive"));
    expect(existsSync(join(root, "container"))).toBe(false);
    const commands: string[][] = readFileSync(join(root, "commands"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const removal = commands.find((args) => args[0] === "rm");
    expect(removal).toHaveLength(3);
    expect(removal?.[1]).toBe("--force");
    expect(removal?.[2]).toMatch(/^openmapx-backup-tar-[0-9a-f-]{36}$/);
    expect(
      commands.some(
        (args) =>
          args[0] === "ps" &&
          args.includes("-aq") &&
          args.some((arg) => arg.startsWith("label=openmapx.backup-writer=")),
      ),
    ).toBe(true);
  } finally {
    controller.abort();
    await observed;
  }
});

it("reports an unresolved archive writer instead of assuming a failed removal succeeded", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "tar-unresolved");
  const controller = new AbortController();
  const observed = tarVolumeToFile("fixture_volume", root, "archive.gz", controller.signal).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(existsSync(join(root, "started"))).toBe(true));
    controller.abort(Error("Cancel archive"));
    expect(await observed).toBeInstanceOf(BackupWriterUnresolvedError);
    expect(existsSync(join(root, "container"))).toBe(true);
    expect(existsSync(join(root, "archive.gz"))).toBe(true);
  } finally {
    controller.abort();
    await observed;
  }
});

it("can quiesce its owned helper after the existing CLI deadline expires", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "tar-hold");
  vi.stubEnv("OPENMAPX_CLI_DEADLINE_AT", String(Date.now() + 1000));
  await expect(
    withCliExecutionDeadline(["backup", "create"], () =>
      tarVolumeToFile("fixture_volume", root, "archive.gz"),
    ),
  ).rejects.toThrow("Execution deadline elapsed");
  expect(existsSync(join(root, "container"))).toBe(false);
});

it("reports the engine init prerequisite clearly", async () => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "tar-init-missing");
  await expect(tarVolumeToFile("fixture_volume", root, "archive.gz")).rejects.toThrow(
    "Docker init is unavailable",
  );
});

import { fork } from "node:child_process";

it.each([
  { signal: "SIGTERM" as const, group: false },
  { signal: "SIGINT" as const, group: false },
  { signal: "SIGTERM" as const, group: true },
  { signal: "SIGINT" as const, group: true },
])("actual CLI drains its writer on $signal (group=$group)", async ({ signal, group }) => {
  vi.stubEnv("BACKUP_FIXTURE_MODE", "hold-ignore");
  const child = fork(
    resolve(import.meta.dirname, "../src/index.ts"),
    ["backup", "create", "--name", "interrupted"],
    {
      execArgv: ["--import", createRequire(import.meta.url).resolve("tsx/esm")],
      detached: true,
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output = (output + chunk).slice(-4096);
  });
  child.stderr?.on("data", (chunk) => {
    output = (output + chunk).slice(-4096);
  });
  const exited = new Promise<unknown>((resolveExit, reject) => {
    child.once("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal }));
    child.once("error", reject);
  }).catch((error: unknown) => error);
  try {
    await vi.waitFor(() => expect(existsSync(join(root, "started")), output).toBe(true), {
      timeout: 5000,
    });
    const writer = Number(readFileSync(join(root, "started"), "utf8"));
    if (!child.pid) throw Error("Missing owned CLI fixture PID");
    if (group) process.kill(-child.pid, signal);
    else {
      child.kill(signal);
      child.kill(signal); // Repeat Node-only signals must not bypass draining.
    }
    await vi.waitFor(
      () => expect(child.exitCode !== null || child.signalCode !== null, output).toBe(true),
      { timeout: 5000 },
    );
    expect(await exited, output).toEqual({ code: 130, signal: null });
    expect(() => process.kill(writer, 0)).toThrow();
    expect(existsSync(join(root, "infra/docker/backups/interrupted"))).toBe(false);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
    await exited;
  }
});
