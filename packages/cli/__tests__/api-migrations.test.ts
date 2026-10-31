import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateBeforeApiUpdate, stopMigrationArgs } from "../src/lib/api-migrations";
import { dockerCompose, dockerComposeStream } from "../src/lib/docker";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));
vi.mock("../src/lib/docker", () => ({ dockerCompose: vi.fn(), dockerComposeStream: vi.fn() }));
vi.mock("../src/lib/paths", () => ({
  repoPaths: () => ({ infraDir: "/srv/openmapx/infra/docker" }),
}));
vi.mock("../src/lib/output", () => ({
  log: { warn: vi.fn(), err: vi.fn(), dim: vi.fn(), ok: vi.fn() },
}));

type Docker = (args: string[]) => { stdout?: string; exitCode?: number };

function docker(handle: Docker) {
  vi.mocked(execa).mockImplementation((async (_file: string, args: string[]) => ({
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...handle(args),
  })) as never);
}

const composeCalls = () => vi.mocked(dockerComposeStream).mock.calls.map(([args]) => args);
const dockerCalls = () => vi.mocked(execa).mock.calls.map(([, args]) => args);

const PROJECT_LABEL = "com.docker.compose.project=openmapx";
const MARKER = "org.openmapx.migration=app-api";
const FILTERS = ["--filter", `label=${PROJECT_LABEL}`, "--filter", `label=${MARKER}`];

beforeEach(() => {
  vi.mocked(dockerCompose)
    .mockReset()
    .mockResolvedValue({
      stdout: JSON.stringify({ name: "openmapx", services: {} }),
      stderr: "",
      exitCode: 0,
    });
  vi.mocked(dockerComposeStream).mockReset().mockResolvedValue(0);
  docker(() => ({}));
});
afterEach(() => vi.clearAllMocks());

describe("migrateBeforeApiUpdate", () => {
  it("stops app-api and migrates with the new image in a labelled one-off container", async () => {
    expect(await migrateBeforeApiUpdate({ deps: false })).toBe(0);

    const [stop, run] = composeCalls();
    expect(stop).toEqual(["stop", "app-api"]);
    expect(run.slice(0, 4)).toEqual(["run", "--rm", "-T", "--no-deps"]);
    expect(run[run.indexOf("--label") + 1]).toBe(MARKER);
    expect(run.slice(run.indexOf("app-api"))).toEqual([
      "app-api",
      "sh",
      "-c",
      "if [ -f dist/migrate.js ]; then exec node --import tsx/esm dist/migrate.js; fi; exit 78",
    ]);
    expect(vi.mocked(dockerCompose).mock.calls).toEqual([[["config", "--format", "json"]]]);
    expect(dockerCalls()).toEqual([["ps", "-aq", ...FILTERS]]);
    expect(composeCalls()).toHaveLength(2);
  });

  it("lets the one-off container start app-api's dependencies when the update does", async () => {
    await migrateBeforeApiUpdate({ deps: true });
    expect(composeCalls()[1]).not.toContain("--no-deps");
  });

  it("first stops a migration an earlier update left running", async () => {
    docker((args) => (args[0] === "ps" ? { stdout: "abc123\ndef456\n" } : {}));
    await migrateBeforeApiUpdate({ deps: false });
    expect(dockerCalls().slice(1)).toEqual([
      ["stop", "-t", "60", "abc123", "def456"],
      ["rm", "-f", "abc123", "def456"],
    ]);
    expect(composeCalls()[0]).toEqual(["stop", "app-api"]);
  });

  it("starts the previous app-api again and reports the failure when the migration fails", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => (args[0] === "run" ? 1 : 0));
    expect(await migrateBeforeApiUpdate({ deps: false })).toBe(1);
    expect(composeCalls().map((args) => args[0])).toEqual(["stop", "run", "start"]);
    expect(composeCalls()[2]).toEqual(["start", "app-api"]);
  });

  it("leaves migrating to app-api's startup when its image has no migration entry point", async () => {
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => (args[0] === "run" ? 78 : 0));
    expect(await migrateBeforeApiUpdate({ deps: false })).toBe(0);
    expect(composeCalls().map((args) => args[0])).toEqual(["stop", "run"]);
  });

  it("migrates nothing when the Compose project cannot be read", async () => {
    vi.mocked(dockerCompose).mockResolvedValueOnce({ stdout: "", stderr: "boom", exitCode: 1 });
    await expect(migrateBeforeApiUpdate({ deps: false })).rejects.toThrow(
      "Could not read the Compose project name",
    );
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("migrates nothing when app-api cannot be stopped", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(5);
    expect(await migrateBeforeApiUpdate({ deps: false })).toBe(5);
    expect(composeCalls()).toEqual([["stop", "app-api"]]);
  });

  it("listens for a stop request only while the migration container runs", async () => {
    const before = process.listenerCount("SIGTERM");
    let during = 0;
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      if (args[0] === "run") during = process.listenerCount("SIGTERM");
      return 0;
    });
    await migrateBeforeApiUpdate({ deps: false });
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("stopMigrationArgs", () => {
  it("stops the labelled migration and then starts app-api through Compose", async () => {
    const { execFileSync } =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    // Run the script with a stub `docker` that records each invocation.
    const { mkdtempSync, writeFileSync, chmodSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const bin = mkdtempSync(join(tmpdir(), "stop-migration-"));
    const record = join(bin, "calls");
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh\nprintf '%s|' "$@" >> "${record}"; echo >> "${record}"\n[ "$1" = ps ] && echo abc123\nexit 0\n`,
    );
    chmodSync(join(bin, "docker"), 0o755);

    const args = stopMigrationArgs(
      [PROJECT_LABEL, MARKER],
      ["compose", "-f", "/srv/open mapx/docker-compose.yml"],
    );
    execFileSync("sh", args, { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

    expect(readFileSync(record, "utf8").trim().split("\n")).toEqual([
      `ps|-q|--filter|label=${PROJECT_LABEL}|--filter|label=${MARKER}|`,
      "stop|-t|60|abc123|",
      "compose|-f|/srv/open mapx/docker-compose.yml|start|app-api|",
    ]);
  });
});
