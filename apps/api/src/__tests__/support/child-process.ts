import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const API_DIRECTORY = fileURLToPath(new URL("../../../", import.meta.url));

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

/**
 * Starts `source` as an ES module under tsx in its own process, from the API's
 * directory. The child is killed when it outlives `timeoutMs`, so a test that
 * expects it to end by itself fails instead of hanging.
 */
export function startChild(
  source: string,
  options: { timeoutMs: number; env?: NodeJS.ProcessEnv; nodeArgs?: string[] },
): RunningChild {
  const directory = mkdtempSync(join(tmpdir(), "omx-child-"));
  const script = join(directory, "child.mts");
  writeFileSync(script, source);
  const tsx = createRequire(import.meta.url).resolve("tsx/esm");
  const args = [...(options.nodeArgs ?? []), "--import", tsx, script];
  const child = spawn(process.execPath, args, {
    cwd: API_DIRECTORY,
    env: { ...process.env, LOG_LEVEL: "silent", ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const waiters: Array<{ line: string; resolve: () => void }> = [];
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const lines = new Set(stdout.split("\n").map((line) => line.trim()));
    for (const waiter of waiters.splice(0)) {
      if (lines.has(waiter.line)) waiter.resolve();
      else waiters.push(waiter);
    }
  });
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  const exited = new Promise<ChildResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      rmSync(directory, { recursive: true, force: true });
      resolve({ code, signal, stdout, stderr });
    });
  });
  return {
    child,
    exited,
    printed: (line) =>
      new Promise<void>((resolve, reject) => {
        if (stdout.split("\n").some((printedLine) => printedLine.trim() === line)) {
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
