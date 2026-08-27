export interface PosixProcessGroupChild {
  readonly pid?: number;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface PosixProcessGroupExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  spawnFailed: boolean;
  residualDescendants: boolean;
  containmentFailed: boolean;
}

export interface PosixProcessGroupLifecycle {
  readonly closed: Promise<PosixProcessGroupExit>;
  terminate(): void;
}

interface MonitorOptions {
  killGraceMs: number;
  pollIntervalMs?: number;
}

type GroupSignalResult = "sent" | "missing" | "failed";

function groupSignal(pid: number, signal: NodeJS.Signals | 0): GroupSignalResult {
  try {
    process.kill(-pid, signal);
    return "sent";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "missing" : "failed";
  }
}

function groupExists(pid: number): boolean {
  return groupSignal(pid, 0) !== "missing";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function assertPosixProcessGroupsSupported(): void {
  if (process.platform === "win32") {
    throw new Error("POSIX process-group containment is unavailable");
  }
}

/**
 * Owns only lifecycle containment for a child already spawned with
 * `detached: true`. It never accepts a command or argv. Settlement waits for
 * both the direct child's close event and disappearance of the complete POSIX
 * process group. If KILL cannot remove the group, the promise deliberately
 * remains pending so the caller cannot release authority capacity early.
 */
export function monitorPosixProcessGroup(
  child: PosixProcessGroupChild,
  options: MonitorOptions,
): PosixProcessGroupLifecycle {
  assertPosixProcessGroupsSupported();
  if (!Number.isInteger(options.killGraceMs) || options.killGraceMs < 1) {
    throw new Error("Invalid process-group kill grace");
  }
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1_000) {
    throw new Error("Invalid process-group poll interval");
  }

  const pid = child.pid;
  let spawnFailed = false;
  let terminationRequested = false;
  let residualDescendants = false;
  let containmentFailed = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const send = (signal: NodeJS.Signals): GroupSignalResult => {
    if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) {
      containmentFailed = true;
      return "failed";
    }
    const result = groupSignal(pid as number, signal);
    if (result === "failed") containmentFailed = true;
    return result;
  };

  const terminate = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    const term = send("SIGTERM");
    if (term === "missing") return;
    killTimer = setTimeout(() => {
      send("SIGKILL");
    }, options.killGraceMs);
  };

  child.once("error", () => {
    spawnFailed = true;
  });

  const closed = new Promise<PosixProcessGroupExit>((resolve) => {
    child.once("close", (code, signal) => {
      void (async () => {
        if (!Number.isSafeInteger(pid) || (pid ?? 0) <= 1) {
          if (!spawnFailed) {
            containmentFailed = true;
            // No trustworthy PGID exists. Never release authority on an
            // otherwise successful-looking close because descendants cannot
            // be proven absent.
            await new Promise<never>(() => undefined);
          }
          resolve({
            code,
            signal,
            spawnFailed,
            residualDescendants: false,
            containmentFailed,
          });
          return;
        }

        if (groupExists(pid as number) && !terminationRequested) {
          residualDescendants = true;
          terminate();
        }
        while (groupExists(pid as number)) {
          await delay(pollIntervalMs);
        }
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve({
          code,
          signal,
          spawnFailed,
          residualDescendants,
          containmentFailed,
        });
      })();
    });
  });

  return { closed, terminate };
}
