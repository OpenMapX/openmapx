import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const stub = `#!/usr/bin/env python3
import os, pathlib, signal, sys, time
root = pathlib.Path(os.environ["FIXTURE_ROOT"])
name = pathlib.Path(sys.argv[0]).name
def mark(name, value=""):
    (root / name).write_text(value)
def wait_for(name):
    while not (root / name).exists():
        time.sleep(0.005)
if name == "rm":
    (root / "synced").unlink(missing_ok=True)
elif name == "touch":
    mark("synced")
elif name == "docker-entrypoint.sh":
    stopping = False
    def stop(sig, frame):
        global stopping
        with (root / "signals").open("a") as output:
            output.write(str(sig) + "\\n")
        if not stopping:
            stopping = True
            mark("shutdown-started")
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    mark("child-ready")
    while not stopping and not (root / "exit-now").exists():
        time.sleep(0.005)
    if stopping:
        wait_for("finish-shutdown")
    mark("child-exited")
    sys.exit(int(os.environ["FIXTURE_EXIT"]))
elif name == "pg_isready":
    wait_for("child-ready")
    mark("readiness-started")
    sys.exit(0 if (root / "ready").exists() else 1)
elif name == "sleep":
    if (root / "retry-phase").exists():
        mark((root / "retry-phase").read_text() + "-retry-sleep")
        wait_for("finish-retry")
    else:
        mark("readiness-sleep")
    time.sleep(0.05)
elif name == "psql":
    sql = sys.argv[sys.argv.index("-c") + 1] if "-c" in sys.argv else sys.stdin.read()
    phase = "tile-sync" if "CREATE ROLE" in sql else "sync"
    mark(phase + "-sql", sql)
    if "-c" not in sys.argv:
        assert sql and "--single-transaction" in sys.argv
        assert os.environ.get("PGOPTIONS") == "-c log_statement=none"
    counter = root / (phase + "-attempts")
    attempts = int(counter.read_text()) + 1 if counter.exists() else 1
    mark(phase + "-attempts", str(attempts))
    mark(phase + "-started")
    if os.environ["FIXTURE_RETRY_PHASE"] == phase and attempts <= 2:
        mark("retry-phase", phase)
        sys.exit(1)
    wait_for("finish-" + phase)
    mark(phase + "-finished")
`;

function killProcessGroup(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function fixture(
  exitCode: number,
  phase:
    | "ready"
    | "readiness"
    | "sync"
    | "tile-sync"
    | "password-retry"
    | "tile-retry"
    | "retry-success",
  run: (fixture: {
    mark: (name: string) => void;
    wait: (name: string) => Promise<void>;
    signal: (signal: "SIGTERM" | "SIGINT") => void;
    finished: Promise<{ code: number | null; childExited: boolean; synced: boolean }>;
    has: (name: string) => boolean;
    signals: () => string[];
    read: (name: string) => string;
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-postgis-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["rm", "touch", "pg_isready", "docker-entrypoint.sh", "psql", "sleep"]) {
    writeFileSync(join(bin, name), stub, { mode: 0o755 });
  }
  const mark = (name: string) => writeFileSync(join(root, name), "");
  const has = (name: string) => existsSync(join(root, name));
  if (phase !== "readiness") mark("ready");
  if (phase !== "sync") mark("finish-sync");
  if (phase !== "tile-sync") mark("finish-tile-sync");
  if (phase !== "password-retry" && phase !== "tile-retry") mark("finish-retry");
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("POSTGRES_") && !key.startsWith("MARTIN_"),
    ),
  );
  const child = spawn("bash", [resolve("services/postgis/scripts/sync-password.sh"), "fixture"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...env,
      PATH: `${bin}:${process.env.PATH}`,
      FIXTURE_ROOT: root,
      FIXTURE_EXIT: String(exitCode),
      FIXTURE_RETRY_PHASE:
        phase === "password-retry" || phase === "retry-success"
          ? "sync"
          : phase === "tile-retry"
            ? "tile-sync"
            : "",
      POSTGRES_PASSWORD: "synthetic-test'password",
      MARTIN_DB_PASSWORD: "synthetic-tile'password",
    },
  });
  const finished = new Promise<{ code: number | null; childExited: boolean; synced: boolean }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        resolve({ code, childExited: has("child-exited"), synced: has("synced") }),
      );
    },
  );
  const watchdog = setTimeout(() => {
    killProcessGroup(child.pid);
  }, 5_000);
  try {
    const wait = async (name: string) => {
      const deadline = Date.now() + 4_000;
      while (!has(name) && Date.now() < deadline) await delay(5);
      expect(has(name), `missing fixture marker ${name}`).toBe(true);
    };
    await wait("child-ready");
    await run({
      mark,
      wait,
      signal: (signal) => child.kill(signal),
      finished,
      has,
      read: (name) => readFileSync(join(root, name), "utf8"),
      signals: () =>
        has("signals") ? readFileSync(join(root, "signals"), "utf8").trim().split("\n") : [],
    });
  } finally {
    clearTimeout(watchdog);
    killProcessGroup(child.pid);
    await finished;
    rmSync(root, { recursive: true, force: true });
  }
}

describe("PostGIS entrypoint child ownership", () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    it.each([0, 23])(
      `waits for delayed shutdown after ${signal}, preserving exit %i`,
      async (code) => {
        await fixture(code, "ready", async (f) => {
          await f.wait("synced");
          // Let the sentinel command return so the signal interrupts the child wait.
          await delay(50);
          f.signal(signal);
          await f.wait("shutdown-started");
          expect(await Promise.race([f.finished, delay(100).then(() => "waiting")])).toBe(
            "waiting",
          );
          f.mark("finish-shutdown");
          expect(await f.finished).toEqual({ code, childExited: true, synced: true });
        });
      },
    );

    for (const phase of [
      "readiness",
      "sync",
      "tile-sync",
      "password-retry",
      "tile-retry",
    ] as const) {
      it.each([0, 23])(
        `waits for ${signal} during ${phase} without declaring sync success (exit %i)`,
        async (code) => {
          await fixture(code, phase, async (f) => {
            await f.wait(
              phase === "readiness"
                ? "readiness-sleep"
                : phase === "password-retry"
                  ? "sync-retry-sleep"
                  : phase === "tile-retry"
                    ? "tile-sync-retry-sleep"
                    : `${phase}-started`,
            );
            f.signal(signal);
            await f.wait("shutdown-started");
            expect(await Promise.race([f.finished, delay(100).then(() => "waiting")])).toBe(
              "waiting",
            );
            expect(f.has(phase === "sync" ? "sync-finished" : "tile-sync-finished")).toBe(false);
            f.mark("finish-shutdown");
            expect(await f.finished).toEqual({ code, childExited: true, synced: false });
          });
        },
      );
    }
  }

  it("keeps waiting after repeated signals without forwarding another graceful request", async () => {
    await fixture(23, "ready", async (f) => {
      await f.wait("synced");
      f.signal("SIGTERM");
      await f.wait("shutdown-started");
      f.signal("SIGINT");
      await delay(50);
      f.mark("finish-shutdown");
      expect(await f.finished).toEqual({ code: 23, childExited: true, synced: true });
      expect(f.signals()).toEqual(["15"]);
    });
  });

  it.each([0, 23, 130, 143])(
    "preserves an ordinary child exit %i without a wrapper signal",
    async (code) => {
      await fixture(code, "ready", async (f) => {
        await f.wait("synced");
        f.mark("exit-now");
        expect(await f.finished).toEqual({ code, childExited: true, synced: true });
      });
    },
  );

  it("fails readiness when the child crashes without declaring sync success", async () => {
    await fixture(23, "readiness", async (f) => {
      await f.wait("readiness-sleep");
      f.mark("exit-now");
      expect(await f.finished).toEqual({ code: 1, childExited: true, synced: false });
    });
  });

  it("retries transient startup SQL failures and initializes the tile role before declaring success", async () => {
    await fixture(0, "retry-success", async (f) => {
      await f.wait("synced");
      expect(f.read("sync-attempts")).toBe("3");
      expect(f.has("tile-sync-finished")).toBe(true);
      expect(f.read("sync-sql")).toContain("PASSWORD 'synthetic-test''password'");
      expect(f.read("tile-sync-sql")).toContain(
        "NOINHERIT LOGIN PASSWORD 'synthetic-tile''password'",
      );
      expect(f.read("tile-sync-sql")).toContain(
        "GRANT EXECUTE ON FUNCTION tiles.segment_flow(integer, integer, integer, json) TO openmapx_tiles;",
      );
      f.mark("exit-now");
      expect(await f.finished).toEqual({ code: 0, childExited: true, synced: true });
    });
  });
});
