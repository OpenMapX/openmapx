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
import {
  apiModule,
  childTestTimeout,
  killLeftoverChildren,
  runChild,
  startChild,
} from "./support/child-process.js";

const WATCHDOG = apiModule("event-loop-watchdog.ts");
const SAFE_MODE = apiModule("safe-mode.ts");
const HOST = apiModule("integration-host.ts");
// The child script lives in a temporary directory, so packages are imported by URL.
const FASTIFY = pathToFileURL(createRequire(HOST).resolve("fastify")).href;
/** How long a child may run once started; every child here ends well before. */
const CHILD_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = childTestTimeout(CHILD_TIMEOUT_MS);
/**
 * Most children watch at a quarter of the API's one-second heartbeat, with
 * thresholds and blocks scaled down alike, so the rules hold at the same
 * ratios in a quarter of the time. The first test keeps the API's heartbeat.
 */
const FAST_HEARTBEAT_MS = 250;
const FAST_THRESHOLD_MS = 1_500;

let runtimeDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "omx-watchdog-"));
});

afterEach(() => {
  killLeftoverChildren();
  rmSync(runtimeDir, { recursive: true, force: true });
});

function readMarker(directory: string) {
  return JSON.parse(readFileSync(join(directory, "boot-marker.json"), "utf8"));
}

/**
 * A child that boots, runs `before`, starts the watchdog at `thresholdMs` and
 * the fast heartbeat (or the API's when `heartbeatMs` is null) and then runs
 * `after`.
 */
function child(
  before: string,
  after: string,
  thresholdMs = FAST_THRESHOLD_MS,
  heartbeatMs: number | null = FAST_HEARTBEAT_MS,
) {
  const heartbeat = heartbeatMs === null ? "" : `, heartbeatMs: ${heartbeatMs}`;
  return `
    import { startEventLoopWatchdog, stopEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};
    import { beginBoot, markIntegrationLoading, onInstalledCodeStart } from ${JSON.stringify(SAFE_MODE)};
    const runtimeDir = ${JSON.stringify(runtimeDir)};
    const log = { error: (message) => console.error(message), warn: (message) => console.error(message) };
    const block = (ms) => { const end = Date.now() + ms; while (Date.now() < end) {} };
    beginBoot(runtimeDir, new Date());
    ${before}
    const watchdog = startEventLoopWatchdog({ thresholdMs: ${thresholdMs}, runtimeDir, log${heartbeat} });
    ${after}
  `;
}

describe("the event-loop watchdog", () => {
  it(
    "kills a process whose event loop is blocked beyond the threshold, names the integration that was loading and counts the exit",
    async () => {
      const result = await runChild(
        child(
          'markIntegrationLoading("acme", "setup");',
          "setTimeout(() => block(25_000), 100);",
          3_000,
          null,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toMatch(/event loop blocked for \d+ ms; exiting/);
      expect(readMarker(runtimeDir)).toMatchObject({
        running: true,
        lastFatal: { integrationId: "acme", at: expect.any(String) },
      });
      beginBoot(runtimeDir, new Date());
      expect(readMarker(runtimeDir).uncleanExits).toEqual([
        expect.objectContaining({ integrationId: "acme" }),
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not write through a file left at its temporary name",
    async () => {
      const outside = join(runtimeDir, "outside");
      writeFileSync(outside, "keep");
      const result = await runChild(
        child(
          `import { symlinkSync } from "node:fs";
          symlinkSync(${JSON.stringify(outside)}, runtimeDir + "/boot-marker.json." + process.pid + ".watchdog.tmp");
          markIntegrationLoading("acme", "setup");`,
          "setTimeout(() => block(25_000), 100);",
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.signal).toBe("SIGKILL");
      expect(readFileSync(outside, "utf8")).toBe("keep");
      expect(readMarker(runtimeDir)).toMatchObject({
        lastFatal: { integrationId: "acme", at: expect.any(String) },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "still kills a blocked process when it has no marker to record in",
    async () => {
      const result = await runChild(
        `
          import { startEventLoopWatchdog } from ${JSON.stringify(WATCHDOG)};
          const log = { error: (message) => console.error(message), warn: (message) => console.error(message) };
          startEventLoopWatchdog({ thresholdMs: ${FAST_THRESHOLD_MS}, runtimeDir: null, log, heartbeatMs: ${FAST_HEARTBEAT_MS} });
          setTimeout(() => { const end = Date.now() + 25_000; while (Date.now() < end) {} }, 100);
        `,
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.signal).toBe("SIGKILL");
      expect(result.stderr).toMatch(/event loop blocked for \d+ ms; exiting/);
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
      // A quarter of the threshold stands for the synchronous scan of a large
      // extension bundle.
      const result = await runChild(
        child(
          "",
          "setTimeout(() => block(500), 250); setTimeout(() => console.log('done'), 2_000);",
          2_000,
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
    "keeps one watchdog per process and does not kill once a stop request ended it",
    async () => {
      const result = await runChild(
        child(
          "",
          `const again = startEventLoopWatchdog({ thresholdMs: 9_000, runtimeDir, log });
          console.log(JSON.stringify(again === watchdog));
          stopEventLoopWatchdog();
          setTimeout(() => block(2_500), 100);`,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.stdout.trim()).toBe("true");
      expect(result).toMatchObject({ code: 0, signal: null });
      expect(result.stderr).not.toMatch(/event loop blocked/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not take a suspended process for a blocked one",
    async () => {
      // SIGSTOP halts every thread, as a host's suspend does, while the clock
      // goes on past the threshold. The main thread is busy for 1.5 seconds
      // of CPU time across the stop, so it is still blocked when the
      // watchdog's thread wakes up; even at half a core what is left of it
      // stays well under the threshold. The busy stretch starts once the
      // thread is ticking, and the stop comes after it ticked during the
      // stretch, so the jump is all that could count.
      const running = startChild(
        child(
          'import { writeSync } from "node:fs";',
          `setTimeout(() => {
            const cpu = () => { const { user, system } = process.cpuUsage(); return user + system; };
            writeSync(1, "busy\\n");
            const start = cpu();
            while (cpu() - start < 1_500_000) {}
          }, 1_000);
          setTimeout(() => console.log("done"), 1_250);`,
          4_000,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      await running.printed("busy");
      await new Promise((resolve) => setTimeout(resolve, 600));
      running.child.kill("SIGSTOP");
      await new Promise((resolve) => setTimeout(resolve, 4_500));
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
          "inspector.open(0, '127.0.0.1'); setTimeout(() => { block(2_500); inspector.close(); }, 600);",
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
          // Shorter than the child's time limit, so only the watchdog kills it.
          "setTimeout(() => { closeSync(2); block(10_000); }, 100);",
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.signal).toBe("SIGKILL");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "watches start-up with the longer threshold, lowers it once the API listens and counts afresh from the switch",
    async () => {
      // The start-up stretch right up to the switch is already above the lower
      // threshold, and the work after the switch in the same stretch would
      // carry it further; the switch starts the count afresh. Once the
      // threshold is lower, a later block is killed at the lower one.
      const result = await runChild(
        child(
          "",
          `setTimeout(() => {
            block(1_500);
            watchdog.setThreshold(${FAST_THRESHOLD_MS});
            block(600);
            console.log("survived start-up");
            setTimeout(() => block(20_000), 400);
          }, 100);`,
          3_000,
        ),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(result.stdout).toContain("survived start-up");
      expect(result.signal).toBe("SIGKILL");
      const blockedMs = Number(/event loop blocked for (\d+) ms; exiting/.exec(result.stderr)?.[1]);
      expect(blockedMs).toBeGreaterThanOrEqual(FAST_THRESHOLD_MS);
      expect(blockedMs).toBeLessThan(3_000);
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
          Atomics.store(shared, WATCHDOG_SLOTS.THRESHOLD, ${FAST_THRESHOLD_MS});
          Atomics.store(shared, WATCHDOG_SLOTS.STOPPED, 1);
          startWatchdogWorker(buffer, runtimeDir, ${FAST_HEARTBEAT_MS});
          setTimeout(() => {
            const end = Date.now() + 2_500;
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
});

describe("start-up through installed code", () => {
  /**
   * A start that, like the API, starts the watchdog as installed code begins
   * to load, and then freezes in `acme`'s import.
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
        startEventLoopWatchdog({
          thresholdMs: ${FAST_THRESHOLD_MS},
          runtimeDir,
          log,
          heartbeatMs: ${FAST_HEARTBEAT_MS},
        });
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
        startEventLoopWatchdog({
          thresholdMs: ${FAST_THRESHOLD_MS},
          runtimeDir,
          log,
          heartbeatMs: ${FAST_HEARTBEAT_MS},
        });
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
    "counts a start killed in an installed import towards safe mode, which the next start enters",
    async () => {
      // Two earlier unclean exits without a name; the boot marker's own tests
      // pin how exits are counted, this one that the kill is one of them.
      const earlier = { at: new Date().toISOString(), integrationId: null };
      writeFileSync(
        join(runtimeDir, "boot-marker.json"),
        JSON.stringify({
          version: 1,
          running: false,
          installedCodeStarted: false,
          current: null,
          lastFatal: null,
          uncleanExits: [earlier, earlier],
        }),
      );
      const result = await runChild(freezingStart(), { timeoutMs: CHILD_TIMEOUT_MS });
      expect(JSON.parse(result.stdout.trim().split("\n")[0] ?? "null")).toEqual({
        enterSafeMode: false,
        integrationId: null,
      });
      expect(result.signal).toBe("SIGKILL");
      expect(readMarker(runtimeDir).lastFatal).toEqual({
        integrationId: "acme",
        at: expect.any(String),
      });

      expect(beginBoot(runtimeDir, new Date())).toEqual({
        enterSafeMode: true,
        integrationId: "acme",
      });
      expect(JSON.parse(readFileSync(join(runtimeDir, "safe-mode.json"), "utf8"))).toEqual({
        mode: "automatic",
        integrationId: "acme",
      });
    },
    TEST_TIMEOUT_MS,
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
  const manifest = () =>
    JSON.parse(readFileSync(join(repository, "services", "api", "service.json"), "utf8")) as {
      container: { environment: Record<string, string>; stopGracePeriod?: string };
    };

  it("start Node under tini and pass the threshold through", () => {
    const dockerfile = readFileSync(join(repository, "apps", "api", "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^RUN apk add --no-cache [^\n]*\btini\b/m);
    expect(dockerfile).toMatch(
      /^ENTRYPOINT \["\/sbin\/tini", "--"\]\n(?:#[^\n]*\n)*CMD \["node", /m,
    );
    expect(manifest().container.environment.OPENMAPX_EVENT_LOOP_WATCHDOG_MS).toBe(
      "${OPENMAPX_EVENT_LOOP_WATCHDOG_MS:-}",
    );
  });

  it("give the stop sequence twenty seconds before Docker kills the API", () => {
    // Migration cancel 5 s, server close 5 s + 2 s, installed shutdown
    // handlers 5 s and the pools' end 2 s add up to 19 s.
    expect(manifest().container.stopGracePeriod).toBe("20s");
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
