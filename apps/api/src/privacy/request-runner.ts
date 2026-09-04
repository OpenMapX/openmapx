export interface RunnerTask {
  id: string;
  requestId: string;
  status: "pending" | "retryable" | "running";
  attempts: number;
  nextAttemptAt?: Date | null;
}

export interface RunnerTaskStore {
  claimDueTask(now: Date): Promise<RunnerTask | null>;
  completeTask(taskId: string): Promise<void>;
  retryTask(taskId: string, nextAttemptAt: Date, errorCode: string): Promise<void>;
  /** Put a claimed task back without consuming its bounded transient-failure
   * budget.  This is used for durable prerequisites (for example a pending
   * operator review) rather than a collector failure. */
  deferTask?(taskId: string, nextAttemptAt: Date, reasonCode: string): Promise<void>;
  operatorReview(taskId: string, errorCode: string): Promise<void>;
  recoverInterrupted?(): Promise<void>;
}

/** A task is healthy but cannot run yet.  Deferrals must not eventually turn
 * into an automatic legal decision; a human or another durable event must
 * make the prerequisite true. */
export class PrivacyRequestDeferredError extends Error {
  constructor(readonly reasonCode = "prerequisite-pending") {
    super(reasonCode);
    this.name = "PrivacyRequestDeferredError";
  }
}

export interface PrivacyRequestRunnerOptions {
  intervalMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  deferDelayMs?: number;
  now?: () => Date;
  onError?: () => void;
  releaseReady?: () => boolean | Promise<boolean>;
}

export class PrivacyRequestRunner {
  private readonly options: Required<PrivacyRequestRunnerOptions>;
  private timer: ReturnType<typeof setInterval> | undefined;
  private active = 0;
  constructor(
    private readonly store: RunnerTaskStore,
    private readonly handler: (task: RunnerTask) => Promise<void>,
    options: PrivacyRequestRunnerOptions = {},
  ) {
    this.options = {
      intervalMs: options.intervalMs ?? 1_000,
      maxAttempts: options.maxAttempts ?? 5,
      retryDelayMs: options.retryDelayMs ?? 30_000,
      deferDelayMs: options.deferDelayMs ?? 60_000,
      now: options.now ?? (() => new Date()),
      onError: options.onError ?? (() => undefined),
      releaseReady: options.releaseReady ?? (() => true),
    };
  }

  async recover(): Promise<void> {
    await this.store.recoverInterrupted?.();
  }

  async runOnce(): Promise<boolean> {
    if (this.active > 0) return false;
    if (!(await this.options.releaseReady())) return false;
    this.active += 1;
    try {
      const task = await this.store.claimDueTask(this.options.now());
      if (!task) return false;
      try {
        await this.handler(task);
        await this.store.completeTask(task.id);
      } catch (error) {
        if (error instanceof PrivacyRequestDeferredError) {
          const nextAttemptAt = new Date(this.options.now().getTime() + this.options.deferDelayMs);
          if (this.store.deferTask)
            await this.store.deferTask(task.id, nextAttemptAt, error.reasonCode);
          else await this.store.retryTask(task.id, nextAttemptAt, error.reasonCode);
          return true;
        }
        const attempts = task.attempts;
        if (attempts >= this.options.maxAttempts)
          await this.store.operatorReview(task.id, "collector-exhausted");
        else
          await this.store.retryTask(
            task.id,
            new Date(this.options.now().getTime() + this.options.retryDelayMs * attempts),
            "collector-transient",
          );
      }
      return true;
    } finally {
      this.active -= 1;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.recover().catch(this.options.onError);
    this.timer = setInterval(() => {
      void this.runOnce().catch(this.options.onError);
    }, this.options.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
