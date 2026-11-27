import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiModule, runChild, startChild } from "./support/child-process.js";

const SCOPE = apiModule("integration-scope.ts");
const SAFE_MODE = apiModule("safe-mode.ts");
const CHILD_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 60_000;

let runtimeDir: string;

beforeEach(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), "omx-fatal-attribution-"));
});

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true });
});

function readMarker() {
  return JSON.parse(readFileSync(join(runtimeDir, "boot-marker.json"), "utf8"));
}

/** A child that reports the integration its fatal handler sees for `event`. */
function attributionChild(event: "unhandledRejection" | "uncaughtException", fail: string) {
  return `
    import { currentIntegrationScope, runInIntegrationScope } from ${JSON.stringify(SCOPE)};
    process.on(${JSON.stringify(event)}, () => {
      console.log(JSON.stringify({ id: currentIntegrationScope()?.integrationId ?? null }));
      process.exit(1);
    });
    runInIntegrationScope({ integrationId: "acme", isBuiltIn: false, revoked: false }, () => {
      setTimeout(() => { ${fail} }, 5);
    });
  `;
}

/**
 * A process that boots, loads `acme` and then fails in work `acme` left
 * behind, with the fatal handler the API installs.
 */
function crashingProcess(runtime: string) {
  return `
    import { currentIntegrationScope, runInIntegrationScope } from ${JSON.stringify(SCOPE)};
    import { beginBoot, markIntegrationLoaded, markIntegrationLoading, recordFatal } from ${JSON.stringify(SAFE_MODE)};
    const onFatal = () => {
      recordFatal(currentIntegrationScope()?.integrationId ?? null);
      process.exit(1);
    };
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
    const boot = beginBoot(${JSON.stringify(runtime)}, new Date());
    console.log(JSON.stringify(boot));
    if (!boot.enterSafeMode) {
      markIntegrationLoading("acme", "import");
      markIntegrationLoading("acme", "setup");
      runInIntegrationScope({ integrationId: "acme", isBuiltIn: false, revoked: false }, () => {
        setTimeout(() => { void Promise.reject(new Error("left behind")); }, 20);
      });
      markIntegrationLoaded();
    }
  `;
}

describe("the integration a fatal error is attributed to", () => {
  it(
    "identifies the integration in the unhandled-rejection handler",
    async () => {
      const { stdout, code } = await runChild(
        attributionChild("unhandledRejection", 'void Promise.reject(new Error("x"));'),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).id).toBe("acme");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "identifies the integration in the uncaught-exception handler",
    async () => {
      const { stdout, code } = await runChild(
        attributionChild("uncaughtException", 'throw new Error("x");'),
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(code).toBe(1);
      expect(JSON.parse(stdout).id).toBe("acme");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is written to the boot marker before the process exits",
    async () => {
      const { code } = await runChild(crashingProcess(runtimeDir), { timeoutMs: CHILD_TIMEOUT_MS });
      expect(code).toBe(1);
      expect(readMarker()).toMatchObject({
        running: true,
        installedCodeStarted: true,
        current: null,
        lastFatal: { integrationId: "acme" },
      });
    },
    TEST_TIMEOUT_MS,
  );
});

describe("automatic safe mode across processes", () => {
  it(
    "starts the fourth process in safe mode after three crashes and names the integration",
    async () => {
      const boots: unknown[] = [];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const { code, stdout } = await runChild(crashingProcess(runtimeDir), {
          timeoutMs: CHILD_TIMEOUT_MS,
        });
        boots.push(JSON.parse(stdout.trim().split("\n")[0] ?? "null"));
        if (attempt < 3) expect(code).toBe(1);
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
      expect(readMarker().uncleanExits).toEqual([]);
    },
    TEST_TIMEOUT_MS * 2,
  );

  it(
    "counts a process killed after its stop was requested as stopped cleanly",
    async () => {
      const running = startChild(
        `
          import { beginBoot, markCleanStop, markIntegrationLoading } from ${JSON.stringify(SAFE_MODE)};
          beginBoot(${JSON.stringify(runtimeDir)}, new Date());
          markIntegrationLoading("acme", "setup");
          // A shutdown that never finishes, as when a handler hangs.
          process.on("SIGTERM", () => { markCleanStop(); });
          setInterval(() => {}, 1_000);
          console.log("ready");
        `,
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      await running.printed("ready");
      running.child.kill("SIGTERM");
      const deadline = Date.now() + 10_000;
      while (readMarker().running && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
      running.child.kill("SIGKILL");
      expect((await running.exited).signal).toBe("SIGKILL");

      const next = await runChild(
        `
          import { beginBoot } from ${JSON.stringify(SAFE_MODE)};
          console.log(JSON.stringify(beginBoot(${JSON.stringify(runtimeDir)}, new Date())));
        `,
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(JSON.parse(next.stdout)).toEqual({ enterSafeMode: false, integrationId: null });
      expect(readMarker().uncleanExits).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves the previous process's marker alone when stopped before its boot began",
    async () => {
      const previous = {
        version: 1,
        running: true,
        installedCodeStarted: true,
        current: { integrationId: "acme", phase: "setup" },
        lastFatal: null,
        uncleanExits: [],
      };
      writeFileSync(join(runtimeDir, "boot-marker.json"), JSON.stringify(previous));
      const { code } = await runChild(
        `
          import { markCleanStop, recordFatal } from ${JSON.stringify(SAFE_MODE)};
          markCleanStop();
          recordFatal("other");
        `,
        { timeoutMs: CHILD_TIMEOUT_MS },
      );
      expect(code).toBe(0);
      expect(readMarker()).toEqual(previous);
      expect(existsSync(join(runtimeDir, "safe-mode.json"))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});
