// packages/core/src/spawn.ts
//
// `spawn(cmd, args)` with three things you almost always want when running
// child processes from server code:
//
//   1. Line-buffered stdout/stderr handed to a callback (so partial lines
//      across chunk boundaries don't get split mid-word).
//   2. AbortSignal cancellation that SIGTERMs the child.
//   3. A clean rejection with the exit code on non-zero exit.
//
// Used by the git-clone helper and the integration build step (which spawns
// `npx esbuild`). Anything else in core that needs to shell out should use
// this rather than rolling another `spawn(...)` plus chunk handling.

import { spawn } from "node:child_process";

export interface SpawnWithBufferedLogsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
}

export function spawnWithBufferedLogs(
  cmd: string,
  args: string[],
  opts: SpawnWithBufferedLogsOptions = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutBuf = { current: "" };
    const stderrBuf = { current: "" };
    if (opts.onLog) {
      const onLog = opts.onLog;
      proc.stdout?.on("data", (chunk: Buffer) =>
        emitLineBuffered(stdoutBuf, chunk, "stdout", onLog),
      );
      proc.stderr?.on("data", (chunk: Buffer) =>
        emitLineBuffered(stderrBuf, chunk, "stderr", onLog),
      );
    }
    const onAbort = () => proc.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort);
    proc.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onLog) {
        flushLineBuffer(stdoutBuf, "stdout", opts.onLog);
        flushLineBuffer(stderrBuf, "stderr", opts.onLog);
      }
      if (opts.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      else if (code === 0) resolvePromise();
      else reject(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`));
    });
    proc.on("error", reject);
  });
}

function emitLineBuffered(
  buffer: { current: string },
  chunk: Buffer,
  stream: "stdout" | "stderr",
  onLog: NonNullable<SpawnWithBufferedLogsOptions["onLog"]>,
): void {
  buffer.current += chunk.toString();
  let nl = buffer.current.indexOf("\n");
  while (nl >= 0) {
    const line = buffer.current.slice(0, nl);
    if (line.length > 0) onLog(line, stream);
    buffer.current = buffer.current.slice(nl + 1);
    nl = buffer.current.indexOf("\n");
  }
}

function flushLineBuffer(
  buffer: { current: string },
  stream: "stdout" | "stderr",
  onLog: NonNullable<SpawnWithBufferedLogsOptions["onLog"]>,
): void {
  if (buffer.current.length > 0) {
    onLog(buffer.current, stream);
    buffer.current = "";
  }
}
