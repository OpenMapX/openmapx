import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  OPS_MAX_EVENT_MESSAGE_BYTES,
  OPS_MAX_FOLLOW_LOG_EVENTS,
  type OpsResultFor,
} from "@openmapx/core/ops";
import { assertPosixProcessGroupsSupported, monitorPosixProcessGroup } from "@openmapx/core/server";
import { createUnavailableRuntime, type OpsRuntime } from "./runtime";

const DEFAULT_TIMEOUT_MS = 120_000;
const PULL_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;

function truncateUtf8(value: string, maxBytes = OPS_MAX_EVENT_MESSAGE_BYTES): string {
  let bytes = 0;
  let bounded = "";
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maxBytes) break;
    bounded += character;
    bytes += size;
  }
  return bounded;
}

type ExecFile = (
  file: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

interface FollowLogsOptions {
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  onLine(stream: "stdout" | "stderr", message: string): void;
}

type FollowLogs = (
  file: string,
  args: readonly string[],
  options: FollowLogsOptions,
) => Promise<OpsResultFor<"service.logs.follow">>;

export interface DockerRuntimeOptions {
  composeFile: string;
  releaseComposeFile: string;
  releaseComposeExists: (path: string) => boolean;
  execFile?: ExecFile;
  followLogs?: FollowLogs;
  /**
   * Owner of the shared `/data` mount. Artifacts a container writes as root
   * are handed to this owner so the data-owning writer is not locked out.
   */
  dataMountOwner?: { uid: number; gid: number };
}

export interface ContainedProcessOptions {
  signal: AbortSignal;
  timeout: number;
  maxBuffer: number;
  killGraceMs?: number;
}

// The agent runs as the data-owning user, so its own identity is the default
// owner for artifacts produced inside a container on the shared mount.
const defaultDataMountOwner = {
  uid: process.getuid?.() ?? 1000,
  gid: process.getgid?.() ?? 1000,
};

const POSTGIS_DATA_MOUNT = "/var/lib/postgresql";
const FEED_PROXY_CONTAINER = "motis-feed-proxy";
// Valhalla's fixed identities. `/custom_files` is the shared OSM producer mount,
// so the artifacts these commands write are readable by data-manager directly —
// it never needs to stream a file back out through Docker.
const VALHALLA_CONTAINER = "docker-valhalla-1";
const VALHALLA_CONFIG_PATH = "/custom_files/valhalla.json";
const VALHALLA_TRAFFIC_TAR = "/custom_files/traffic.tar";
const VALHALLA_TILE_DIR = "/custom_files/valhalla_tiles";
// data-manager writes the per-tile CSVs here through the same shared mount.
const VALHALLA_PREDICTED_CSV_DIR = "/custom_files/predicted-csv";

/**
 * Available bytes from `df -Pk`. The agent parses this itself so the caller
 * never supplies a path or reads raw process output.
 */
export function parsePosixDfAvailableBytes(output: string): number {
  const lines = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const fields = lines.at(-1)?.split(/\s+/) ?? [];
  const availableBlocks = Number(fields[3]);
  if (!Number.isSafeInteger(availableBlocks) || availableBlocks < 0) {
    throw new Error("Could not parse available filesystem blocks from df -Pk");
  }
  const availableBytes = availableBlocks * 1024;
  if (!Number.isSafeInteger(availableBytes)) {
    throw new Error("Filesystem capacity exceeds JavaScript's safe integer range");
  }
  return availableBytes;
}

export function runContainedProcess(
  file: string,
  args: readonly string[],
  options: ContainedProcessOptions,
): Promise<{ stdout: string; stderr: string }> {
  assertPosixProcessGroupsSupported();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = monitorPosixProcessGroup(child, {
      killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let failed = false;

    const terminate = () => {
      if (failed) return;
      failed = true;
      group.terminate();
    };
    const onData = (target: Buffer[]) => (chunk: Buffer | string) => {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > options.maxBuffer) {
        terminate();
        return;
      }
      target.push(value);
    };
    const onAbort = () => terminate();
    const timeout = setTimeout(terminate, options.timeout);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) terminate();
    child.stdout.on("data", onData(stdout));
    child.stderr.on("data", onData(stderr));
    child.once("error", () => {
      failed = true;
    });
    void group.closed.then((exit) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      if (
        failed ||
        exit.spawnFailed ||
        exit.residualDescendants ||
        exit.containmentFailed ||
        exit.code !== 0 ||
        exit.signal !== null
      ) {
        reject(new Error("Contained process failed"));
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

export function runContainedLogProcess(
  file: string,
  args: readonly string[],
  options: FollowLogsOptions,
): Promise<OpsResultFor<"service.logs.follow">> {
  assertPosixProcessGroupsSupported();
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const group = monitorPosixProcessGroup(child, { killGraceMs: KILL_GRACE_MS });
    let bytes = 0;
    let lines = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let callbackFailed = false;
    let spawnFailed = false;
    let selfLimitTerminated = false;
    let terminating = false;
    const pending = { stdout: "", stderr: "" };
    const decoders = {
      stdout: new StringDecoder("utf8"),
      stderr: new StringDecoder("utf8"),
    };

    const terminate = () => {
      if (terminating) return;
      terminating = true;
      group.terminate();
    };
    const emit = (stream: "stdout" | "stderr", message: string) => {
      if (lines >= OPS_MAX_FOLLOW_LOG_EVENTS) {
        truncated = true;
        selfLimitTerminated = true;
        terminate();
        return;
      }
      const bounded = truncateUtf8(message);
      if (bounded !== message) truncated = true;
      try {
        options.onLine(stream, bounded);
      } catch {
        callbackFailed = true;
        terminate();
        return;
      }
      lines += 1;
    };
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const value = Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > options.maxBuffer) {
        truncated = true;
        selfLimitTerminated = true;
        terminate();
        return;
      }
      pending[stream] += decoders[stream].write(value);
      let consumed = 0;
      while (!selfLimitTerminated && !callbackFailed) {
        const end = pending[stream].indexOf("\n", consumed);
        if (end < 0) break;
        const lineEnd = end > consumed && pending[stream][end - 1] === "\r" ? end - 1 : end;
        emit(stream, pending[stream].slice(consumed, lineEnd));
        consumed = end + 1;
      }
      pending[stream] = selfLimitTerminated ? "" : pending[stream].slice(consumed);
      if (Buffer.byteLength(pending[stream], "utf8") > OPS_MAX_EVENT_MESSAGE_BYTES) {
        emit(stream, pending[stream]);
        pending[stream] = "";
      }
    };
    const onAbort = () => {
      aborted = true;
      terminate();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeout);
    options.signal.addEventListener("abort", onAbort, { once: true });
    if (options.signal.aborted) onAbort();
    child.stdout.on("data", onData("stdout"));
    child.stderr.on("data", onData("stderr"));
    child.once("error", () => {
      spawnFailed = true;
      terminating = true;
    });
    void group.closed.then((exit) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      if (!selfLimitTerminated) {
        for (const stream of ["stdout", "stderr"] as const) {
          pending[stream] += decoders[stream].end();
          if (pending[stream]) emit(stream, pending[stream]);
        }
      }
      const failedWithoutContainedTermination =
        (exit.code !== 0 || exit.signal !== null) && !timedOut && !selfLimitTerminated;
      if (
        aborted ||
        callbackFailed ||
        spawnFailed ||
        exit.spawnFailed ||
        exit.residualDescendants ||
        exit.containmentFailed ||
        failedWithoutContainedTermination
      ) {
        reject(new Error("Contained log process failed"));
        return;
      }
      resolve({ lines, truncated });
    });
  });
}

function parseStackStatus(stdout: string): OpsResultFor<"stack.status"> {
  if (!stdout.trim()) return { services: [] };
  try {
    const parsed = JSON.parse(stdout) as unknown;
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return {
      services: values.slice(0, 256).map((value) => {
        const item = value as Record<string, unknown>;
        const rawState = String(item.State ?? "unknown").toLowerCase();
        const state = ["running", "stopped", "created", "restarting", "paused"].includes(rawState)
          ? (rawState as "running" | "stopped" | "created" | "restarting" | "paused")
          : "unknown";
        return { serviceId: String(item.Service ?? item.Name ?? "unknown"), state };
      }),
    };
  } catch {
    throw new Error("Contained process failed");
  }
}

export function createDockerRuntime(options: DockerRuntimeOptions): OpsRuntime {
  const execFile: ExecFile =
    options.execFile ??
    ((file, args, execOptions) =>
      runContainedProcess(file, args, { ...execOptions, killGraceMs: KILL_GRACE_MS }));
  const composePrefix = (): string[] => [
    "compose",
    "-f",
    options.composeFile,
    ...(options.releaseComposeExists(options.releaseComposeFile)
      ? ["-f", options.releaseComposeFile]
      : []),
  ];
  const run = (args: readonly string[], signal: AbortSignal, timeout = DEFAULT_TIMEOUT_MS) =>
    execFile("docker", args, { signal, timeout, maxBuffer: MAX_OUTPUT_BYTES });
  const changed = async (args: readonly string[], signal: AbortSignal, timeout?: number) => {
    await run(args, signal, timeout);
    return { changed: true } as const;
  };
  const runtime = createUnavailableRuntime();
  const followLogs: FollowLogs = options.followLogs ?? runContainedLogProcess;

  runtime["docker.status"] = async (_operation, context) => {
    const result = await run(["info", "--format", "{{.ServerVersion}}"], context.signal, 5_000);
    return { reachable: true, version: result.stdout.trim() };
  };
  runtime["stack.status"] = async (_operation, context) => {
    const result = await run([...composePrefix(), "ps", "--format", "json"], context.signal);
    return parseStackStatus(result.stdout);
  };
  runtime["stack.start"] = (_operation, context) =>
    changed([...composePrefix(), "up", "-d"], context.signal);
  runtime["service.start"] = (operation, context) =>
    changed([...composePrefix(), "up", "-d", operation.serviceId], context.signal);
  runtime["service.stop"] = (operation, context) =>
    changed([...composePrefix(), "stop", operation.serviceId], context.signal);
  runtime["service.restart"] = (operation, context) =>
    changed([...composePrefix(), "restart", operation.serviceId], context.signal);
  runtime["service.recreate"] = (operation, context) =>
    changed(
      [...composePrefix(), "up", "-d", "--force-recreate", operation.serviceId],
      context.signal,
    );
  runtime["service.recreateIsolated"] = (operation, context) =>
    changed(
      [...composePrefix(), "up", "-d", "--force-recreate", "--no-deps", operation.serviceId],
      context.signal,
    );
  runtime["service.pull"] = (operation, context) =>
    changed([...composePrefix(), "pull", operation.serviceId], context.signal, PULL_TIMEOUT_MS);
  runtime["service.remove"] = (operation, context) =>
    changed([...composePrefix(), "rm", "-sf", operation.serviceId], context.signal);
  runtime["service.logs"] = async (operation, context) => {
    const result = await run(
      [...composePrefix(), "logs", "--no-color", `--tail=${operation.tail}`, operation.serviceId],
      context.signal,
    );
    const rawLines = result.stdout.split(/\r?\n/).filter(Boolean);
    const selected = rawLines.slice(0, operation.tail);
    const lines = selected.map((line) => truncateUtf8(line));
    return {
      lines,
      truncated:
        rawLines.length > operation.tail || lines.some((line, index) => line !== selected[index]),
    };
  };
  runtime["service.logs.follow"] = (operation, context) =>
    followLogs(
      "docker",
      [
        ...composePrefix(),
        "logs",
        "-f",
        "--no-color",
        `--tail=${operation.tail}`,
        operation.serviceId,
      ],
      {
        signal: context.signal,
        timeout: operation.maxDurationSeconds * 1_000,
        maxBuffer: MAX_OUTPUT_BYTES,
        onLine: context.emitLog,
      },
    );
  runtime["dawarich.provisioning.inspect"] = async (_operation, context) => {
    const statusResult = await run([...composePrefix(), "ps", "--format", "json"], context.signal);
    const status = parseStackStatus(statusResult.stdout);
    const serviceIds = [
      "dawarich-app",
      "dawarich-sidekiq",
      "dawarich-postgis",
      "dawarich-redis",
    ] as const;
    const services = serviceIds.map((serviceId) => ({
      serviceId,
      state: status.services.find((service) => service.serviceId === serviceId)?.state ?? "stopped",
    })) as OpsResultFor<"dawarich.provisioning.inspect">["services"];
    const generation = async (serviceId: "dawarich-app" | "dawarich-sidekiq") => {
      if (services.find((service) => service.serviceId === serviceId)?.state !== "running") {
        return null;
      }
      try {
        const result = await run(
          [
            ...composePrefix(),
            "exec",
            "-T",
            serviceId,
            "printenv",
            "OPENMAPX_PROVISIONING_GENERATION",
          ],
          context.signal,
          15_000,
        );
        const value = result.stdout.trim();
        return /^[0-9a-f]{32}$/.test(value) ? value : null;
      } catch {
        return null;
      }
    };
    return {
      services,
      appliedGenerations: {
        app: await generation("dawarich-app"),
        worker: await generation("dawarich-sidekiq"),
      },
    };
  };
  // Agent-owned fixed targets. The caller names an operation, never a
  // container, path, or argv.
  runtime["postgis.capacity.inspect"] = async (_operation, context) => {
    const result = await run(
      ["exec", "postgis", "df", "-Pk", POSTGIS_DATA_MOUNT],
      context.signal,
      15_000,
    );
    return { availableBytes: parsePosixDfAvailableBytes(result.stdout) };
  };
  runtime["feedProxy.validateAndReload"] = async (operation, context) => {
    // Validate before reloading: a reload against a bad configuration would
    // take the proxy down rather than reject the candidate.
    await run(["exec", FEED_PROXY_CONTAINER, "nginx", "-t"], context.signal, 30_000);
    await run(["exec", FEED_PROXY_CONTAINER, "nginx", "-s", "reload"], context.signal, 30_000);
    return { candidateId: operation.candidateId, reloaded: true as const };
  };
  // Valhalla traffic effects. The whole sequence lives here because each step
  // is host authority; data-manager names the operation and nothing else.
  const valhallaExec = async (args: readonly string[], signal: AbortSignal, timeout?: number) => {
    try {
      const result = await run(["exec", VALHALLA_CONTAINER, ...args], signal, timeout);
      return { exitCode: 0, stdout: result.stdout };
    } catch (error) {
      return { exitCode: 1, stdout: "", error };
    }
  };
  const valhallaMtimeSeconds = async (path: string, signal: AbortSignal) => {
    const result = await valhallaExec(["stat", "-c", "%Y", path], signal, 15_000);
    if (result.exitCode !== 0) return null;
    const seconds = Number(result.stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  };

  runtime["valhalla.traffic.inspect"] = async (_operation, context) => {
    const [tileMtime, tarMtime] = await Promise.all([
      valhallaMtimeSeconds(VALHALLA_TILE_DIR, context.signal),
      valhallaMtimeSeconds(VALHALLA_TRAFFIC_TAR, context.signal),
    ]);
    // No extract at all, or tiles newer than the extract, means a rebuild is
    // owed. An unreadable tile dir with a present extract is inconclusive.
    if (tarMtime === null) return { state: "not_ready" as const };
    if (tileMtime === null) return { state: "unknown" as const };
    return { state: tileMtime > tarMtime ? ("not_ready" as const) : ("ready" as const) };
  };

  runtime["valhalla.traffic.rebuild"] = async (_operation, context) => {
    // `-t/--with-traffic` writes the traffic.tar skeleton the live writer mmaps;
    // `-O/--overwrite` is required because a rebuild runs with the tar present.
    const build = await valhallaExec(
      ["valhalla_build_extract", "-c", VALHALLA_CONFIG_PATH, "-t", "-O"],
      context.signal,
    );
    if (build.exitCode !== 0) {
      // Never restart or claim success on a failed build: that would mask the
      // failure and bounce Valhalla for nothing.
      throw new Error("valhalla_build_extract failed");
    }
    // A successful-but-degenerate rebuild (empty tile_dir) exits 0 yet produces
    // an extract with no tiles, which silently disables all live traffic.
    // index.bin holds one 16-byte entry per tile, so an empty index.bin is fatal.
    const probe = await valhallaExec(
      ["sh", "-c", `tar xOf ${VALHALLA_TRAFFIC_TAR} index.bin 2>/dev/null | wc -c`],
      context.signal,
      60_000,
    );
    const indexBytesRaw = probe.stdout.trim();
    const indexBytes = Number(indexBytesRaw);
    if (
      probe.exitCode === 0 &&
      indexBytesRaw !== "" &&
      Number.isFinite(indexBytes) &&
      indexBytes === 0
    ) {
      throw new Error("valhalla traffic extract has an empty index");
    }
    // The build runs as the container's root user, but the live-speed writer
    // opens the same file for in-place mmap writes as the data owner. Hand it
    // to the owner of the shared data mount so the writer is not locked out.
    const owner = options.dataMountOwner ?? defaultDataMountOwner;
    const chown = await valhallaExec(
      ["chown", `${owner.uid}:${owner.gid}`, VALHALLA_TRAFFIC_TAR],
      context.signal,
    );
    if (chown.exitCode !== 0) throw new Error("valhalla traffic extract chown failed");
    await run(["restart", VALHALLA_CONTAINER], context.signal);
    return { changed: true };
  };

  runtime["valhalla.traffic.refreshWaysToEdges"] = async (_operation, context) => {
    // Writes `<tile_dir>/way_edges.txt`, a hard-coded name with no output flag.
    // data-manager reads and filters it from the shared mount afterwards.
    const build = await valhallaExec(
      ["valhalla_ways_to_edges", "-c", VALHALLA_CONFIG_PATH],
      context.signal,
    );
    if (build.exitCode !== 0) throw new Error("valhalla_ways_to_edges failed");
    const owner = options.dataMountOwner ?? defaultDataMountOwner;
    await valhallaExec(
      ["chown", `${owner.uid}:${owner.gid}`, `${VALHALLA_TILE_DIR}/way_edges.txt`],
      context.signal,
    );
    return { changed: true };
  };

  runtime["valhalla.traffic.applyPredicted"] = async (_operation, context) => {
    // data-manager has already written the per-tile CSVs to the shared mount;
    // running the baker against them is the only host-authority step.
    const bake = await valhallaExec(
      ["valhalla_add_predicted_traffic", "-c", VALHALLA_CONFIG_PATH, VALHALLA_PREDICTED_CSV_DIR],
      context.signal,
    );
    if (bake.exitCode !== 0) throw new Error("valhalla_add_predicted_traffic failed");
    return { changed: true };
  };

  runtime["motis.staging.restart"] = (_operation, context) =>
    changed(["restart", "motis-staging"], context.signal);
  runtime["motis.staging.stop"] = (_operation, context) =>
    changed(["stop", "motis-staging"], context.signal);
  runtime["motis.primary.restart"] = (_operation, context) =>
    changed(["restart", "motis"], context.signal);
  runtime["motis.primary.promote"] = async (operation, context) => {
    // Recreate rather than restart: Docker resolves a bind-mount symlink when
    // the container is created, so a plain restart can keep pointing at the old
    // A/B target. `--no-deps` stops Compose from cascading into the feed proxy
    // and recreating MOTIS a second time, which would race the caller's
    // post-swap health probe.
    await run(
      [...composePrefix(), "up", "-d", "--force-recreate", "--no-deps", "motis"],
      context.signal,
      10 * 60_000,
    );
    // The caller performed the data swap; the agent reports the run it activated.
    return { activeRunId: operation.preparedRunId };
  };
  runtime["motis.primary.stop"] = (_operation, context) =>
    changed(["stop", "motis"], context.signal);
  return runtime;
}
