import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
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
async function fixture(generator = "api-sdk") {
  const root = resolve(`.superpowers/${generator}`);
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

it("preserves a streamless spawn failure and clears its deadline before rejecting", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(source, "client.ts"), "export const client={a:1};\n");
  const failure = Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" });
  // Node returns before assigning stdio streams when pipe creation hits EMFILE.
  vi.mocked(spawn).mockImplementationOnce(() => {
    const child = new EventEmitter() as ChildProcess;
    process.nextTick(() => {
      child.emit("error", failure);
      child.emit("close", -1, null);
    });
    return child;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const result = await collectArtifacts(source, destination, ["client.ts"]).catch(
      (error: unknown) => error,
    );
    expect.soft(result).toBe(failure);
    expect.soft(vi.getTimerCount()).toBe(0);
    expect(await readFile(join(source, "client.ts"), "utf8")).toBe("export const client={a:1};\n");
    await expect(readFile(join(destination, "client.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    vi.useRealTimers();
  }
});

function killProbe(pid: number) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      const states = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
        encoding: "utf8",
        timeout: 1_000,
      })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/));
      if (
        states.every((row) => row.length === 3) &&
        !states.some(
          ([id, group, state]) =>
            (pid < 0 ? Number(group) === -pid : Number(id) === pid) && !state.startsWith("Z"),
        )
      )
        return;
    }
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

it("preserves overflow after actual group EPERM with a retained writer zombie", async () => {
  const { source, destination } = await fixture();
  await writeFile(join(source, "client.ts"), "export const client={a:1};\n");
  const marker = join(destination, "zombie-owner.json");
  const child = spawn(
    process.execPath,
    [resolve("scripts/codegen/fixtures/retained-zombie.mjs"), source, destination, marker],
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
    const events = (await readFile(`${marker}.events`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.find((event) => event.event === "formatter-returned").error.code).toBe(
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
    );
    expect(
      events.findIndex((event) => event.event === "stable-before-scratch-cleanup"),
    ).toBeLessThan(events.findIndex((event) => event.event === "scratch-removed"));
    if (process.platform === "darwin") {
      for (const signal of ["SIGKILL", 0])
        expect(
          events.some(
            (event) =>
              event.event === "kill" && event.signal === signal && event.error?.code === "EPERM",
          ),
        ).toBe(true);
    }
    console.log(JSON.stringify(events));
  } finally {
    clearTimeout(watchdog);
    await writeFile(`${marker}.release`, "release");
    const group = await readProbeMarker(`${marker}.group`);
    const markerText = await readProbeMarker(marker);
    const pids = markerText
      ? (JSON.parse(markerText) as { supervisor: number; writer: number; wrapper: number })
      : undefined;
    if (group && (!pids || probeIsLive(pids.wrapper) || probeIsLive(pids.writer)))
      killProbe(-Number(group));
    const until = Date.now() + 2_000;
    while (
      pids &&
      [pids.supervisor, pids.writer, pids.wrapper].some(probeIsLive) &&
      Date.now() < until
    )
      await delay(5);
    if (pids) {
      for (const pid of [pids.supervisor, pids.writer, pids.wrapper])
        expect(probeIsLive(pid)).toBe(false);
      expect(JSON.parse(await readFile(`${marker}.reaped`, "utf8")).reaped).toBe(pids.writer);
    }
    if (child.pid && probeIsLive(child.pid)) killProbe(-child.pid);
    await finished;
  }
}, 15_000);

it.each(
  ["SIGKILL", 0].flatMap((signal) =>
    ["live", "failed", "empty", "malformed"].map((inspection) => ({ signal, inspection })),
  ),
)(
  "fails closed on group $signal EPERM when process inspection is $inspection",
  async ({ signal, inspection }) => {
    const { source, destination } = await fixture();
    await writeFile(join(source, "client.ts"), "export const client={a:1};\n");
    const denied = Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    const group = 123456789; // Synthetic child: no real signals are sent in this classification test.
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, requestedSignal) => {
      if (requestedSignal === signal) throw denied;
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      const child = new EventEmitter() as ChildProcess;
      Object.assign(child, { pid: group });
      process.nextTick(() => {
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
      });
      return child;
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      if (inspection === "failed") throw new Error("inspection failed");
      return inspection === "live"
        ? `${group} S\n`
        : inspection === "empty"
          ? ""
          : "unobservable\n";
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const result = await collectArtifacts(source, destination, ["client.ts"]).catch(
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(Error);
      const cleanupError =
        signal === "SIGKILL" ? (result as AggregateError).errors?.at(-1) : result;
      expect(cleanupError).toBeInstanceOf(Error);
      expect((cleanupError as Error).message).toMatch(/EPERM|inspect/i);
      expect(vi.getTimerCount()).toBe(0);
      expect(await readFile(join(source, "client.ts"), "utf8")).toBe(
        "export const client={a:1};\n",
      );
    } finally {
      kill.mockRestore();
      vi.mocked(execFileSync).mockImplementation(
        (await vi.importActual<typeof import("node:child_process")>("node:child_process"))
          .execFileSync,
      );
      vi.useRealTimers();
    }
  },
);

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

it("formats the explicitly owned MBTA generator scratch", async () => {
  const { source, destination } = await fixture("mbta");
  await writeFile(join(source, "client.ts"), "export const value={ok:true};\n");
  const files = await collectArtifacts(source, destination, ["client.ts"]);
  expect(files).toEqual([
    { filename: "client.ts", content: "export const value = { ok: true };\n" },
  ]);
});
