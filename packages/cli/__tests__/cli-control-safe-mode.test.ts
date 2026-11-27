import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import type { ExecutionRef } from "@openmapx/core/ops";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerControlCommands } from "../src/commands/control";
import { dockerCompose } from "../src/lib/docker";

vi.mock("../src/lib/docker", async (original) => ({
  ...(await original<typeof import("../src/lib/docker")>()),
  dockerCompose: vi.fn(),
  dockerDaemonReachable: vi.fn(async () => true),
}));

let root: string;
let infraDir: string;
let runtimeDir: string;
let printed: string[];
let apiRunning: boolean;
let restartExit: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openmapx-safe-mode-"));
  infraDir = join(root, "infra/docker");
  runtimeDir = join(infraDir, "data/api-runtime");
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(
    join(infraDir, ".env"),
    `UID=${process.geteuid?.() ?? 1000}\nGID=${process.getegid?.() ?? 1000}\n`,
    { mode: 0o600 },
  );
  vi.stubEnv("OPENMAPX_ROOT_DIR", root);
  vi.stubEnv("OPENMAPX_SAFE_MODE", "");
  printed = [];
  const record = (line: unknown) => {
    printed.push(String(line));
  };
  vi.spyOn(console, "log").mockImplementation(record);
  vi.spyOn(console, "error").mockImplementation(record);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw Error(`exit:${code}`);
  });
  apiRunning = true;
  restartExit = 0;
  vi.mocked(dockerCompose)
    .mockReset()
    .mockImplementation(async (args: string[]) => {
      if (args[0] === "ps") return { exitCode: 0, stdout: apiRunning ? "api\n" : "", stderr: "" };
      return { exitCode: args[0] === "restart" ? restartExit : 0, stdout: "", stderr: "" };
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function run(expectedExit: number, ...args: string[]) {
  const program = new Command().exitOverride();
  registerControlCommands(program);
  await expect(
    program.parseAsync(["node", "openmapx", "control", "safe-mode", ...args]),
  ).rejects.toThrow(`exit:${expectedExit}`);
}

const store = () =>
  control.openLeaseStore({ directory: control.leaseStoreDirectory(infraDir), purpose: "test" });

const auditLog = () =>
  readFileSync(join(control.leaseStoreDirectory(infraDir), "control-audit.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const dockerCalls = () => vi.mocked(dockerCompose).mock.calls.map(([args]) => args);

describe("openmapx control safe-mode", () => {
  it("writes the operator file and restarts the api container under a lease", async () => {
    let fileAtRestart: string | null = null;
    let leasesAtRestart: string[][] = [];
    vi.mocked(dockerCompose).mockImplementation(async (args: string[]) => {
      if (args[0] === "restart") {
        fileAtRestart = readFileSync(join(runtimeDir, "safe-mode.json"), "utf8");
        leasesAtRestart = store()
          .list()
          .map((lease) => lease.targets);
      }
      return { exitCode: 0, stdout: args[0] === "ps" ? "api\n" : "", stderr: "" };
    });

    await run(0, "on");

    expect(JSON.parse(readFileSync(join(runtimeDir, "safe-mode.json"), "utf8"))).toEqual({
      mode: "operator",
    });
    expect(fileAtRestart).not.toBeNull();
    expect(leasesAtRestart).toEqual([["api"]]);
    expect(dockerCalls()).toContainEqual(["restart", "api"]);
    expect(store().list()).toEqual([]);
    expect(auditLog()).toEqual([
      expect.objectContaining({ action: "safe-mode", state: "on", restarted: true, exitCode: 0 }),
    ]);
    expect(printed.join("\n")).toContain("Safe mode is on");
    expect(readdirSync(runtimeDir)).toEqual(["safe-mode.json"]);
  });

  it("writes the file and exits non-zero when the api target is busy", async () => {
    const holder = owner();
    await control
      .localLeaseBackend(store())
      .acquire({ owner: holder, ownerKind: "service.stop", targets: ["api"] });

    await run(1, "on");

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(dockerCalls()).not.toContainEqual(["restart", "api"]);
    expect(printed.join("\n")).toContain(holder.operationKey);
    expect(auditLog()).toEqual([
      expect.objectContaining({ action: "safe-mode", state: "on", exitCode: 1 }),
    ]);
  });

  it("only writes the file when the api container is not running", async () => {
    apiRunning = false;

    await run(0, "on");

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(dockerCalls()).not.toContainEqual(["restart", "api"]);
    expect(printed.join("\n")).toContain("starts in safe mode");
  });

  it("removes the safe-mode file and the boot marker on off", async () => {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"automatic","integrationId":"a"}');
    writeFileSync(join(runtimeDir, "boot-marker.json"), '{"uncleanExits":3}');

    await run(0, "off");

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(false);
    expect(existsSync(join(runtimeDir, "boot-marker.json"))).toBe(false);
    expect(dockerCalls()).toContainEqual(["restart", "api"]);
    expect(auditLog()).toEqual([
      expect.objectContaining({ action: "safe-mode", state: "off", restarted: true, exitCode: 0 }),
    ]);
    expect(printed.join("\n")).toContain("Safe mode is off");
  });

  it("refuses off while the environment forces safe mode", async () => {
    vi.stubEnv("OPENMAPX_SAFE_MODE", "1");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "safe-mode.json"), '{"mode":"operator"}');

    await run(1, "off");

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(dockerCalls()).toEqual([]);
    expect(printed.join("\n")).toContain("OPENMAPX_SAFE_MODE=1");
  });

  it("exits non-zero when the restart fails, with the file already changed", async () => {
    restartExit = 1;

    await run(1, "on");

    expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(true);
    expect(auditLog()).toEqual([
      expect.objectContaining({ action: "safe-mode", state: "on", exitCode: 1 }),
    ]);
  });

  it("accepts only on and off", async () => {
    const program = new Command().exitOverride();
    registerControlCommands(program);
    await expect(
      program.parseAsync(["node", "openmapx", "control", "safe-mode", "maybe"]),
    ).rejects.toThrow("Pass on or off");
    expect(existsSync(runtimeDir)).toBe(false);
  });
});

function owner(): ExecutionRef {
  return {
    executor: "host-cli",
    principal: "host-cli",
    executionId: randomUUID(),
    operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    operationFingerprint: "a".repeat(64),
    fingerprint: "b".repeat(64),
    deadlineAt: Date.now() + 60_000,
  };
}
