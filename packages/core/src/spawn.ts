// `spawn(cmd, args)` with three things you almost always want when running
// child processes from server code:
//
//   1. Line-buffered stdout/stderr handed to a callback (so partial lines
//      across chunk boundaries don't get split mid-word).
//   2. AbortSignal cancellation that SIGTERMs the child.
//   3. A clean rejection with the exit code on non-zero exit.
//
// Used by the bounded git-clone helper. Anything else in core that needs to
// shell out should use this rather than rolling another `spawn(...)` plus
// chunk handling.

import { spawn } from "node:child_process";

export interface SpawnWithBufferedLogsOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLog?: (line: string, stream: "stdout" | "stderr") => void;
  /**
   * What to name this process in a failure message. argv can carry a repository
   * URL with userinfo, a token, or a query string, so the default error text
   * never reproduces it.
   */
  displayCommand?: string;
}

// Anything that looks like a URL with embedded credentials, or a bare token in
// a query string. Child stderr (notably git's) echoes the remote it was given.
const CREDENTIALED_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]*@[^\s]*/giu;
const URL_WITH_QUERY = /\b[a-z][a-z0-9+.-]*:\/\/[^\s]*[?#][^\s]*/giu;

/**
 * Remove credentials and query/fragment data from a line that will be logged or
 * put in an error. Ordinary, non-sensitive compiler and tool output is left
 * intact so real failures stay diagnosable.
 */
export function redactProcessOutput(line: string): string {
  return line.replace(CREDENTIALED_URL, "[redacted-url]").replace(URL_WITH_QUERY, "[redacted-url]");
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
      const safeLog = (line: string, stream: "stdout" | "stderr") =>
        onLog(redactProcessOutput(line), stream);
      proc.stdout?.on("data", (chunk: Buffer) =>
        emitLineBuffered(stdoutBuf, chunk, "stdout", safeLog),
      );
      proc.stderr?.on("data", (chunk: Buffer) =>
        emitLineBuffered(stderrBuf, chunk, "stderr", safeLog),
      );
    }
    const onAbort = () => proc.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort);
    proc.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.onLog) {
        const onLog = opts.onLog;
        const safeLog = (line: string, stream: "stdout" | "stderr") =>
          onLog(redactProcessOutput(line), stream);
        flushLineBuffer(stdoutBuf, "stdout", safeLog);
        flushLineBuffer(stderrBuf, "stderr", safeLog);
      }
      if (opts.signal?.aborted) reject(new DOMException("Aborted", "AbortError"));
      else if (code === 0) resolvePromise();
      else {
        const display = opts.displayCommand ?? redactProcessOutput(`${cmd} ${args.join(" ")}`);
        reject(new Error(`${display} exited with code ${code}`));
      }
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
