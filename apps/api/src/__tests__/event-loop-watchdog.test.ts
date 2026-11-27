import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eventLoopWatchdogThresholdMs, startEventLoopWatchdog } from "../event-loop-watchdog.js";
import { beginBoot } from "../safe-mode.js";
import { apiModule, runChild, startChild } from "./support/child-process.js";

const WATCHDOG = apiModule("event-loop-watchdog.ts");
const SAFE_MODE = apiModule("safe-mode.ts");
const CHILD_TIMEOUT_MS = 40_000;
const TEST_TIMEOUT_MS = 60_000;

let runtimeDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "omx-watchdog-"));
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function readMarker(directory: string) {
  return JSON.parse(readFileSync(join(directory, "boot-marker.json"), "utf8"));
}

/** A child that boots, runs `before`, starts the watchdog at 5 s and then runs `after`. */
function child(before: string, after: string) {
  return `
    import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};
    import { beginBoot, markIntegrationLoading } from ${JSON.stringify(SAFE_MODE)};
    const runtimeDir = ${JSON.stringify(runtimeDir)};
    const log = { error: (message) => console.error(message), warn: (message) => console.error(message) };
    const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    beginBoot(runtimeDir, new Date());
    ${before}
    const watchdog = startEventLoopWatchdog({ thresholdMs: 5_000, runtimeDir, log });
    ${after}
  `;
}

describe("the event-loop watchdog", () => {
  it(
    "kills a process whose event loop is blocked beyond the threshold",
    async () => {
      const result = await runChild(child("", "setTimeout(() => block(25_000), 100);"), {
        timeoutMs: CHILD_TIMEOUT_MS,
      });
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toMatch(/event loop blocked for \d+ ms; exiting/);
      expect(readMarker(runtimeDir).running).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "names the integration that was loading when the loop blocked",
    async () => {
      const result = await runChild(
        child('markIntegrationLoading("acme", "setup");', "setTimeout(() => block(25_000), 100);"),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.signal).toBe("SIGKILL");
      expect(readMarker(runtimeDir).lastFatal).toEqual({
        integrationId: "acme",
        at: expect.any(String),
      });
      beginBoot(runtimeDir, new Date());
      expect(readMarker(runtimeDir).uncleanExits).toEqual([
        expect.objectContaining({ integrationId: "acme" }),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it("does not start as PID 1", () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    expect(startEventLoopWatchdog({ thresholdMs: 5_000, runtimeDir, log, pid: 1 })).toBeNull();
    expect(log.error).toHaveBeenCalledWith(
      "event-loop watchdog not started: the process is PID 1 and cannot kill itself",
    );
  });

  it(
    "leaves a responsive process alone, also through a short blocking stretch",
    async () => {
      // Two seconds stand for the synchronous scan of a large extension bundle.
      const result = await runChild(
        child(
          "",
          "setTimeout(() => block(2_000), 1_000); setTimeout(() => console.log('done'), 8_000);",
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain("done");
      expect(result.stderr).not.toMatch(/event loop blocked/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not keep the process alive",
    async () => {
      const result = await runChild(child("", "console.log(Date.now());"), {
        timeoutMs: CHILD_TIMEOUT_MS,
      });
      const exitedAt = Date.now();
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(exitedAt - Number(result.stdout.trim())).toBeLessThan(2_000);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not kill once it was stopped",
    async () => {
      const result = await runChild(
        child("", "watchdog.stop(); setTimeout(() => block(8_000), 100);"),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result).toMatchObject({ code: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not take a suspended process for a blocked one",
    async () => {
      // SIGSTOP halts every thread, as a host's suspend does, while the clock
      // goes on. The main thread is busy for 3 s of CPU time across the stop,
      // so it is still blocked when the watchdog's thread wakes up.
      const running = startChild(
        child(
          "",
          `console.log("ready");
          setTimeout(() => {
            const cpu = () => { const { user, system } = process.cpuUsage(); return user + system; };
            const start = cpu();
            while (cpu() - start < 3_000_000) {}
          }, 1_000);
          setTimeout(() => console.log("done"), 2_000);`,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      await running.printed("ready");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      running.child.kill("SIGSTOP");
      await new Promise((resolve) => setTimeout(resolve, 8_000));
      running.child.kill("SIGCONT");
      const result = await running.exited;
      expect(result.stderr).not.toMatch(/event loop blocked/);
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain("done");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not start under a debugger",
    async () => {
      const result = await runChild(child("", "console.log(JSON.stringify(watchdog === null));"), {
        timeoutMs: CHILD_TIMEOUT_MS,
        nodeArgs: ["--inspect=127.0.0.1:0"],
      });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe("true");
      expect(result.stderr).toContain("event-loop watchdog not started: a debugger may pause");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stands aside once a debugger is attached later",
    async () => {
      const result = await runChild(
        child(
          'import inspector from "node:inspector";',
          "inspector.open(0, '127.0.0.1'); setTimeout(() => { block(8_000); inspector.close(); }, 1_500);",
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result).toMatchObject({ code: 0, signal: null });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("the API image and service", () => {
  const repository = join(import.meta.dirname, "..", "..", "..", "..");

  it("start Node under tini and pass the threshold through", () => {
    const dockerfile = readFileSync(join(repository, "apps", "api", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^RUN apk add --no-cache [^\n]*\btini\b/m);
    expect(dockerfile).toMatch(
      /^ENTRYPOINT \["\/sbin\/tini", "--"\]\n(?:#[^\n]*\n)*CMD \["node", /m,
    );
    const manifest = JSON.parse(
      readFileSync(join(repository, "services", "api", "service.json"), "utf8"),
    ) as { container: { environment: Record<string, string> } };
    expect(manifest.container.environment.OPENMAPX_EVENT_LOOP_WATCHDOG_MS).toBe(
      "${OPENMAPX_EVENT_LOOP_WATCHDOG_MS:-}",
    );
  });
});

describe("eventLoopWatchdogThresholdMs", () => {
  it.each([
    [{}, 30_000],
    [{ OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "" }, 30_000],
    [{ OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "45000" }, 45_000],
    [{ OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "1000" }, 5_000],
    [{ OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "0" }, null],
    [{ OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "soon" }, 30_000],
    [{ OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "-5" }, 30_000],
    [{ VITEST: "true" }, null],
    [{ VITEST: "true", OPENMAPX_EVENT_LOOP_WATCHDOG_MS: "6000" }, 6_000],
  ])("reads %j as %j", (env, expected) => {
    expect(eventLoopWatchdogThresholdMs(env)).toBe(expected);
  });

  it("is off at 0", () => {
    const log = { error: vi.fn(), warn: vi.fn() };
    expect(startEventLoopWatchdog({ thresholdMs: 0, runtimeDir, log })).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });
});
