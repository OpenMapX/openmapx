import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { collectArtifacts, writeOrCheckArtifacts } from "./artifacts.mjs";
import { formatSource } from "./format-source.mjs";

// Count real CLI invocations, forwarding every call to the installed command.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync), spawn: vi.fn(actual.spawn) };
});

const directories: string[] = [];
async function fixture() {
  const root = resolve(".superpowers/api-sdk");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "generation-artifacts-test-"));
  directories.push(directory);
  const source = join(directory, "generated");
  const destination = join(directory, "destination");
  await mkdir(join(source, "models"), { recursive: true });
  await mkdir(destination);
  return { source, destination };
}

afterEach(async () => {
  vi.mocked(execFileSync).mockClear();
  vi.mocked(spawn).mockClear();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("batch-formats every nested ignored scratch artifact with normative bytes in one CLI invocation", async () => {
  const { source, destination } = await fixture();
  const inputs = [
    ["models/z.ts", "import {z,a} from './types'; export const model={z,a, value:'dirty'};\n"],
    ["client.ts", "import {z} from './z';import {a} from './a';export const client={z,a};\n"],
    ["models/a.ts", `export const options={message:'${"long value ".repeat(12)}',ok:true};\n`],
    [
      "models/large.ts",
      `${"// Larger than Biome's default one MiB file limit.\n".repeat(23_000)}export const large={ok:true};\n`,
    ],
  ];
  const expected = inputs
    .map(([filename, content]) => ({
      filename,
      content: formatSource(resolve("packages/core/src/api/generated", filename), content),
    }))
    .sort((a, b) => a.filename.localeCompare(b.filename));
  expect(expected.find((file) => file.filename === "client.ts")?.content).toBe(
    'import { a } from "./a";\nimport { z } from "./z";\nexport const client = { z, a };\n',
  );
  for (const [filename, content] of inputs) await writeFile(join(source, filename), content);
  await writeFile(join(destination, "sentinel.ts"), "destination must remain unchanged\n");
  vi.mocked(execFileSync).mockClear();

  const artifacts = await collectArtifacts(source, destination, ["client.ts", "models/a.ts"]);
  expect(artifacts).toEqual(expected);
  expect(spawn).toHaveBeenCalledTimes(1);
  for (const file of expected)
    expect(await readFile(join(source, file.filename), "utf8")).toBe(file.content);
  vi.mocked(execFileSync).mockClear();
  vi.mocked(spawn).mockClear();
  expect(await collectArtifacts(source, destination, ["client.ts"])).toEqual(expected);
  expect(spawn).toHaveBeenCalledTimes(1);
  await expect(
    writeOrCheckArtifacts(artifacts, { outputDirectory: destination, check: true }),
  ).rejects.toThrow(/missing|extra/);
  expect(await readFile(join(destination, "sentinel.ts"), "utf8")).toBe(
    "destination must remain unchanged\n",
  );
  await expect(readFile(join(destination, "client.ts"))).rejects.toMatchObject({ code: "ENOENT" });
}, 30_000);

it("validates required artifacts before invoking the formatter", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(source, "client.ts"), "export const dirty={a:1};\n");
  await expect(collectArtifacts(source, destination, ["missing.ts"])).rejects.toThrow(
    "Orval did not generate missing.ts",
  );
  expect(execFileSync).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(await readFile(join(source, "client.ts"), "utf8")).toBe("export const dirty={a:1};\n");
});

it("rejects malformed generated syntax without changing the destination", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(source, "client.ts"), "export const broken = {;\n");
  await writeFile(join(destination, "client.ts"), "original destination\n");
  await expect(collectArtifacts(source, destination, ["client.ts"])).rejects.toThrow();
  expect(await readFile(join(destination, "client.ts"), "utf8")).toBe("original destination\n");
}, 30_000);

it.each(["models/unknown.txt", "__fixtures__/ignored.ts"])(
  "fails closed if Biome cannot process a collected file: %s",
  async (filename) => {
    const { source, destination } = await fixture();
    await writeFile(join(source, "client.ts"), "export const client={a:1};\n");
    await mkdir(join(source, "__fixtures__"));
    await writeFile(join(source, filename), "export const alsoDirty={a:1};\n");
    await expect(collectArtifacts(source, destination, ["client.ts"])).rejects.toThrow();
  },
  30_000,
);

it("refuses to format a directory outside generator-owned scratch", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(destination, "client.ts"), "export const untouched={a:1};\n");
  await expect(collectArtifacts(destination, source, ["client.ts"])).rejects.toThrow(
    /owned|scratch/,
  );
  expect(execFileSync).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(await readFile(join(destination, "client.ts"), "utf8")).toBe(
    "export const untouched={a:1};\n",
  );
});

it("refuses to follow a collected symbolic link out of owned scratch", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(destination, "client.ts"), "export const untouched={a:1};\n");
  await symlink(join(destination, "client.ts"), join(source, "client.ts"));
  await expect(collectArtifacts(source, destination, ["client.ts"])).rejects.toThrow(/symbolic/);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
  expect(await readFile(join(destination, "client.ts"), "utf8")).toBe(
    "export const untouched={a:1};\n",
  );
});

async function readProbeMarker(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function killProbe(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function probeIsLive(pid: number) {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 1_000,
    }).trim();
    return state !== "" && !state.startsWith("Z");
  } catch (error) {
    const result = error as { status: number; stdout: string };
    if (result.status === 1 && result.stdout.trim() === "") return false;
    throw error;
  }
}

async function cleanupProbe(marker: string) {
  // The formatter owns a separate group; use only this fixture's recorded ID.
  const group = await readProbeMarker(`${marker}.group`);
  if (group) killProbe(-Number(group));
  const native = await readProbeMarker(marker);
  if (!native) return;
  const pids = JSON.parse(native) as { native: number; wrapper: number };
  killProbe(pids.native);
  const deadline = Date.now() + 2_000;
  while ((probeIsLive(pids.native) || probeIsLive(pids.wrapper)) && Date.now() < deadline)
    await delay(5);
  expect(probeIsLive(pids.native), "outer fixture cleanup left a live native writer").toBe(false);
  expect(probeIsLive(pids.wrapper), "outer fixture cleanup left a live wrapper").toBe(false);
}

it.each(["timeout", "stdout", "stderr", "wrapper-exit"])(
  "terminates the actual wrapper and native writer before caller cleanup on %s",
  async (mode) => {
    const { source, destination } = await fixture();
    await writeFile(join(source, "client.ts"), "export const client={a:1};\n");
    const marker = join(destination, "native-pid.json");
    const child = spawn(
      process.execPath,
      [resolve("scripts/codegen/fixtures/batch-lifetime.mjs"), source, destination, mode, marker],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const finished = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const watchdog = setTimeout(() => {
      if (child.pid) killProbe(-child.pid);
    }, 10_000);
    try {
      expect(await finished, output).toBe(0);
      console.log(output.trim());
      expect(output).toContain('"nativeAliveBeforeCleanup":false');
      expect(output).toContain("caller scratch cleanup completed after descendant termination");
      expect(output).toContain("fixture process cleanup complete");
    } finally {
      clearTimeout(watchdog);
      if (child.pid) killProbe(-child.pid);
      await cleanupProbe(marker);
      await finished;
    }
  },
  15_000,
);
