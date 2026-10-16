import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const script = new URL("../scripts/run.sh", import.meta.url).pathname;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function start(cached: boolean, region = "planet") {
  const root = await mkdtemp(join(tmpdir(), "brouter-runtime-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "generation-orphan"));
  await writeFile(join(root, "generation-orphan/region"), "planet\n");
  const bin = join(root, "bin");
  await mkdir(bin);
  await mkdir(join(root, "distribution-1.7.10/profiles2"), { recursive: true });
  await writeFile(join(root, "distribution-1.7.10/.verified"), "");
  if (cached) {
    const active = join(root, "generation-original");
    await mkdir(active);
    await writeFile(join(active, "region"), "planet\n");
    await writeFile(join(active, "engine-version"), "1.7.10\n");
    await writeFile(join(active, "updated-at"), `${Math.floor(Date.now() / 1000)}\n`);
    await symlink("generation-original", join(root, "current"));
  }
  await writeFile(
    join(bin, "java"),
    '#!/bin/bash\nprintf "%s\\n" "$$" > "$BROUTER_DATA_DIR/java-pid"\nexec sleep 120\n',
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "curl"),
    '#!/bin/bash\nprintf "%s\\n" "$$" > "$BROUTER_DATA_DIR/download-pid"\nexec sleep 120\n',
    { mode: 0o755 },
  );
  const child = spawn("bash", [script], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BROUTER_DATA_DIR: root,
      REGION: region,
    },
    stdio: "pipe",
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const closed = new Promise<number | null>((resolve) =>
    child.on("close", (code) => resolve(code)),
  );
  cleanup.push(async () => {
    child.kill("SIGTERM");
    await closed;
  });
  return { root, child, closed, errors: () => stderr };
}
async function pidFile(path: string) {
  let pid = 0;
  await vi.waitFor(
    async () => {
      pid = Number(await readFile(path, "utf8"));
      expect(pid).toBeGreaterThan(0);
    },
    { timeout: 3000, interval: 20 },
  );
  return pid;
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("BRouter supervisor", () => {
  it("starts from matching cached coverage and terminates the actual engine on shutdown", async () => {
    const run = await start(true);
    const pid = await pidFile(join(run.root, "java-pid"));
    expect(alive(pid)).toBe(true);
    await expect(readFile(join(run.root, "generation-orphan/region"))).rejects.toThrow();
    run.child.kill("SIGTERM");
    expect(await run.closed).toBe(0);
    expect(alive(pid)).toBe(false);
    expect(run.errors()).toBe("");
  });
  it("prepares changed coverage before starting an engine instead of serving a cached different region", async () => {
    const run = await start(true, "europe/germany");
    await pidFile(join(run.root, "download-pid"));
    await expect(readFile(join(run.root, "java-pid"))).rejects.toThrow();
    run.child.kill("SIGTERM");
    expect(await run.closed).toBe(0);
    expect(await readFile(join(run.root, "current/region"), "utf8")).toBe("planet\n");
  });
  it("cancels an active download and removes its staging directory on shutdown", async () => {
    const run = await start(false);
    const pid = await pidFile(join(run.root, "download-pid"));
    run.child.kill("SIGTERM");
    expect(await run.closed).toBe(0);
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000 });
  });
});
