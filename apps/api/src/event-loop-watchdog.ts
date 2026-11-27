import inspector from "node:inspector";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describeThrown, type Logger } from "@openmapx/integration-framework";
import { BOOT_MARKER_FILE } from "./safe-mode";

const DEFAULT_THRESHOLD_MS = 30_000;
const MINIMUM_THRESHOLD_MS = 5_000;
const HEARTBEAT_MS = 1_000;

/** Slots of the buffer the two threads share. */
const HEARTBEATS = 0;
/** 1 while a debugger is attached: a paused main thread is not a blocked one. */
const DEBUGGER = 1;
/** 1 once the watchdog was stopped; the worker checks it again right before it kills. */
const STOPPED = 2;

/**
 * The threshold `OPENMAPX_EVENT_LOOP_WATCHDOG_MS` asks for, or null when the
 * watchdog is off. Unset or unreadable means 30 seconds, `0` turns it off, and
 * less than 5 seconds is raised to 5 seconds, so a garbage collection or the
 * scan of a large extension bundle never counts as a frozen loop. Under the
 * test runner it is off unless set: the runner's own threads share the
 * process, and a kill would take the whole run down.
 */
export function eventLoopWatchdogThresholdMs(
  env: Record<string, string | undefined> = process.env,
): number | null {
  const value = env.OPENMAPX_EVENT_LOOP_WATCHDOG_MS?.trim();
  if (!value) return env.VITEST ? null : DEFAULT_THRESHOLD_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_THRESHOLD_MS;
  if (parsed === 0) return null;
  return Math.max(MINIMUM_THRESHOLD_MS, Math.round(parsed));
}

/**
 * Runs in the worker. It counts a stretch as blocked only while its own ticks
 * arrive on time: a tick that comes much later than asked means this thread
 * did not run either (the host was suspended, the process stopped or starved
 * of CPU), so the measurement starts again instead of mistaking the jump for
 * a frozen loop.
 */
const WORKER_SOURCE = `
const { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { buffer, thresholdMs, markerPath, heartbeatMs } = workerData;
const shared = new Int32Array(buffer);
const lateTickMs = heartbeatMs * 3;
let lastSeen = Atomics.load(shared, ${HEARTBEATS});
let lastTick = performance.now();
let blockedMs = 0;

function recordInMarker() {
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return;
    const current = marker.current;
    const integrationId =
      current && typeof current === "object" && typeof current.integrationId === "string"
        ? current.integrationId
        : null;
    marker.lastFatal = { integrationId, at: new Date().toISOString() };
    const temporary = markerPath + "." + process.pid + ".watchdog.tmp";
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(marker, null, 2) + "\\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, markerPath);
  } catch {
    // The kill matters more than the attribution.
  }
}

setInterval(() => {
  const now = performance.now();
  const elapsed = now - lastTick;
  lastTick = now;
  const seen = Atomics.load(shared, ${HEARTBEATS});
  if (seen !== lastSeen || elapsed > lateTickMs || Atomics.load(shared, ${DEBUGGER}) === 1) {
    lastSeen = seen;
    blockedMs = 0;
    return;
  }
  blockedMs += elapsed;
  if (blockedMs < thresholdMs || Atomics.load(shared, ${STOPPED}) === 1) return;
  recordInMarker();
  // The main thread is blocked, so only a direct write reaches stderr.
  writeSync(2, "event loop blocked for " + Math.round(blockedMs) + " ms; exiting\\n");
  if (Atomics.load(shared, ${STOPPED}) === 1) return;
  // process.exit here would end only this thread.
  process.kill(process.pid, "SIGKILL");
}, heartbeatMs);
`;

/**
 * Ends the process with SIGKILL when its event loop has not turned for
 * `thresholdMs`, after recording in the boot marker which installed
 * integration was loading. A loop frozen by an integration otherwise leaves
 * the API up but unanswering, so it never restarts and never counts towards
 * automatic safe mode. The main thread only bumps a shared counter; a worker
 * thread watches it, because a blocked main thread cannot watch itself.
 *
 * A SIGKILL from inside a PID namespace does not reach its init, so the
 * watchdog refuses to start as PID 1 (the image starts Node under tini). It
 * also stays off while a debugger is attached, which pauses the loop on
 * purpose.
 */
export function startEventLoopWatchdog(options: {
  thresholdMs: number;
  runtimeDir: string;
  log: Pick<Logger, "error" | "warn">;
  pid?: number;
}): { stop(): void } | null {
  if (!(options.thresholdMs > 0)) return null;
  if ((options.pid ?? process.pid) === 1) {
    options.log.error(
      "event-loop watchdog not started: the process is PID 1 and cannot kill itself",
    );
    return null;
  }
  if (inspector.url() !== undefined) {
    options.log.warn("event-loop watchdog not started: a debugger may pause the event loop");
    return null;
  }
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3);
  const shared = new Int32Array(buffer);
  const heartbeat = setInterval(() => {
    Atomics.add(shared, HEARTBEATS, 1);
    Atomics.store(shared, DEBUGGER, inspector.url() === undefined ? 0 : 1);
  }, HEARTBEAT_MS);
  heartbeat.unref();
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      buffer,
      thresholdMs: options.thresholdMs,
      markerPath: join(options.runtimeDir, BOOT_MARKER_FILE),
      heartbeatMs: HEARTBEAT_MS,
    },
  });
  worker.unref();
  worker.on("error", (error: unknown) => {
    options.log.error(`event-loop watchdog stopped: ${describeThrown(error)}`);
  });
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      Atomics.store(shared, STOPPED, 1);
      clearInterval(heartbeat);
      void worker.terminate();
    },
  };
}
