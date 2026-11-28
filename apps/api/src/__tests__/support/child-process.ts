import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_DIRECTORY = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * The longest a child may take to start, until its imports are evaluated. On a
 * loaded two-core runner tsx alone has taken over 20 seconds; this only ends
 * a child that hangs before it runs.
 */
const START_LIMIT_MS = 120_000;

/** The line a child writes once it runs; the helper keeps it out of `stdout`. */
const RUNNING_LINE = "[child is running]";

/** A test's timeout that leaves room for a slow child start besides `runMs`. */
export function childTestTimeout(runMs: number): number {
  return START_LIMIT_MS + runMs;
}

/** A `file:` URL of a module under `apps/api/src`, for a child script to import. */
export function apiModule(path: string): string {
  return pathToFileURL(join(API_DIRECTORY, "src", path)).href;
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunningChild {
  child: ChildProcess;
  /** Resolves once the child printed a line equal to `line`. */
  printed(line: string): Promise<void>;
  exited: Promise<ChildResult>;
}

const alive = new Set<ChildProcess>();

/**
 * Kills every child still running. Call it after each test, so a test that
 * failed while its child was stopped or spinning leaves nothing behind.
 */
export function killLeftoverChildren(): void {
  for (const child of alive) child.kill("SIGKILL");
  alive.clear();
}

/**
 * Starts `source` as an ES module under tsx in its own process, from the API's
 * directory. The child is killed when it outlives `timeoutMs` from the moment
 * its imports are evaluated, so a test that expects it to end by itself fails
 * instead of hanging, and a slow start does not count against the test's own
 * timing.
 */
export function startChild(
  source: string,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; nodeArgs?: string[] },
): RunningChild {
  const directory = mkdtempSync(join(tmpdir(), "omx-child-"));
  const script = join(directory, "child.mts");
  // Imports are evaluated before the first statement, and a synchronous write
  // reaches the pipe even when the code that follows blocks the event loop.
  writeFileSync(
    script,
    `import { writeSync as writeRunningLine } from "node:fs";\nwriteRunningLine(1, ${JSON.stringify(`${RUNNING_LINE}\n`)});\n${source}`,
  );
  const tsx = createRequire(import.meta.url).resolve("tsx/esm");
  const args = [...(options.nodeArgs ?? []), "--import", tsx, script];
  const child = spawn(process.execPath, args, {
    cwd: API_DIRECTORY,
    env: { ...process.env, LOG_LEVEL: "silent", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  alive.add(child);
  let raw = "";
  let stdout = "";
  let stderr = "";
  let timer = setTimeout(() => child.kill("SIGKILL"), START_LIMIT_MS);
  let running = false;
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  const lines = () => new Set(stdout.split("\n").map((line) => line.trim()));
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    raw += chunk;
    if (!running && raw.includes(`${RUNNING_LINE}\n`)) {
      running = true;
      clearTimeout(timer);
      timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
    }
    stdout = raw.replace(`${RUNNING_LINE}\n`, "");
    const printedLines = lines();
    for (const waiter of waiters.splice(0)) {
      if (printedLines.has(waiter.line)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<ChildResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      alive.delete(child);
      rmSync(directory, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    child,
    exited,
    printed: (line) =>
      new Promise<void>((resolve, reject) => {
        if (lines().has(line)) {
          resolve();
          return;
        }
        waiters.push({ line, resolve });
        void exited.then((result) =>
          reject(
            new Error(
              `The child exited (${result.code ?? result.signal}) before printing ${line}: ${result.stderr}`,
            ),
          ),
        );
      }),
  };
}

export function runChild(
  source: string,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; nodeArgs?: string[] },
): Promise<ChildResult> {
  return startChild(source, options).exited;
}
