import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerExtCommands } from "../src/commands/ext";
import { dockerCompose } from "../src/lib/docker";

vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerCompose: vi.fn(),
}));

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

let root: string;
let output: string[];
let savedExitCode: typeof process.exitCode;
let postgisRunning: boolean;
let returnedRows: string;

beforeEach(() => {
  savedExitCode = process.exitCode;
  process.exitCode = 0;
  root = mkdtempSync(join(tmpdir(), "openmapx-ext-disable-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "infra", "docker"), { recursive: true });
  mkdirSync(join(root, "services", "postgis"), { recursive: true });
  copyFileSync(
    join(REPO_ROOT, "services", "postgis", "service.json"),
    join(root, "services", "postgis", "service.json"),
  );
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  output = [];
  const record = (line: unknown) => {
    output.push(String(line));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("Unexpected immediate process.exit");
  });
  postgisRunning = true;
  returnedRows = "acme-places\n";
  vi.mocked(dockerCompose)
    .mockReset()
    .mockImplementation(async (args: string[]) => ({
      exitCode: 0,
      stdout: args[0] === "ps" && postgisRunning ? "postgis\n" : "",
      stderr: "",
    }));
  vi.mocked(execa)
    .mockReset()
    .mockImplementation((async () => ({
      exitCode: 0,
      stdout: returnedRows,
      stderr: "",
    })) as unknown as typeof execa);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = savedExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function run(group: string, ...args: string[]) {
  const program = new Command().exitOverride();
  registerExtCommands(program);
  await program.parseAsync([group, ...args], { from: "user" });
}

function psqlCall(): { args: string[]; input: string } {
  const call = vi.mocked(execa).mock.calls.find(([command]) => command === "docker");
  if (!call) throw new Error("psql was not run");
  const [, args, options] = call as unknown as [string, string[], { input: string }];
  return { args, input: options.input };
}

describe("openmapx extensions disable", () => {
  it("disables an extension through the database container without the API", async () => {
    await run("extensions", "disable", "acme-places", "--offline");

    expect(process.exitCode).toBe(0);
    const { args, input } = psqlCall();
    const exec = args.indexOf("exec");
    expect(args.slice(exec)).toEqual([
      "exec",
      "-T",
      "-e",
      expect.stringMatching(/^PGTZ=/),
      "postgis",
      "psql",
      "-U",
      "postgres",
      "-d",
      "openmapx",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-q",
    ]);
    expect(input).toContain("COPY _openmapx_target (id) FROM STDIN;\nacme-places\n\\.\n");
    expect(input).toContain(
      "UPDATE installed_extension e SET enabled = false, updated_at = now() FROM _openmapx_target t WHERE e.id = t.id RETURNING e.id",
    );
    const sql = input.replace("\nacme-places\n", "\n");
    expect(sql).not.toContain("acme-places");
    expect(output.join("\n")).toContain(
      "Disabled acme-places; restart the api service to unload it",
    );
  });

  it("says so when the extension is not installed", async () => {
    returnedRows = "";

    await run("extensions", "disable", "acme-places", "--offline");

    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).toContain("No installed extension acme-places");
  });

  it("points to safe mode when the database is down", async () => {
    postgisRunning = false;

    await run("extensions", "disable", "acme-places", "--offline");

    expect(process.exitCode).toBe(1);
    expect(execa).not.toHaveBeenCalled();
    expect(output.join("\n")).toContain(
      "The database is not running; use: openmapx control safe-mode on",
    );
  });

  it.each([["Acme"], ["acme;drop"], ["-acme"], ["a".repeat(49)], ["acme\nplaces"]])(
    "refuses the id %j before touching the database",
    async (id) => {
      await run("extensions", "disable", "--offline", "--", id);

      expect(process.exitCode).toBe(1);
      expect(execa).not.toHaveBeenCalled();
      expect(dockerCompose).not.toHaveBeenCalled();
    },
  );

  it("fails when psql fails, without claiming the extension is disabled", async () => {
    vi.mocked(execa).mockImplementation((async () => ({
      exitCode: 2,
      stdout: "",
      stderr: "connection refused",
    })) as unknown as typeof execa);

    await run("extensions", "disable", "acme-places", "--offline");

    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).not.toContain("Disabled acme-places");
  });

  it("asks for --offline when it is not given", async () => {
    await run("extensions", "disable", "acme-places");

    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).toContain("Pass --offline to disable an extension without the API");
    expect(execa).not.toHaveBeenCalled();
  });

  it("keeps ext as an alias of extensions", async () => {
    await run("ext", "disable", "acme-places", "--offline");

    expect(process.exitCode).toBe(0);
    expect(psqlCall().input).toContain("acme-places");
    const program = new Command();
    registerExtCommands(program);
    const group = program.commands.find((command) => command.name() === "extensions");
    expect(group?.aliases()).toEqual(["ext"]);
  });
});
