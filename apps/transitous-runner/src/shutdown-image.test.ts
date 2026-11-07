/** Run with OPENMAPX_TEST_RUNNER_IMAGE naming a locally built runtime image.
 * Ordinary portable tests do not build or pull an image. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { mintTransitousCapability } from "@openmapx/core/transitous-runner";
import { expect, it, vi } from "vitest";

const image = process.env.OPENMAPX_TEST_RUNNER_IMAGE ?? "";
const KEY = "runner-image-fixture-key-0123456789";
const exec = promisify(execFile);
const docker = async (...args: string[]) =>
  (await exec("docker", args, { timeout: 40000, maxBuffer: 1024 * 1024 })).stdout.trim();

it.skipIf(!image).each(["parent-alive", "parent-exited"])(
  "runtime image reaps its owned group on SIGTERM: %s",
  async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-runner-image-"));
    const catalog = join(root, "catalog"),
      staging = join(root, "staging"),
      key = join(root, "key");
    const name = `openmapx-runner-shutdown-${randomUUID()}`;
    const controller = new AbortController();
    let reply: Promise<unknown> | undefined;
    mkdirSync(join(catalog, "src"), { recursive: true });
    mkdirSync(staging);
    // Synthetic output only; permit the production numeric UID on Docker Desktop.
    chmodSync(staging, 0o777);
    writeFileSync(key, KEY, { mode: 0o444 });
    writeFileSync(
      join(catalog, "src/garbage-collect.py"),
      [
        "import json, os, subprocess, sys, time",
        "from pathlib import Path",
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        "marker = Path(os.environ['HOME'], 'owned-ready.json')",
        "temporary = marker.with_suffix('.partial')",
        "temporary.write_text(json.dumps({'parent': os.getpid(), 'child': child.pid}))",
        "temporary.rename(marker)",
        ...(mode === "parent-exited" ? ["sys.exit(0)"] : []),
        "while True: time.sleep(1)",
      ].join("\n"),
    );
    try {
      await docker(
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "openmapx.test=runner-shutdown",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "-p",
        "127.0.0.1::4400",
        "--mount",
        `type=bind,src=${catalog},dst=/catalog,readonly`,
        "--mount",
        `type=bind,src=${staging},dst=/staging`,
        "--mount",
        `type=bind,src=${key},dst=/key,readonly`,
        "-e",
        "TRANSITOUS_RUNNER_CAPABILITY_KEY_FILE=/key",
        image,
      );
      expect(await docker("exec", name, "cat", "/proc/1/comm")).toBe("tini");
      const origin = `http://${await docker("port", name, "4400/tcp")}`;
      await vi.waitFor(async () => expect((await fetch(`${origin}/health`)).status).toBe(200), {
        timeout: 5000,
      });
      const run = { script: "garbage-collect" as const };
      reply = fetch(`${origin}/v1/run`, {
        method: "POST",
        headers: { "content-type": "application/json", connection: "keep-alive" },
        body: JSON.stringify({
          version: 1,
          capability: mintTransitousCapability(Buffer.from(KEY), { now: Date.now(), run }),
          run,
        }),
        signal: controller.signal,
      })
        .then(async (response) => ({
          status: response.status,
          connection: response.headers.get("connection"),
          body: await response.json(),
        }))
        .catch((error: unknown) => error);
      await vi.waitFor(() => expect(existsSync(join(staging, "owned-ready.json"))).toBe(true), {
        timeout: 5000,
      });
      if (mode === "parent-exited") {
        const pids = JSON.parse(readFileSync(join(staging, "owned-ready.json"), "utf8")) as {
          parent: number;
          child: number;
        };
        expect(Number.isSafeInteger(pids.parent) && pids.parent > 1).toBe(true);
        expect(Number.isSafeInteger(pids.child) && pids.child > 1).toBe(true);
        await vi.waitFor(
          async () => {
            expect(
              await docker(
                "exec",
                name,
                "python3",
                "-c",
                `from pathlib import Path; assert not Path('/proc/${pids.parent}').exists(); assert Path('/proc/${pids.child}/stat').read_text().split()[3] == '1'; print('orphan-ready')`,
              ),
            ).toBe("orphan-ready");
          },
          { timeout: 5000 },
        );
      }
      const started = performance.now();
      await docker("stop", "--timeout", "30", name);
      expect(performance.now() - started).toBeLessThan(10000);
      const state = JSON.parse(await docker("inspect", "--format", "{{json .State}}", name)) as {
        Status: string;
        ExitCode: number;
        OOMKilled: boolean;
      };
      expect(state).toMatchObject({ Status: "exited", ExitCode: 0, OOMKilled: false });
      expect(await reply).toMatchObject({
        status: 200,
        connection: "close",
        body: { ok: false, exitCode: 1 },
      });
    } finally {
      controller.abort();
      // Only the unique container created by this case; never prune shared state.
      await docker("rm", "-f", name).catch(() => undefined);
      await reply;
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
