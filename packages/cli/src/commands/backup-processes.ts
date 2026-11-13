import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGzip } from "node:zlib";
import { execa } from "execa";
import { assertCliExecutionAvailable, cliProcessOptions } from "../lib/execution-deadline";

export interface BackupComposeContext {
  readonly composeArgs: readonly string[];
  readonly cwd: string;
}

/** A remote archive writer may still hold the directory; don't remove it. */
export class BackupWriterUnresolvedError extends Error {}

export function assertBackupMountPath(directory: string): void {
  if (/[,"'\r\n]/.test(directory))
    throw Error("Unsupported backup bind path: commas, quotes and newlines are not supported");
}

// Only the job created here is signalled. Closing the Docker transport's stdin
// also cancels it when the client receives the CLI's process-group signal.
const PG_SUPERVISOR = String.raw`token=$1
shift
set -m
finish() {
  printf '\n%s DONE %s\n' "$token" "$1" >&2
  exit "$1"
}
cancel() {
  trap '' TERM INT HUP
  kill -TERM %1 2>/dev/null || :
  for ((i=0; i<20; i++)); do
    [[ -z "$(jobs -pr)" ]] && break
    sleep 0.05
  done
  kill -KILL %1 2>/dev/null || :
  wait "$owned" 2>/dev/null || :
  finish 130
}
trap cancel TERM INT HUP
"$@" </dev/null &
owned=$!
while [[ -n "$(jobs -pr)" ]]; do
  IFS= read -r -t 0.1 unused
  state=$?
  if ((state != 0 && state <= 128)); then cancel; fi
done
wait "$owned"
finish "$?"
`;

/** Stream SQL without buffering it; client exit alone is not a dump receipt. */
export async function pgDumpToFile(
  ctx: BackupComposeContext,
  serviceId: string,
  user: string,
  database: string,
  outFile: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  const {
    timeout: _timeout,
    cancelSignal,
    forceKillAfterDelay: _forceKill,
    ...options
  } = cliProcessOptions();
  const effectiveSignal = cancelSignal ? AbortSignal.any([signal, cancelSignal]) : signal;
  effectiveSignal.throwIfAborted();
  assertCliExecutionAvailable();
  const token = randomBytes(16).toString("hex");
  const sub = execa(
    "docker",
    [
      ...ctx.composeArgs,
      "exec",
      "-T",
      serviceId,
      "bash",
      "-c",
      PG_SUPERVISOR,
      "openmapx-backup-pg-dump",
      token,
      // Owners and grants stay in the dump: the platform database separates
      // the API's and data-manager's roles, and a restore must keep them.
      "pg_dump",
      "-U",
      user,
      database,
    ],
    { ...options, cwd: ctx.cwd, reject: false, buffer: false, stdin: "pipe" },
  );
  let tail = Buffer.alloc(0);
  let line = "";
  let oversized = false;
  let protocolError = false;
  const completions: number[] = [];
  const decoder = new StringDecoder("utf8");
  sub.stderr?.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-8192);
    for (const character of decoder.write(chunk)) {
      if (character === "\n") {
        if (!oversized && line.startsWith(`${token} DONE `)) {
          const status = line.slice(token.length + 6);
          if (/^\d{1,3}$/.test(status) && Number(status) <= 255) {
            if (completions.length < 2) completions.push(Number(status));
          } else protocolError = true;
        }
        line = "";
        oversized = false;
      } else if (!oversized) {
        line += character;
        if (line.length > 512) {
          if (line.startsWith(`${token} DONE `)) protocolError = true;
          line = "";
          oversized = true;
        }
      }
    }
  });
  const timers: ReturnType<typeof setTimeout>[] = [];
  let cancellation: unknown;
  const cancel = (reason: unknown) => {
    if (cancellation !== undefined) return;
    cancellation = reason ?? Error("Backup interrupted");
    sub.stdin?.end();
    for (const [delay, killSignal] of [
      [250, "SIGTERM"],
      [500, "SIGKILL"],
    ] as const) {
      const timer = setTimeout(() => {
        if (sub.nodeChildProcess.exitCode === null && sub.nodeChildProcess.signalCode === null)
          sub.kill(killSignal);
      }, delay);
      timer.unref();
      timers.push(timer);
    }
  };
  const abort = () => cancel(effectiveSignal.reason);
  sub.stdin?.on("error", () => {
    // A group signal may close the client before we end its stdin.
  });
  effectiveSignal.addEventListener("abort", abort, { once: true });
  if (effectiveSignal.aborted) abort();
  // Keep stderr parsing and cancellation live until both streams and client settle.
  const transfer = sub.stdout
    ? pipeline(sub.stdout, createGzip(), createWriteStream(outFile, { mode: 0o600 })).catch(
        (error: unknown) => {
          cancel(error);
          throw error;
        },
      )
    : Promise.reject(Error("pg_dump subprocess has no stdout stream"));
  try {
    const [processResult, streamResult] = await Promise.allSettled([sub, transfer]);
    if (cancellation !== undefined) throw cancellation;
    if (streamResult.status === "rejected") throw streamResult.reason;
    if (processResult.status === "rejected") throw processResult.reason;
    const result = processResult.value;
    if (completions.length === 0 && [126, 127].includes(result.exitCode ?? -1))
      throw Error(`Bash unavailable in ${serviceId} image; pg_dump backups require Bash`);
    if (protocolError || completions.length !== 1)
      throw Error(
        `pg_dump completion is unconfirmed for ${serviceId} (exit ${result.exitCode ?? "unknown"}): ${tail.toString("utf8")}`,
      );
    if (result.failed || result.exitCode !== 0 || completions[0] !== 0)
      throw Error(`pg_dump failed for ${serviceId}: ${tail.toString("utf8")}`);
    effectiveSignal.throwIfAborted();
    assertCliExecutionAvailable();
  } finally {
    sub.stdin?.end();
    effectiveSignal.removeEventListener("abort", abort);
    for (const timer of timers) clearTimeout(timer);
  }
}

/** Each archive has a dedicated helper, never a service-container identity. */
export async function tarVolumeToFile(
  volumeName: string,
  backupDir: string,
  fileName: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  assertBackupMountPath(backupDir);
  const options = cliProcessOptions();
  const effectiveSignal = options.cancelSignal
    ? AbortSignal.any([signal, options.cancelSignal])
    : signal;
  effectiveSignal.throwIfAborted();
  const nonce = randomUUID();
  // The non-hex prefix prevents Docker interpreting a missing name as an ID prefix.
  const name = `openmapx-backup-tar-${nonce}`;
  const label = `openmapx.backup-writer=${nonce}`;
  let cancelledAt: number | undefined;
  const abort = () => {
    cancelledAt ??= Date.now();
  };
  effectiveSignal.addEventListener("abort", abort, { once: true });
  const sub = execa(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      "--name",
      name,
      "--label",
      label,
      "-v",
      `${volumeName}:/source:ro`,
      "--mount",
      `type=bind,source=${backupDir},target=/backup`,
      "alpine",
      "tar",
      "-czf",
      `/backup/${fileName}`,
      "-C",
      "/source",
      ".",
    ],
    {
      ...options,
      cancelSignal: effectiveSignal,
      forceKillAfterDelay: 500,
      reject: false,
      buffer: false,
    },
  );
  let tail = Buffer.alloc(0);
  sub.stdout?.resume();
  sub.stderr?.on("data", (chunk: Buffer) => {
    tail = Buffer.concat([tail, chunk]).subarray(-8192);
  });
  try {
    const result = await sub;
    if (result.failed || result.exitCode !== 0 || effectiveSignal.aborted) {
      if (effectiveSignal.aborted) throw effectiveSignal.reason;
      if (tail.toString("utf8").includes("docker-init"))
        throw Error("Docker init is unavailable; tar backups require docker-init");
      throw Error(`tar of volume ${volumeName} failed: ${tail.toString("utf8")}`);
    }
    const output = join(backupDir, fileName);
    if (!existsSync(output) || !lstatSync(output).isFile() || lstatSync(output).nlink !== 1)
      throw Error(`tar of volume ${volumeName} did not create ${fileName}`);
    assertCliExecutionAvailable();
  } catch (error) {
    // The run client is reaped before removal, so it cannot send a later start.
    // A late create can leave only an inactive container with our unique label.
    const deadline = (cancelledAt ?? Date.now()) + 2000;
    const quiesce = async (args: string[]) => {
      const remaining = deadline - Date.now();
      if (remaining <= 50) throw Error("Backup cleanup budget elapsed");
      return execa("docker", args, {
        env: options.env,
        timeout: Math.min(750, remaining - 50),
        forceKillAfterDelay: 50,
        reject: false,
        maxBuffer: 8192,
      });
    };
    let absent = false;
    for (let attempt = 0; attempt < 2 && !absent; attempt++) {
      try {
        await quiesce(["rm", "--force", name]);
        const observed = await quiesce(["ps", "-aq", "--filter", `label=${label}`]);
        absent = !observed.failed && observed.exitCode === 0 && observed.stdout.trim() === "";
      } catch {
        // One retry is still bounded by the same original cleanup deadline.
      }
    }
    if (!absent)
      throw new BackupWriterUnresolvedError(
        `Backup writer shutdown is unconfirmed; preserve partial files and inspect label ${label}`,
        { cause: error },
      );
    throw error;
  } finally {
    effectiveSignal.removeEventListener("abort", abort);
  }
}
