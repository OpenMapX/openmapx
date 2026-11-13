/** Runs a process the way its container would: in private mount and PID
 * namespaces, with each bind mount of its container at the container path, as
 * the container's user and groups. Killing it kills everything it started, as
 * killing a container does. Linux with passwordless sudo only; this is what
 * lets an entrypoint that reads `/data` or `/run/secrets/...` run unmodified
 * outside Docker. */
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface BindMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface ContainedProcess {
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly started: Promise<void>;
  readonly output: () => string;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** SIGKILL ends the whole namespace; SIGTERM goes to its first process. */
  kill(signal?: "SIGKILL" | "SIGTERM"): void;
}

/** Directories outside the host's own tree under which container paths live.
 * Each gets an empty tmpfs inside the namespace so nothing leaks to the host. */
const ANCHORS = [
  "/data",
  "/config",
  "/secrets",
  "/app",
  "/run/secrets",
  "/run/openmapx",
  "/var/lib/openmapx",
  "/home/node",
];

let anchorsPrepared = false;

export function sandboxAvailable(): string | undefined {
  if (process.platform !== "linux")
    return "the crash-point roles run in Linux namespaces; use the documented Linux container";
  if (spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status !== 0)
    return "the crash-point roles need passwordless sudo to create namespaces";
  return undefined;
}

function prepareAnchors() {
  if (anchorsPrepared) return;
  const missing = ANCHORS.filter((path) => !existsSync(path));
  if (missing.length) {
    const result = spawnSync("sudo", ["-n", "mkdir", "-p", ...missing], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Cannot create mount anchors: ${result.stderr}`);
  }
  anchorsPrepared = true;
}

function anchorOf(target: string): string | undefined {
  return ANCHORS.filter((anchor) => target === anchor || target.startsWith(`${anchor}/`)).sort(
    (a, b) => b.length - a.length,
  )[0];
}

/** Node's `--env-file` keeps single- or backtick-quoted values verbatim; double
 * quotes would only expand `\n` and leave escaped quotes escaped. */
function envFileValue(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  throw new Error("An environment value holds both quote characters");
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The shell program run as root inside the new namespaces before the process. */
function mountProgram(binds: readonly BindMount[]): string {
  const lines = ["set -e"];
  const anchors = new Set<string>();
  for (const bind of binds) {
    const anchor = anchorOf(bind.target);
    if (anchor) anchors.add(anchor);
  }
  for (const anchor of [...anchors].sort((a, b) => a.length - b.length))
    lines.push(`mount -t tmpfs -o mode=0755 tmpfs ${quote(anchor)}`);
  // Outermost first so a nested mount lands on top of its parent.
  const ordered = [...binds].sort((a, b) => a.target.length - b.target.length);
  for (const bind of ordered) {
    // A container mounts the host directory at its own path; it is already
    // there. Its read-only flag is not reproduced, because the writable state
    // directories mounted inside it would inherit it.
    if (bind.source === bind.target) continue;
    const isDirectory = spawnSync("test", ["-d", bind.source]).status === 0;
    if (isDirectory) lines.push(`mkdir -p ${quote(bind.target)}`);
    else
      lines.push(
        `mkdir -p ${quote(dirname(bind.target))}`,
        `[ -e ${quote(bind.target)} ] || touch ${quote(bind.target)}`,
      );
    lines.push(`mount --bind ${quote(bind.source)} ${quote(bind.target)}`);
    if (bind.readOnly) lines.push(`mount -o remount,bind,ro ${quote(bind.target)}`);
  }
  return lines.join("\n");
}

export function launchContained(options: {
  name: string;
  workDir: string;
  argv: readonly string[];
  env: Record<string, string>;
  binds: readonly BindMount[];
  uid: number;
  gid: number;
  groups: readonly number[];
  cwd: string;
}): ContainedProcess {
  prepareAnchors();
  const envFile = join(options.workDir, `${options.name}.env`);
  writeFileSync(
    envFile,
    Object.entries(options.env)
      .map(([key, value]) => `${key}=${envFileValue(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const [executable, ...rest] = options.argv as [string, ...string[]];
  const groups = [...new Set([options.gid, ...options.groups])].join(",");
  const inner = [
    mountProgram(options.binds),
    `cd ${quote(options.cwd)}`,
    `exec setpriv --reuid=${options.uid} --regid=${options.gid} --groups=${groups} -- env -i ${quote(executable)} --env-file=${quote(envFile)} ${rest.map(quote).join(" ")}`,
  ].join("\n");
  // The outer shell reports its pid, then becomes unshare: that pid is the
  // namespace's parent, whose death takes the whole namespace with it.
  const child = spawn(
    "sudo",
    [
      "-n",
      "sh",
      "-c",
      'echo "crash-point-namespace-parent=$$" >&2; exec unshare --mount --pid --fork --kill-child=SIGKILL --mount-proc --propagation private sh -c "$1"',
      "sh",
      inner,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  let stdout = "";
  let stderr = "";
  let parent = 0;
  const startedSignal = Promise.withResolvers<void>();
  // The live log survives a run the test runner kills before cleanup.
  const liveLog = join(options.workDir, `${options.name}.log`);
  const append = (chunk: string) => {
    output += chunk;
    if (output.length > 512 * 1024) output = output.slice(-256 * 1024);
    try {
      appendFileSync(liveLog, chunk);
    } catch {
      // Output that arrives after the host directory is gone is not kept.
    }
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    append(chunk.toString("utf8"));
    if (stdout.length < 64 * 1024 * 1024) stdout += chunk.toString("utf8");
  });
  let pending = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    let text = chunk.toString("utf8");
    if (!parent) {
      // The first stderr line is the namespace parent's pid, not the process's output.
      pending += text;
      const match = /^crash-point-namespace-parent=(\d+)\n/.exec(pending);
      if (!match) return;
      parent = Number(match[1]);
      startedSignal.resolve();
      text = pending.slice(match[0].length);
    }
    append(text);
    if (stderr.length < 1024 * 1024) stderr += text;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      startedSignal.resolve();
      if (!parent && pending) append(pending);
      resolve({ code, signal });
    });
  });
  const started = startedSignal.promise;
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  return {
    exited,
    started,
    output: () => output,
    stdout: () => stdout,
    stderr: () => stderr,
    kill(signal = "SIGKILL") {
      if (!parent || ended) return;
      // The namespace's first process is unshare's only child. Its parent-death
      // signal does not survive the change of user, so it is signalled itself:
      // when it dies, the kernel ends every process of its PID namespace.
      const first = spawnSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
        .stdout.trim()
        .split("\n")[0];
      if (first)
        spawnSync("sudo", ["-n", "kill", signal === "SIGKILL" ? "-KILL" : "-TERM", first], {
          stdio: "ignore",
        });
      else if (signal === "SIGKILL")
        spawnSync("sudo", ["-n", "kill", "-KILL", String(parent)], { stdio: "ignore" });
    },
  };
}
