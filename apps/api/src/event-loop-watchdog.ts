import inspector from "node:inspector";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { describeThrown, type Logger } from "@openmapx/integration-framework";
import { BOOT_MARKER_FILE } from "./safe-mode";

const DEFAULT_THRESHOLD_MS = 30_000;
const MINIMUM_THRESHOLD_MS = 5_000;
const HEARTBEAT_MS = 1_000;

/**
 * The threshold from the first installed import until the API listens. The
 * longest legitimate stretch in that phase (one bundle scan, the evaluation
 * of a large built-in bundle, a garbage collection) takes a few seconds on
 * slow hardware, and three killed starts of a minute each still fall within
 * the ten minutes in which automatic safe mode counts them.
 */
export const STARTUP_EVENT_LOOP_WATCHDOG_MS = 60_000;

/** Slots of the buffer the two threads share. */
const HEARTBEATS = 0;
/** 1 while a debugger is attached: a paused main thread is not a blocked one. */
const DEBUGGER = 1;
/** 1 once the watchdog was stopped; the worker checks it again right before it kills. */
const STOPPED = 2;
/** The threshold in milliseconds, which the main thread may change while the worker runs. */
const THRESHOLD = 3;
const SLOTS = 4;

/** The layout of the shared buffer, for tests that drive the worker directly. */
export const WATCHDOG_SLOTS = { HEARTBEATS, DEBUGGER, STOPPED, THRESHOLD, count: SLOTS } as const;

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

/** The start-up threshold for a run-time one: a minute, or the run-time one when larger. */
export function startupEventLoopWatchdogThresholdMs(runtimeMs: number | null): number | null {
  return runtimeMs === null ? null : Math.max(STARTUP_EVENT_LOOP_WATCHDOG_MS, runtimeMs);
}

/**
 * Runs in the worker. It counts a stretch as blocked only while its own ticks
 * arrive on time: a tick that comes much later than asked means this thread
 * did not run either (the host was suspended, the process stopped or starved
 * of CPU), so the measurement starts again instead of mistaking the jump for
 * a frozen loop.
 */
const WORKER_SOURCE = `
const { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const { buffer, markerPath, heartbeatMs } = workerData;
const shared = new Int32Array(buffer);
const lateTickMs = heartbeatMs * 3;
let lastSeen = Atomics.load(shared, ${HEARTBEATS});
let lastTick = performance.now();
let blockedMs = 0;

function recordInMarker() {
  if (markerPath === null) return;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker === null || typeof marker !== "object" || Array.isArray(marker)) return;
    const current = marker.current;
    const integrationId =
      current && typeof current === "object" && typeof current.integrationId === "string"
        ? current.integrationId
        : null;
    marker.lastFatal = { integrationId, at: new Date().toISOString() };
    // Like writeFileDurably in safe-mode.ts, under its own name; the main
    // thread is blocked, and SIGKILL follows before a directory flush matters.
    const temporary = markerPath + "." + process.pid + ".watchdog.tmp";
    rmSync(temporary, { force: true });
    const fd = openSync(temporary, "wx", 0o600);
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
  if (blockedMs < Atomics.load(shared, ${THRESHOLD}) || Atomics.load(shared, ${STOPPED}) === 1) return;
  recordInMarker();
  try {
    // The main thread is blocked, so only a direct write reaches stderr.
    writeSync(2, "event loop blocked for " + Math.round(blockedMs) + " ms; exiting\\n");
  } catch {
    // A closed or full stderr must not end this thread before the kill.
  }
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
 *
 * A process has one watchdog: a second start while one runs returns the
 * running one, which `setThreshold` moves from the start-up threshold to the
 * run-time one.
 */
export interface EventLoopWatchdog {
  stop(): void;
  setThreshold(ms: number): void;
}

let active: EventLoopWatchdog | null = null;

export function startEventLoopWatchdog(options: {
  thresholdMs: number;
  /** Where the boot marker is, or null when this process records none: it still kills. */
  runtimeDir: string | null;
  log: Pick<Logger, "error" | "warn">;
  pid?: number;
  /** For tests, which scale thresholds and blocks down with it; the API keeps the default. */
  heartbeatMs?: number;
}): EventLoopWatchdog | null {
  if (active) return active;
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
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOTS);
  const shared = new Int32Array(buffer);
  Atomics.store(shared, THRESHOLD, Math.round(options.thresholdMs));
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const heartbeat = setInterval(() => {
    Atomics.add(shared, HEARTBEATS, 1);
    Atomics.store(shared, DEBUGGER, inspector.url() === undefined ? 0 : 1);
  }, heartbeatMs);
  heartbeat.unref();
  const worker = startWatchdogWorker(buffer, options.runtimeDir, heartbeatMs);
  worker.on("error", (error: unknown) => {
    options.log.error(`event-loop watchdog stopped: ${describeThrown(error)}`);
  });
  let stopped = false;
  const watchdog: EventLoopWatchdog = {
    stop() {
      if (stopped) return;
      stopped = true;
      if (active === watchdog) active = null;
      Atomics.store(shared, STOPPED, 1);
      clearInterval(heartbeat);
      void worker.terminate();
    },
    setThreshold(ms) {
      // The heartbeat first: a stretch that just ended may already exceed the
      // lower threshold, and the worker must start counting afresh before it
      // compares against it.
      Atomics.add(shared, HEARTBEATS, 1);
      Atomics.store(shared, THRESHOLD, Math.round(ms));
    },
  };
  active = watchdog;
  return watchdog;
}

/**
 * The watchdog's thread on `buffer`, laid out as `WATCHDOG_SLOTS`, ticking
 * every `heartbeatMs`. It does not keep the process alive.
 */
export function startWatchdogWorker(
  buffer: SharedArrayBuffer,
  runtimeDir: string | null,
  heartbeatMs = HEARTBEAT_MS,
): Worker {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      buffer,
      markerPath: runtimeDir === null ? null : join(runtimeDir, BOOT_MARKER_FILE),
      heartbeatMs,
    },
  });
  worker.unref();
  return worker;
}

/** Stops the process's watchdog, if one runs; a stop request must never end in its kill. */
export function stopEventLoopWatchdog(): void {
  active?.stop();
}
