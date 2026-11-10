export type WorkRejection = "capacity" | "client-capacity" | "deadline";

const REJECTION_MESSAGES: Record<WorkRejection, string> = {
  capacity: "The server is busy. Try again shortly.",
  "client-capacity": "Too many requests from this network are waiting. Try again shortly.",
  deadline: "The request waited too long to start. Try again shortly.",
};

/** Work was refused before it reached an upstream provider; nothing was attempted. */
export class WorkAdmissionError extends Error {
  readonly reason: WorkRejection;
  readonly retryAfterMs: number;

  constructor(reason: WorkRejection, retryAfterMs: number) {
    super(REJECTION_MESSAGES[reason]);
    this.name = "WorkAdmissionError";
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

export function isWorkAdmissionError(error: unknown): error is WorkAdmissionError {
  return error instanceof WorkAdmissionError;
}

export interface WorkAdmission {
  /** Equal keys share one execution; each caller still holds its own budget unit. */
  key: string;
  /** Network identity charged for this caller's pending unit. */
  client: string;
  /** Absolute time by which the work must have started. Queue time counts toward it. */
  deadlineAt: number;
  /** Caller cancellation. Leaving never affects other callers sharing the same work. */
  signal?: AbortSignal;
}

export interface BoundedWorkQueueOptions {
  /** Executions allowed to run at once. */
  concurrency: number;
  /** Distinct executions allowed to wait for a slot. */
  maxQueued: number;
  /** Callers from one network allowed to wait or run at once. */
  maxPerClient: number;
  /**
   * Abort a running execution once every caller has left. Use this only when
   * the operation honours its signal; otherwise it keeps running, holds its
   * slot and remains joinable by later callers for the same key.
   */
  cancelAbandoned: boolean;
  /** Retry hint attached to admission refusals. */
  retryAfterMs?: number;
}

interface Waiter {
  client: string;
  done: boolean;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  detach: () => void;
}

interface Job {
  key: string;
  deadlineAt: number;
  operation: (signal: AbortSignal, deadlineAt: number) => Promise<unknown>;
  controller: AbortController;
  waiters: Set<Waiter>;
  state: "queued" | "running" | "settled";
  timer?: ReturnType<typeof setTimeout>;
  done: Promise<void>;
  markDone: () => void;
}

/**
 * Bounded admission for expensive in-process work.
 *
 * Budgets are checked before anything is enqueued: a global ceiling on distinct
 * waiting executions and a per-network ceiling on callers. Equal keys coalesce,
 * and each caller can leave independently; queued work is dropped once its
 * last caller leaves, and running work is aborted when `cancelAbandoned` is
 * set. A slot stays occupied until the operation itself settles, so the
 * concurrency ceiling always reflects work actually in flight.
 */
export class BoundedWorkQueue {
  readonly #concurrency: number;
  readonly #maxQueued: number;
  readonly #maxPerClient: number;
  readonly #cancelAbandoned: boolean;
  readonly #retryAfterMs: number;
  readonly #jobs = new Map<string, Job>();
  readonly #queue: Job[] = [];
  readonly #abandoned = new Map<string, Promise<void>>();
  readonly #clients = new Map<string, number>();
  #active = 0;

  constructor(options: BoundedWorkQueueOptions) {
    for (const name of ["concurrency", "maxQueued", "maxPerClient"] as const) {
      const value = options[name];
      if (!Number.isSafeInteger(value) || value < (name === "maxQueued" ? 0 : 1)) {
        throw new Error(
          `${name} must be a ${name === "maxQueued" ? "non-negative" : "positive"} safe integer`,
        );
      }
    }
    this.#concurrency = options.concurrency;
    this.#maxQueued = options.maxQueued;
    this.#maxPerClient = options.maxPerClient;
    this.#cancelAbandoned = options.cancelAbandoned;
    this.#retryAfterMs = options.retryAfterMs ?? 2_000;
  }

  /** Executions holding a slot, including abandoned ones that have not yet settled. */
  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** Callers currently charged to `client`. */
  pendingFor(client: string): number {
    return this.#clients.get(client) ?? 0;
  }

  run<T>(
    admission: WorkAdmission,
    operation: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
  ): Promise<T> {
    const { key, client, deadlineAt, signal } = admission;
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pendingFor(client) >= this.#maxPerClient) {
      return Promise.reject(new WorkAdmissionError("client-capacity", this.#retryAfterMs));
    }
    let job = this.#jobs.get(key);
    let created = false;
    if (!job) {
      if (Date.now() >= deadlineAt) {
        return Promise.reject(new WorkAdmissionError("deadline", this.#retryAfterMs));
      }
      if (this.#active >= this.#concurrency && this.#queue.length >= this.#maxQueued) {
        return Promise.reject(new WorkAdmissionError("capacity", this.#retryAfterMs));
      }
      let markDone = () => {};
      const done = new Promise<void>((resolve) => {
        markDone = resolve;
      });
      job = {
        key,
        deadlineAt,
        operation,
        controller: new AbortController(),
        waiters: new Set(),
        state: "queued",
        done,
        markDone,
      };
      this.#jobs.set(key, job);
      created = true;
    }
    const target = job;
    const promise = new Promise<T>((resolve, reject) => {
      const onAbort = () => this.#leave(target, waiter, signal?.reason);
      const waiter: Waiter = {
        client,
        done: false,
        resolve: resolve as (value: unknown) => void,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      target.waiters.add(waiter);
      this.#clients.set(client, this.pendingFor(client) + 1);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (created) {
      this.#queue.push(target);
      target.timer = setTimeout(() => this.#expire(target), Math.max(0, deadlineAt - Date.now()));
      target.timer.unref?.();
      this.#pump();
    }
    return promise;
  }

  #pump(): void {
    while (this.#active < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift() as Job;
      if (Date.now() >= job.deadlineAt) {
        this.#reject(job, new WorkAdmissionError("deadline", this.#retryAfterMs));
        continue;
      }
      this.#start(job);
    }
  }

  #start(job: Job): void {
    job.state = "running";
    if (job.timer) clearTimeout(job.timer);
    this.#active += 1;
    // A replacement for abandoned work starts only after that work has settled,
    // so it never joins a result that is already being cancelled.
    const predecessor = this.#abandoned.get(job.key) ?? Promise.resolve();
    predecessor
      .then(() => job.operation(job.controller.signal, job.deadlineAt))
      .then(
        (value) => this.#finish(job, (waiter) => waiter.resolve(value)),
        (error) => this.#finish(job, (waiter) => waiter.reject(error)),
      );
  }

  #finish(job: Job, settle: (waiter: Waiter) => void): void {
    job.state = "settled";
    this.#active -= 1;
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    if (this.#abandoned.get(job.key) === job.done) this.#abandoned.delete(job.key);
    job.markDone();
    for (const waiter of [...job.waiters]) this.#settleWaiter(job, waiter, () => settle(waiter));
    this.#pump();
  }

  /** Drop queued work whose start deadline passed. Running work owns its own deadline. */
  #expire(job: Job): void {
    if (job.state !== "queued") return;
    const index = this.#queue.indexOf(job);
    if (index >= 0) this.#queue.splice(index, 1);
    this.#reject(job, new WorkAdmissionError("deadline", this.#retryAfterMs));
  }

  #reject(job: Job, error: Error): void {
    job.state = "settled";
    if (job.timer) clearTimeout(job.timer);
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    job.markDone();
    for (const waiter of [...job.waiters]) {
      this.#settleWaiter(job, waiter, () => waiter.reject(error));
    }
  }

  #leave(job: Job, waiter: Waiter, reason: unknown): void {
    this.#settleWaiter(job, waiter, () => waiter.reject(reason));
    if (job.waiters.size > 0 || job.state === "settled") return;
    if (job.state === "queued") {
      const index = this.#queue.indexOf(job);
      if (index >= 0) this.#queue.splice(index, 1);
      job.state = "settled";
      if (job.timer) clearTimeout(job.timer);
      if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
      job.markDone();
      return;
    }
    if (!this.#cancelAbandoned) return;
    if (this.#jobs.get(job.key) === job) this.#jobs.delete(job.key);
    this.#abandoned.set(job.key, job.done);
    job.controller.abort(new Error("Every caller left before the work finished"));
  }

  #settleWaiter(job: Job, waiter: Waiter, settle: () => void): void {
    if (waiter.done) return;
    waiter.done = true;
    job.waiters.delete(waiter);
    waiter.detach();
    const remaining = this.pendingFor(waiter.client) - 1;
    if (remaining > 0) this.#clients.set(waiter.client, remaining);
    else this.#clients.delete(waiter.client);
    settle();
  }
}
