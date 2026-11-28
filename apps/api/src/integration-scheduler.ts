import {
  describeThrown,
  type Logger,
  loggableThrown,
  type ScheduleOptions,
  scheduleRegistrationProblem,
} from "@openmapx/integration-framework";
import { Cron } from "croner";
import { type IntegrationScope, runInIntegrationScope } from "./integration-scope";

export type ScheduledTaskHandler = (run: { signal: AbortSignal }) => Promise<void>;

/** Where the runs of scheduled tasks are recorded: `integration_task_run`. */
export interface TaskRunStore {
  /** Inserts the `running` row and returns its id, or `null` while the task already has one. */
  start(integrationId: string, taskName: string): Promise<string | null>;
  finish(runId: string, status: "succeeded" | "failed", error?: string): Promise<void>;
  /** Fails every `running` row; returns how many there were. */
  failInterrupted(): Promise<number>;
}

export interface IntegrationScheduler {
  /** Holds a task `setup` registered until its generation is activated; throws on an invalid registration. */
  stage(
    integrationId: string,
    scope: IntegrationScope,
    name: string,
    options: ScheduleOptions,
    handler: ScheduledTaskHandler,
  ): void;
  /** Drops the staged tasks of an integration whose load failed. */
  discard(integrationId: string): void;
  /** Starts the staged tasks of these integrations. */
  activate(integrationIds: readonly string[]): void;
  /** Stops the running generation's ticks and aborts its runs, which keep their deadline. */
  retire(integrationId: string): void;
  /** Fails the runs a previous process left `running`; call it once, before any activation. */
  recoverInterrupted(): Promise<number>;
  /** Aborts every run and clears every timer without waiting for a handler. */
  stop(): void;
}

/** The longest error message recorded for a failed run. */
const MAX_ERROR_LENGTH = 2_000;
const DEADLINE_EXCEEDED = "deadline exceeded";
/**
 * The pauses before each retry of a failed write of a run's outcome. They add
 * up to less than the shortest interval, so the retries end before the next
 * tick, which tries once more.
 */
const OUTCOME_RETRY_DELAYS_MS = [1_000, 5_000, 15_000] as const;

/** A run's outcome that still has to be written. */
interface Outcome {
  readonly runId: string;
  readonly status: "succeeded" | "failed";
  readonly error?: string;
}

interface Run {
  readonly controller: AbortController;
  deadline: ReturnType<typeof setTimeout> | undefined;
  /** The outcome was written, at the deadline or when the handler settled. */
  recorded: boolean;
  /** The process is stopping; the next start records the row as interrupted. */
  stopped: boolean;
  readonly startedAt: number;
}

interface Task {
  readonly integrationId: string;
  readonly name: string;
  readonly scope: IntegrationScope;
  readonly options: ScheduleOptions;
  readonly handler: ScheduledTaskHandler;
  cron?: Cron;
  interval?: ReturnType<typeof setInterval>;
  retired: boolean;
  stopped: boolean;
  /** Waiting for its run's row. */
  starting: boolean;
  /** The run whose handler has not settled yet. */
  run: Run | null;
}

function cronOptions() {
  // Five fields: no task runs more often than once a minute, as for `everyMs`.
  return { timezone: "UTC", mode: "5-part" as const, unref: true };
}

function cronProblem(name: string, cron: string): string | null {
  let job: Cron;
  try {
    job = new Cron(cron, { ...cronOptions(), paused: true });
  } catch (error) {
    return `Scheduled task ${name}: the cron expression ${JSON.stringify(cron)} does not parse: ${describeThrown(error)}`;
  }
  const next = job.nextRun();
  job.stop();
  return next === null
    ? `Scheduled task ${name}: the cron expression ${JSON.stringify(cron)} never matches`
    : null;
}

/**
 * Runs the tasks integrations register with `ctx.schedule`. A task runs at
 * most once at a time: a tick is skipped while the task's previous handler
 * has not settled, and while `integration_task_run` holds a `running` row of
 * the task, which its unique index allows once per task. Nothing here awaits
 * a handler: a run is bounded by its deadline, at which its signal aborts and
 * its row is failed, while a handler that ignores the signal keeps its task
 * from running again until it settles. A run's outcome whose write fails is
 * retried, then kept in memory and written before the task's next tick, which
 * runs only once that has worked. Every timer is unreferenced.
 */
export function createIntegrationScheduler(deps: {
  runs: TaskRunStore;
  now?: () => number;
  log: Logger;
}): IntegrationScheduler {
  const { runs, log } = deps;
  const now = deps.now ?? Date.now;
  const staged = new Map<string, Map<string, Task>>();
  const active = new Map<string, Task[]>();
  /** Retired tasks whose run has not settled, so `stop` can still abort it. */
  const lingering = new Set<Task>();

  /**
   * Outcomes not yet written, by task label, whichever generation ran them.
   * The run's row stays `running` until its outcome is written, so a task
   * with an entry here does not start another run.
   */
  const unwritten = new Map<string, Outcome>();
  /** The labels of the tasks whose outcome is being written right now. */
  const writing = new Set<string>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  let stopping = false;

  const label = (task: Task) => `${task.integrationId}:${task.name}`;
  const taskFields = (task: Task) => ({ integrationId: task.integrationId, task: task.name });

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        resolve();
      }, ms);
      timer.unref?.();
      retryTimers.add(timer);
    });
  }

  /**
   * Writes the task's unwritten outcome, pausing `delays` between attempts;
   * resolves with `null` once none is left, or with the last write's error.
   * At most one write per task runs at a time.
   */
  async function writeOutcome(task: Task, delays: readonly number[]): Promise<unknown> {
    const key = label(task);
    if (writing.has(key)) return new Error("Another write of the outcome is in progress");
    writing.add(key);
    try {
      for (let attempt = 0; ; attempt += 1) {
        const outcome = unwritten.get(key);
        if (!outcome) return null;
        try {
          await runs.finish(outcome.runId, outcome.status, outcome.error);
          unwritten.delete(key);
          return null;
        } catch (error) {
          const delay = delays[attempt];
          if (delay === undefined || stopping) return error ?? new Error(String(error));
          await pause(delay);
        }
      }
    } finally {
      writing.delete(key);
    }
  }

  function record(
    task: Task,
    run: Run,
    runId: string,
    status: "succeeded" | "failed",
    error?: string,
  ) {
    if (run.recorded || run.stopped) return;
    run.recorded = true;
    keep(task, { runId, status, ...(error === undefined ? {} : { error }) });
  }

  /** Writes the outcome, with retries; one that still fails waits for the task's next tick. */
  function keep(task: Task, outcome: Outcome) {
    unwritten.set(label(task), outcome);
    void writeOutcome(task, OUTCOME_RETRY_DELAYS_MS).then((failure) => {
      if (failure === null || stopping) return;
      log.warn(
        `Could not record the run of scheduled task ${label(task)}; trying again before its next run`,
        { err: loggableThrown(failure), ...taskFields(task) },
      );
    });
  }

  function stopTicks(task: Task) {
    task.cron?.stop();
    task.cron = undefined;
    clearInterval(task.interval);
    task.interval = undefined;
  }

  function execute(task: Task, runId: string) {
    const controller = new AbortController();
    const run: Run = {
      controller,
      deadline: undefined,
      recorded: false,
      stopped: false,
      startedAt: now(),
    };
    task.run = run;
    run.deadline = setTimeout(() => {
      run.deadline = undefined;
      controller.abort(new Error(DEADLINE_EXCEEDED));
      log.warn(
        `Scheduled task ${label(task)} did not finish within ${task.options.deadlineMs} ms; aborted it`,
        { integrationId: task.integrationId, task: task.name },
      );
      record(task, run, runId, "failed", DEADLINE_EXCEEDED);
    }, task.options.deadlineMs);
    run.deadline.unref?.();

    // The handler may reject with any value at all; its description cannot
    // throw, and the outcome is kept before anything is logged.
    const settle = (failed: boolean, error?: unknown) => {
      clearTimeout(run.deadline);
      run.deadline = undefined;
      if (task.run === run) task.run = null;
      lingering.delete(task);
      const durationMs = now() - run.startedAt;
      if (!failed) {
        record(task, run, runId, "succeeded");
        log.debug(`Scheduled task ${label(task)} finished`, { ...taskFields(task), durationMs });
        return;
      }
      const unreported = !run.recorded && !run.stopped;
      record(task, run, runId, "failed", describeThrown(error).slice(0, MAX_ERROR_LENGTH));
      if (unreported)
        log.warn(`Scheduled task ${label(task)} failed`, {
          err: loggableThrown(error),
          ...taskFields(task),
          durationMs,
        });
    };

    let pending: Promise<void>;
    try {
      pending = Promise.resolve(
        runInIntegrationScope(task.scope, () => task.handler({ signal: controller.signal })),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending
      .then(
        () => settle(false),
        (error: unknown) => settle(true, error),
      )
      .catch((settleError: unknown) => {
        try {
          log.error(`Scheduled task ${label(task)} could not be settled`, {
            err: loggableThrown(settleError),
            ...taskFields(task),
          });
        } catch {
          // Nothing is left to tell.
        }
      });
  }

  /** Whether the task has no outcome left to write, after one more attempt. */
  async function outcomeWritten(task: Task): Promise<{ written: boolean; error?: unknown }> {
    if (!unwritten.has(label(task))) return { written: true };
    const failure = await writeOutcome(task, []);
    return failure === null ? { written: true } : { written: false, error: failure };
  }

  async function tick(task: Task) {
    if (task.retired || task.stopped || task.run || task.starting) return;
    task.starting = true;
    let runId: string | null;
    try {
      const outcome = await outcomeWritten(task);
      if (!outcome.written) {
        log.warn(
          `Scheduled task ${label(task)} skipped this run: the outcome of its previous run could not be recorded`,
          { err: loggableThrown(outcome.error), ...taskFields(task) },
        );
        return;
      }
      runId = await runs.start(task.integrationId, task.name);
    } catch (error) {
      log.warn(`Could not start scheduled task ${label(task)}; skipping this run`, {
        err: loggableThrown(error),
        ...taskFields(task),
      });
      return;
    } finally {
      task.starting = false;
    }
    if (runId === null) {
      // A retired run of this process that is still going holds the row;
      // anything else is a row this process cannot account for.
      const own = [...lingering].some((other) => label(other) === label(task));
      const message = own
        ? `Scheduled task ${label(task)} is still running; skipping this run`
        : `Scheduled task ${label(task)} skipped this run: a run this process did not start is recorded as running`;
      if (own) log.debug(message, taskFields(task));
      else log.warn(message, taskFields(task));
      return;
    }
    // A stopping process leaves the row to the next start's recovery.
    if (task.stopped) return;
    if (task.retired) {
      keep(task, { runId, status: "failed", error: "replaced by a reload before it started" });
      return;
    }
    execute(task, runId);
  }

  function startTicks(task: Task) {
    const onTick = () => {
      tick(task).catch((error: unknown) => {
        log.error(`Scheduled task ${label(task)} could not run`, {
          err: loggableThrown(error),
          ...taskFields(task),
        });
      });
    };
    if (task.options.cron !== undefined) {
      task.cron = new Cron(task.options.cron, cronOptions(), onTick);
    } else {
      task.interval = setInterval(onTick, task.options.everyMs);
      task.interval.unref?.();
    }
  }

  function retire(integrationId: string) {
    const tasks = active.get(integrationId) ?? [];
    active.delete(integrationId);
    for (const task of tasks) {
      task.retired = true;
      stopTicks(task);
      if (!task.run) continue;
      // The run keeps its row and its deadline, so the next generation's
      // ticks of this task wait until it settles or its deadline passes.
      lingering.add(task);
      task.run.controller.abort(new Error("The integration was reloaded"));
    }
  }

  return {
    stage(integrationId, scope, name, options, handler) {
      const problem =
        scheduleRegistrationProblem(name, options, handler) ??
        (options.cron !== undefined ? cronProblem(name, options.cron) : null);
      if (problem) throw new Error(problem);
      let tasks = staged.get(integrationId);
      if (tasks?.has(name)) {
        throw new Error(`Scheduled task ${name} is already scheduled by ${integrationId}`);
      }
      if (!tasks) {
        tasks = new Map();
        staged.set(integrationId, tasks);
      }
      tasks.set(name, {
        integrationId,
        name,
        scope,
        options: { ...options },
        handler,
        retired: false,
        stopped: false,
        starting: false,
        run: null,
      });
    },
    discard(integrationId) {
      staged.delete(integrationId);
    },
    activate(integrationIds) {
      for (const integrationId of integrationIds) {
        const tasks = staged.get(integrationId);
        if (!tasks) continue;
        staged.delete(integrationId);
        retire(integrationId);
        const started = [...tasks.values()];
        for (const task of started) startTicks(task);
        active.set(integrationId, started);
      }
    },
    retire,
    recoverInterrupted() {
      return runs.failInterrupted();
    },
    stop() {
      // Outcomes not yet written stay `running`; the next start's recovery
      // closes them.
      stopping = true;
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      staged.clear();
      const tasks = [...[...active.values()].flat(), ...lingering];
      active.clear();
      lingering.clear();
      for (const task of tasks) {
        task.retired = true;
        task.stopped = true;
        stopTicks(task);
        const { run } = task;
        if (!run) continue;
        run.stopped = true;
        clearTimeout(run.deadline);
        run.deadline = undefined;
        run.controller.abort(new Error("The API is stopping"));
      }
    },
  };
}
