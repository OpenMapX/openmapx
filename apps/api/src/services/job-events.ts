/**
 * In-process fan-out of admin job events for the SSE route.
 *
 * The database stays the durable store; this bus only gives live viewers a
 * cursor-ordered stream with a bounded replay window. A cursor older than the
 * ring, an unknown job, or a process restart all resolve to "expired", and the
 * route answers that with a fresh snapshot from the database.
 */

/** Fields left undefined were not touched by the transition; viewers keep their value. */
export interface JobStatusEvent {
  type: "status";
  status: string;
  progress?: number | null;
  error?: string | null;
  result?: Record<string, unknown> | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface JobProgressEvent {
  type: "progress";
  progress: number;
}

export interface JobLogEvent {
  type: "log";
  id: string;
  seq: number;
  stream: string;
  line: string;
  createdAt: string;
}

export type JobEvent = JobStatusEvent | JobProgressEvent | JobLogEvent;

export interface StoredJobEvent {
  cursor: number;
  event: JobEvent;
}

export interface JobStreamMetrics {
  activeStreams: number;
  reconnects: number;
  backfilledEvents: number;
  snapshotFallbacks: number;
  droppedEvents: number;
  publishedEvents: number;
  handlerDurations: { count: number; totalMs: number; maxMs: number };
}

export const TERMINAL_JOB_STATUSES: ReadonlySet<string> = new Set([
  "success",
  "failed",
  "canceled",
]);

type Listener = (stored: StoredJobEvent) => void;

interface JobState {
  nextCursor: number;
  ring: StoredJobEvent[];
  listeners: Set<Listener>;
  dropTimer: NodeJS.Timeout | null;
}

export interface JobEventBusOptions {
  /** Events retained per job for reconnect backfill. */
  ringSize?: number;
  /** How long a finished job stays replayable. */
  terminalRetentionMs?: number;
}

const DEFAULT_RING_SIZE = 1_000;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60_000;

export class JobEventBus {
  private readonly jobs = new Map<string, JobState>();
  private readonly ringSize: number;
  private readonly terminalRetentionMs: number;
  readonly metrics: JobStreamMetrics = {
    activeStreams: 0,
    reconnects: 0,
    backfilledEvents: 0,
    snapshotFallbacks: 0,
    droppedEvents: 0,
    publishedEvents: 0,
    handlerDurations: { count: 0, totalMs: 0, maxMs: 0 },
  };

  constructor(options: JobEventBusOptions = {}) {
    this.ringSize = options.ringSize ?? DEFAULT_RING_SIZE;
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
  }

  private state(jobId: string): JobState {
    let state = this.jobs.get(jobId);
    if (!state) {
      state = { nextCursor: 1, ring: [], listeners: new Set(), dropTimer: null };
      this.jobs.set(jobId, state);
    }
    return state;
  }

  publish(jobId: string, event: JobEvent): StoredJobEvent {
    const state = this.state(jobId);
    const stored: StoredJobEvent = { cursor: state.nextCursor, event };
    state.nextCursor += 1;
    state.ring.push(stored);
    if (state.ring.length > this.ringSize) state.ring.shift();
    this.metrics.publishedEvents += 1;
    for (const listener of state.listeners) {
      try {
        listener(stored);
      } catch {
        // A failing listener must not break delivery to the others.
      }
    }
    return stored;
  }

  /** Events after `afterCursor`, or `null` when they are no longer replayable. */
  history(jobId: string, afterCursor: number): StoredJobEvent[] | null {
    const state = this.jobs.get(jobId);
    if (!state) return null;
    const latest = state.nextCursor - 1;
    // A cursor this process never issued (typically one from before a
    // restart) cannot be trusted as a position in the current sequence.
    if (afterCursor > latest) return null;
    const oldest = state.ring[0];
    // Cursor 0 with an empty ring means "from the start" of a job that has
    // not emitted anything yet; anything else older than the ring is expired.
    if (oldest ? afterCursor < oldest.cursor - 1 : afterCursor < latest) return null;
    return state.ring.filter((stored) => stored.cursor > afterCursor);
  }

  latestCursor(jobId: string): number {
    const state = this.jobs.get(jobId);
    return state ? state.nextCursor - 1 : 0;
  }

  subscribe(jobId: string, listener: Listener): () => void {
    const state = this.state(jobId);
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  /** Keeps a finished job replayable for the retention window, then forgets it. */
  markTerminal(jobId: string): void {
    const state = this.jobs.get(jobId);
    if (!state || state.dropTimer) return;
    state.dropTimer = setTimeout(() => {
      this.jobs.delete(jobId);
    }, this.terminalRetentionMs);
    state.dropTimer.unref?.();
  }

  recordHandlerDuration(durationMs: number): void {
    const stats = this.metrics.handlerDurations;
    stats.count += 1;
    stats.totalMs += durationMs;
    if (durationMs > stats.maxMs) stats.maxMs = durationMs;
  }
}

export const jobEventBus = new JobEventBus();
