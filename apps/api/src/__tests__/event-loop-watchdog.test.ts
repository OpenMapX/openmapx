import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  eventLoopWatchdogThresholdMs,
  STARTUP_EVENT_LOOP_WATCHDOG_MS,
  startEventLoopWatchdog,
  startupEventLoopWatchdogThresholdMs,
} from "../event-loop-watchdog.js";
import { beginBoot } from "../safe-mode.js";
import { apiModule, runChild, startChild } from "./support/child-process.js";

const WATCHDOG = apiModule("event-loop-watchdog.ts");
const SAFE_MODE = apiModule("safe-mode.ts");
const HOST = apiModule("integration-host.ts");
// The child script lives in a temporary directory, so packages are imported by URL.
const FASTIFY = pathToFileURL(createRequire(HOST).resolve("fastify")).href;
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

/** A child that boots, runs `before`, starts the watchdog at `thresholdMs` and then runs `after`. */
function child(before: string, after: string, thresholdMs = 5_000) {
  return `
    import { startEventLoopWatchdog, stopEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};
    import { beginBoot, markIntegrationLoading, onInstalledCodeStart } from ${JSON.stringify(SAFE_MODE)};
    const runtimeDir = ${JSON.stringify(runtimeDir)};
    const log = { error: (message) => console.error(message), warn: (message) => console.error(message) };
    const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    beginBoot(runtimeDir, new Date());
    ${before}
    const watchdog = startEventLoopWatchdog({ thresholdMs: ${thresholdMs}, runtimeDir, log });
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
          // On a runner that gives the child half a core, the CPU time left
          // after the stop takes twice as long; 10 s keeps that clear of a kill.
          10_000,
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

  it(
    "still kills when the line to stderr cannot be written",
    async () => {
      const result = await runChild(
        child(
          'import { closeSync } from "node:fs";',
          "setTimeout(() => { closeSync(2); block(25_000); }, 100);",
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.signal).toBe("SIGKILL");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "watches start-up with the longer threshold and lowers it once the API listens",
    async () => {
      const result = await runChild(
        child(
          "",
          `setTimeout(() => {
            block(6_000);
            console.log("survived start-up");
            watchdog.setThreshold(5_000);
            setTimeout(() => block(20_000), 1_500);
          }, 100);`,
          8_000,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.stdout).toContain("survived start-up");
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toMatch(/event loop blocked for \d+ ms; exiting/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not kill right after the threshold is lowered",
    async () => {
      // A long start-up stretch right up to the switch is already above the
      // lower threshold; the switch starts the count afresh, so the work that
      // follows in the same stretch is measured on its own.
      const result = await runChild(
        child(
          "",
          `setTimeout(() => {
            block(6_000);
            watchdog.setThreshold(5_000);
            block(3_000);
            setTimeout(() => console.log("done"), 1_000);
          }, 100);`,
          12_000,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain("done");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "has its thread respect the stop flag even while it still runs",
    async () => {
      // stop() also terminates the thread; this drives a thread that only
      // sees the flag, as one does that is mid-tick when the stop comes.
      const result = await runChild(
        `
          import { startWatchdogWorker, WATCHDOG_SLOTS } from ${JSON.stringify(WATCHDOG)};
          import { beginBoot } from ${JSON.stringify(SAFE_MODE)};
          const runtimeDir = ${JSON.stringify(runtimeDir)};
          beginBoot(runtimeDir, new Date());
          const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * WATCHDOG_SLOTS.count);
          const shared = new Int32Array(buffer);
          Atomics.store(shared, WATCHDOG_SLOTS.THRESHOLD, 5_000);
          Atomics.store(shared, WATCHDOG_SLOTS.STOPPED, 1);
          startWatchdogWorker(buffer, runtimeDir);
          setTimeout(() => {
            const end = Date.now() + 8_000;
            while (Date.now() < end) {}
            console.log("survived");
          }, 100);
        `,
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stdout).toContain("survived");
      expect(result.stderr).not.toMatch(/event loop blocked/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps one watchdog per process, which a stop request ends",
    async () => {
      const result = await runChild(
        child(
          "",
          `const again = startEventLoopWatchdog({ thresholdMs: 9_000, runtimeDir, log });
          console.log(JSON.stringify(again === watchdog));
          stopEventLoopWatchdog();
          setTimeout(() => block(8_000), 100);`,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.stdout.trim()).toBe("true");
      expect(result.signal).toBeNull();
      expect(result.code).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("start-up through installed code", () => {
  /**
   * A start that, like the API, starts the watchdog at the test threshold as
   * installed code begins to load, and then freezes in `acme`'s import.
   */
  const freezingStart = () => `
    import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};
    import { beginBoot, markIntegrationLoading, onInstalledCodeStart } from ${JSON.stringify(SAFE_MODE)};
    const runtimeDir = ${JSON.stringify(runtimeDir)};
    const log = { error: (message) => console.error(message), warn: (message) => console.error(message) };
    const boot = beginBoot(runtimeDir, new Date());
    console.log(JSON.stringify(boot));
    if (!boot.enterSafeMode) {
      onInstalledCodeStart(() => {
        startEventLoopWatchdog({ thresholdMs: 5_000, runtimeDir, log });
      });
      markIntegrationLoading("acme", "import");
      const end = Date.now() + 20_000;
      while (Date.now() < end) {}
    }
  `;

  /**
   * The integration host loading one installed integration whose bundle is
   * `bundle`, with the watchdog started as the API starts it.
   */
  function hostLoading(bundle: string) {
    const installedRoot = join(runtimeDir, "installed");
    const directory = join(installedRoot, "acme");
    mkdirSync(join(directory, "dist", "backend"), { recursive: true });
    writeFileSync(
      join(directory, "manifest.json"),
      JSON.stringify({
        id: "acme",
        version: "1.0.0",
        platform: "1.0",
        license: "MIT",
        domains: ["knowledge"],
        quality: "community",
        backend: { entry: "dist/backend/index.mjs" },
      }),
    );
    writeFileSync(join(directory, "dist", "backend", "index.mjs"), bundle);
    return `
      import Fastify from ${JSON.stringify(FASTIFY)};
      import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};
      import { beginBoot, onInstalledCodeStart } from ${JSON.stringify(SAFE_MODE)};
      import {
        initIntegrations,
        setDisabledExtensionResolver,
        setInstalledIntegrationResolver,
      } from ${JSON.stringify(HOST)};
      const runtimeDir = ${JSON.stringify(runtimeDir)};
      const log = { error: (message) => console.error(message), warn: (message) => console.error(message) };
      beginBoot(runtimeDir, new Date());
      onInstalledCodeStart(() => {
        startEventLoopWatchdog({ thresholdMs: 5_000, runtimeDir, log });
      });
      setInstalledIntegrationResolver(null);
      setDisabledExtensionResolver(async () => new Set());
      await initIntegrations(Fastify({ logger: false }), [
        { directory: ${JSON.stringify(installedRoot)}, isBuiltIn: false },
      ]);
      console.log("loaded");
    `;
  }

  const hostEnv = () => ({
    OPENMAPX_INTEGRATION_CODE_CACHE_DIR: join(runtimeDir, "code-cache"),
    DATABASE_URL: "postgres://nobody:nothing@127.0.0.1:9/none",
    REDIS_URL: "",
  });

  it.each([
    ["its module code", "while (true) {}\nexport function setup() {}\n"],
    ["its setup", "export function setup() { while (true) {} }\n"],
  ])(
    "kills a start whose installed integration freezes in %s and names it",
    async (_label, bundle) => {
      const result = await runChild(hostLoading(bundle), {
        timeoutMs: CHILD_TIMEOUT_MS,
        env: hostEnv(),
      });
      expect(result.stdout).not.toContain("loaded");
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toMatch(/event loop blocked for \d+ ms; exiting/);
      expect(readMarker(runtimeDir)).toMatchObject({
        running: true,
        installedCodeStarted: true,
        lastFatal: { integrationId: "acme" },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kills a start that freezes in an installed import and reaches safe mode on the fourth start",
    async () => {
      const boots: unknown[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const result = await runChild(freezingStart(), { timeoutMs: CHILD_TIMEOUT_MS });
        boots.push(JSON.parse(result.stdout.trim().split("\n")[0] ?? "null"));
        if (attempt < 3) {
          expect(result.signal).toBe("SIGKILL");
          expect(readMarker(runtimeDir).lastFatal).toEqual({
            integrationId: "acme",
            at: expect.any(String),
          });
        }
      }
      expect(boots).toEqual([
        { enterSafeMode: false, integrationId: null },
        { enterSafeMode: false, integrationId: null },
        { enterSafeMode: false, integrationId: null },
        { enterSafeMode: true, integrationId: "acme" },
      ]);
      expect(JSON.parse(readFileSync(join(runtimeDir, "safe-mode.json"), "utf8"))).toEqual({
        mode: "automatic",
        integrationId: "acme",
      });
    },
    TEST_TIMEOUT_MS * 3,
  );
});

describe("startupEventLoopWatchdogThresholdMs", () => {
  it.each([
    [30_000, 60_000],
    [5_000, 60_000],
    [90_000, 90_000],
    [null, null],
  ])("turns a run-time threshold of %j into %j for start-up", (runtime, expected) => {
    expect(startupEventLoopWatchdogThresholdMs(runtime)).toBe(expected);
  });

  it("waits a minute at start-up", () => {
    expect(STARTUP_EVENT_LOOP_WATCHDOG_MS).toBe(60_000);
  });
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
