import { type ChildProcess, fork, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { services } from "@openmapx/core/server";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBackup } from "../src/commands/backup";
import { tarVolumeToFile } from "../src/commands/backup-processes";

const enabled = process.env.OPENMAPX_RUN_RESTORE_DATABASE_TESTS === "1";
const IMAGE =
  "ghcr.io/baosystems/postgis:18-3.6@sha256:dd7515b7d8b8b8bac3516a9c3e12584df5890b0864c29295c1b934ecd1db81a7";
const loader = createRequire(import.meta.url).resolve("tsx/esm");

describe.runIf(enabled)("backup cancellation through real Docker", () => {
  let root: string;
  let composeArgs: string[];
  let realDocker: string;
  let project: string;
  let sourceVolume: string;
  let cleanupAllowed = false;

  async function docker(args: string[], input?: Buffer) {
    const result = await execa(realDocker, args, { input, timeout: 30000, reject: false });
    if (result.failed) throw Error(`Fixture Docker command failed: ${result.stderr.slice(-4096)}`);
    return result.stdout.trim();
  }

  const sql = (database: string, statement: string) =>
    docker([
      ...composeArgs,
      "exec",
      "-T",
      "postgis",
      "psql",
      "-U",
      "postgres",
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      statement,
    ]);

  function observe(child: ChildProcess) {
    let output = "";
    child.stdout?.on("data", () => {});
    child.stderr?.on("data", (chunk) => {
      output = (output + chunk).slice(-4096);
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: unknown;
    }>((resolveExit) => {
      child.once("error", (error) => resolveExit({ code: null, signal: null, error }));
      child.once("close", (code, signal) => resolveExit({ code, signal }));
    });
    return { child, closed, output: () => output };
  }

  function startDocker(args: string[]) {
    return observe(spawn(realDocker, args, { stdio: ["ignore", "pipe", "pipe"] }));
  }

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "openmapx-backup-real-"));
    realDocker = (await execa("which", ["docker"])).stdout.trim();
    if (!realDocker.startsWith("/")) throw Error("Fixture Docker executable must be absolute");
    project = `openmapx-backup-proof-${randomUUID()}`;
    const infra = join(root, "infra/docker");
    mkdirSync(join(root, "services/postgis"), { recursive: true });
    mkdirSync(join(root, "bin"));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(
      join(root, "services/postgis/service.json"),
      JSON.stringify({
        id: "postgis",
        name: "Synthetic Postgres",
        version: "1.0.0",
        quality: "built-in",
        container: {
          image: "synthetic/postgis",
          tag: "fixture",
          environment: {
            POSTGRES_USER: "postgres",
            POSTGRES_DB: "target",
          },
        },
        volumes: [{ name: "openmapx-pgdata", mountAt: "/db", backup: true, backupMode: "pg_dump" }],
      }),
    );
    const composeYaml = `name: ${project}
services:
  postgis:
    image: ${IMAGE}
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: synthetic-fixture-password
      POSTGRES_DB: target
    volumes:
      - pgdata:/var/lib/postgresql
      - source:/fixture-source
volumes:
  pgdata:
  source:
`;
    const revision = `cfg1_${createHash("sha256").update(composeYaml).digest("base64url")}`;
    const generation = join(infra, services.CONFIGURATION_GENERATIONS, revision);
    const current = join(infra, services.CURRENT_CONFIGURATION);
    mkdirSync(generation, { recursive: true, mode: 0o700 });
    const compose = join(generation, services.GENERATED_COMPOSE_FILE);
    writeFileSync(compose, composeYaml, { mode: 0o400 });
    writeFileSync(
      join(generation, "resolved-config.generated.json"),
      JSON.stringify({ serviceConfigs: [], integrationConfigs: [] }),
      { mode: 0o400 },
    );
    symlinkSync(relative(dirname(current), generation), current);
    symlinkSync(
      `generations/${revision}`,
      services.configurationGenerationBasePath(infra, revision),
    );
    composeArgs = ["compose", "-f", compose];
    const definition = JSON.parse(await docker([...composeArgs, "config", "--format", "json"]));
    expect(definition.name).toBe(project);
    sourceVolume = definition.volumes.source.name;
    if (!sourceVolume.startsWith(project)) throw Error("Wrong fixture volume identity");
    cleanupAllowed = true;
    await docker([...composeArgs, "up", "-d", "postgis"]);
    await vi.waitFor(
      async () => {
        const logs = await docker([...composeArgs, "logs", "--no-color", "postgis"]);
        expect(logs).toContain("PostgreSQL init process complete; ready for start up.");
        expect(await sql("target", "SELECT 1")).toBe("1");
      },
      { timeout: 90000, interval: 250 },
    );
    await sql("target", "CREATE DATABASE unrelated");
    await sql("target", "CREATE DATABASE restored");
    for (const database of ["target", "unrelated"]) {
      await sql(
        database,
        "CREATE TABLE backup_probe(id integer PRIMARY KEY, label text); INSERT INTO backup_probe VALUES (1,'synthetic'),(2,'retained')",
      );
    }
    // Namespace the fixed production project, then exec Docker in place. There
    // is no spawnSync child layer to obscure real client/group signals.
    writeFileSync(
      join(root, "bin/docker"),
      `#!/bin/sh
previous=
for argument do
  case "$previous" in
    --name) printf '%s' "$argument" > "$OPENMAPX_TEST_TAR_NAME" ;;
  esac
  previous=$argument
done
if [ "$1" = compose ]; then
  if [ "$2" != --project-name ] || [ "$3" != openmapx ]; then
    echo 'Refusing non-fixture Compose invocation' >&2
    exit 78
  fi
  shift 3
  for argument do
    case "$argument" in
      --project-name|--project-name=*|-p|-p?*)
        echo 'Refusing non-fixture Compose invocation' >&2
        exit 78 ;;
    esac
  done
  set -- compose --project-name "$OPENMAPX_TEST_PROJECT" "$@"
fi
exec "$OPENMAPX_TEST_REAL_DOCKER" "$@"
`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", `${join(root, "bin")}:${process.env.PATH ?? ""}`);
    vi.stubEnv("OPENMAPX_ROOT_DIR", root);
    vi.stubEnv("OPENMAPX_ENABLED_SERVICES", "postgis");
    vi.stubEnv("BACKUP_RETENTION_DAYS", "30");
    vi.stubEnv("OPENMAPX_TEST_REAL_DOCKER", realDocker);
    vi.stubEnv("OPENMAPX_TEST_PROJECT", project);
    vi.stubEnv("OPENMAPX_TEST_TAR_NAME", join(root, "tar-name"));
    await docker([
      "run",
      "--rm",
      "-v",
      `${sourceVolume}:/source`,
      "alpine",
      "sh",
      "-c",
      "printf synthetic > /source/value",
    ]);
  }, 120000);

  afterAll(async () => {
    try {
      if (cleanupAllowed) await docker([...composeArgs, "down", "--volumes", "--timeout", "5"]);
    } finally {
      vi.unstubAllEnvs();
      if (root) rmSync(root, { recursive: true, force: true });
    }
  }, 60000);

  it.each([
    ["compose", "-p", "openmapx"],
    ["compose", "--project-name", "openmapx", "--project-name", "openmapx"],
  ])("refuses a Compose invocation outside the exact fixture namespace: %j", async (...prefix) => {
    // Read-only even if the guard regresses: only render our synthetic file.
    const result = await execa(
      join(root, "bin/docker"),
      [...prefix, ...composeArgs.slice(1), "config", "--format", "json"],
      { reject: false },
    );
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain("Refusing non-fixture Compose invocation");
  });

  it.each([
    { signal: "SIGTERM" as const, group: false },
    { signal: "SIGINT" as const, group: false },
    { signal: "SIGTERM" as const, group: true },
    { signal: "SIGINT" as const, group: true },
  ])(
    "cancels only the target dump on $signal (group=$group)",
    async ({ signal, group }) => {
      const nonce = randomUUID();
      const lockNames = [`target-lock-${nonce}`, `other-lock-${nonce}`];
      const locks = ["target", "unrelated"].map((database, index) =>
        startDocker([
          ...composeArgs,
          "exec",
          "-T",
          "-e",
          `PGAPPNAME=${lockNames[index]}`,
          "postgis",
          "psql",
          "-U",
          "postgres",
          "-d",
          database,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "BEGIN; LOCK TABLE backup_probe IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(120); COMMIT;",
        ]),
      );
      let other: ReturnType<typeof startDocker> | undefined;
      let cli: ReturnType<typeof observe> | undefined;
      try {
        for (let i = 0; i < lockNames.length; i++) {
          await vi.waitFor(
            async () =>
              expect(
                await sql(
                  "target",
                  `SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='${lockNames[i]}' AND l.mode='AccessExclusiveLock' AND l.granted`,
                ),
              ).toBe("1"),
            { timeout: 10000 },
          );
        }
        other = startDocker([
          ...composeArgs,
          "exec",
          "-T",
          "-e",
          `PGAPPNAME=other-dump-${nonce}`,
          "postgis",
          "pg_dump",
          "-U",
          "postgres",
          "--no-owner",
          "--no-privileges",
          "unrelated",
        ]);
        const name = `cancel-${nonce}`;
        cli = observe(
          fork(
            resolve(import.meta.dirname, "../src/index.ts"),
            ["backup", "create", "--name", name],
            {
              execArgv: ["--import", loader],
              detached: true,
              cwd: root,
              env: { ...process.env },
              stdio: ["ignore", "pipe", "pipe", "ipc"],
            },
          ),
        );
        const activeCli = cli;
        await vi.waitFor(
          async () => {
            expect(activeCli.child.exitCode, activeCli.output()).toBe(null);
            expect(
              await sql(
                "target",
                "SELECT count(*) FROM pg_stat_activity WHERE datname='target' AND application_name='pg_dump' AND wait_event_type='Lock'",
              ),
            ).toBe("1");
            expect(
              await sql(
                "target",
                `SELECT count(*) FROM pg_stat_activity WHERE application_name='other-dump-${nonce}' AND wait_event_type='Lock'`,
              ),
            ).toBe("1");
          },
          { timeout: 10000 },
        );
        if (!cli.child.pid) throw Error("Missing fixture CLI pid");
        if (group) process.kill(-cli.child.pid, signal);
        else cli.child.kill(signal);
        await vi.waitFor(
          () =>
            expect(activeCli.child.exitCode !== null || activeCli.child.signalCode !== null).toBe(
              true,
            ),
          { timeout: 5000 },
        );
        expect(await cli.closed, cli.output()).toEqual({ code: 130, signal: null });
        expect(existsSync(join(root, "infra/docker/backups", name))).toBe(false);
        // This fixture exercises pg_dump's TERM handler, not the KILL fallback.
        await vi.waitFor(
          async () =>
            expect(
              await sql(
                "target",
                "SELECT count(*) FROM pg_stat_activity WHERE datname='target' AND application_name='pg_dump'",
              ),
            ).toBe("0"),
          { timeout: 5000 },
        );
        const container = await docker([...composeArgs, "ps", "-q", "postgis"]);
        const processes = await docker(["top", container, "-eo", "pid,args"]);
        expect(processes.split("\n").some((line) => /pg_dump -U postgres target$/.test(line))).toBe(
          false,
        );
        expect(
          await sql(
            "target",
            `SELECT count(*) FROM pg_stat_activity WHERE application_name='other-dump-${nonce}' AND wait_event_type='Lock'`,
          ),
        ).toBe("1");
      } finally {
        await sql(
          "target",
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name IN ('${lockNames[0]}','${lockNames[1]}','other-dump-${nonce}') OR (datname='target' AND application_name='pg_dump')`,
        );
        if (cli?.child.pid) {
          try {
            process.kill(-cli.child.pid, "SIGKILL");
          } catch {}
        }
        await cli?.closed;
        for (const fixture of [...locks, ...(other ? [other] : [])]) {
          if (fixture.child.exitCode === null && fixture.child.signalCode === null)
            fixture.child.kill("SIGKILL");
          await fixture.closed;
        }
      }
    },
    60000,
  );

  it("restores the confirmed SQL gzip without changing the backup format", async () => {
    const result = await createBackup({ rootDir: root, name: "normal" });
    const volume = result.manifest.services[0]?.volumes[0];
    if (!volume) throw Error("Missing SQL fixture backup");
    expect(result.manifest.formatVersion).toBe(2);
    const sqlBytes = gunzipSync(readFileSync(join(result.directory, volume.file)));
    await docker(
      [
        ...composeArgs,
        "exec",
        "-T",
        "postgis",
        "psql",
        "-U",
        "postgres",
        "-d",
        "restored",
        "-v",
        "ON_ERROR_STOP=1",
      ],
      sqlBytes,
    );
    expect(await sql("restored", "SELECT id || ':' || label FROM backup_probe ORDER BY id")).toBe(
      "1:synthetic\n2:retained",
    );
  }, 60000);

  it("creates a valid archive and leaves its source volume unchanged", async () => {
    const directory = mkdtempSync(join(root, "tar-normal-"));
    await tarVolumeToFile(sourceVolume, directory, "archive.gz");
    const bytes = readFileSync(join(directory, "archive.gz"));
    expect(
      await docker(["run", "--rm", "-i", "alpine", "tar", "-xzOf", "-", "./value"], bytes),
    ).toBe("synthetic");
    expect(
      await docker([...composeArgs, "exec", "-T", "postgis", "cat", "/fixture-source/value"]),
    ).toBe("synthetic");
  }, 60000);

  it("contains a blocked tar helper with init and preserves the source", async () => {
    const directory = mkdtempSync(join(root, "tar-cancel-"));
    await execa("mkfifo", [join(directory, "archive.gz")]);
    rmSync(join(root, "tar-name"), { force: true });
    const controller = new AbortController();
    const observed = tarVolumeToFile(
      sourceVolume,
      directory,
      "archive.gz",
      controller.signal,
    ).catch((error) => error);
    let name: string | undefined;
    try {
      await vi.waitFor(
        async () => {
          name = readFileSync(join(root, "tar-name"), "utf8");
          expect(name).toMatch(/^openmapx-backup-tar-[0-9a-f-]{36}$/);
          const inspection = JSON.parse(await docker(["inspect", name]))[0];
          expect(inspection.State.Running).toBe(true);
          expect(inspection.HostConfig.Init).toBe(true);
          expect(
            inspection.Mounts.find(
              (mount: { Destination: string }) => mount.Destination === "/source",
            ).RW,
          ).toBe(false);
        },
        { timeout: 10000 },
      );
      controller.abort(Error("Cancel real archive"));
      expect(await observed).toEqual(Error("Cancel real archive"));
      expect(await docker(["ps", "-aq", "--filter", `name=^/${name}$`])).toBe("");
      expect(
        await docker([...composeArgs, "exec", "-T", "postgis", "cat", "/fixture-source/value"]),
      ).toBe("synthetic");
    } finally {
      controller.abort();
      await observed;
      if (name?.startsWith("openmapx-backup-tar-"))
        await docker(["rm", "--force", name]).catch(() => {});
    }
  }, 30000);
});
