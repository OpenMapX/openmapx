import {
  type Logger,
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
  try {
    new Cron(cron, { ...cronOptions(), paused: true }).stop();
    return null;
  } catch (error) {
    return `Scheduled task ${name}: the cron expression ${JSON.stringify(cron)} does not parse: ${errorMessage(error)}`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Runs the tasks integrations register with `ctx.schedule`. A task runs at
 * most once at a time: a tick is skipped while the task's previous handler
 * has not settled, and while `integration_task_run` holds a `running` row of
 * the task, which its unique index allows once per task. Nothing here awaits
 * a handler: a run is bounded by its deadline, at which its signal aborts and
 * its row is failed, while a handler that ignores the signal keeps its task
 * from running again until it settles. Every timer is unreferenced.
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

  const label = (task: Task) => `${task.integrationId}:${task.name}`;

  function record(
    task: Task,
    run: Run,
    runId: string,
    status: "succeeded" | "failed",
    error?: string,
  ) {
    if (run.recorded || run.stopped) return;
    run.recorded = true;
    runs.finish(runId, status, error).catch((finishError: unknown) => {
      log.warn(`Could not record the run of scheduled task ${label(task)}`, {
        err: finishError,
        integrationId: task.integrationId,
        task: task.name,
      });
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

    const settle = (failed: boolean, error?: unknown) => {
      clearTimeout(run.deadline);
      run.deadline = undefined;
      if (task.run === run) task.run = null;
      lingering.delete(task);
      const durationMs = now() - run.startedAt;
      if (!failed) {
        log.debug(`Scheduled task ${label(task)} finished`, {
          integrationId: task.integrationId,
          task: task.name,
          durationMs,
        });
        record(task, run, runId, "succeeded");
        return;
      }
      if (!run.recorded && !run.stopped) {
        log.warn(`Scheduled task ${label(task)} failed`, {
          err: error,
          integrationId: task.integrationId,
          task: task.name,
          durationMs,
        });
      }
      record(task, run, runId, "failed", errorMessage(error).slice(0, MAX_ERROR_LENGTH));
    };

    let pending: Promise<void>;
    try {
      pending = Promise.resolve(
        runInIntegrationScope(task.scope, () => task.handler({ signal: controller.signal })),
      );
    } catch (error) {
      pending = Promise.reject(error);
    }
    pending.then(
      () => settle(false),
      (error: unknown) => settle(true, error),
    );
  }

  async function tick(task: Task) {
    if (task.retired || task.stopped || task.run || task.starting) return;
    task.starting = true;
    let runId: string | null;
    try {
      runId = await runs.start(task.integrationId, task.name);
    } catch (error) {
      log.warn(`Could not start scheduled task ${label(task)}; skipping this run`, {
        err: error,
        integrationId: task.integrationId,
        task: task.name,
      });
      return;
    } finally {
      task.starting = false;
    }
    if (runId === null) {
      log.debug(`Scheduled task ${label(task)} is still running; skipping this run`, {
        integrationId: task.integrationId,
        task: task.name,
      });
      return;
    }
    // A stopping process leaves the row to the next start's recovery.
    if (task.stopped) return;
    if (task.retired) {
      runs
        .finish(runId, "failed", "replaced by a reload before it started")
        .catch((error: unknown) => {
          log.warn(`Could not record the run of scheduled task ${label(task)}`, {
            err: error,
            integrationId: task.integrationId,
            task: task.name,
          });
        });
      return;
    }
    execute(task, runId);
  }

  function startTicks(task: Task) {
    const onTick = () => {
      tick(task).catch((error: unknown) => {
        log.error(`Scheduled task ${label(task)} could not run`, {
          err: error,
          integrationId: task.integrationId,
          task: task.name,
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
        scheduleRegistrationProblem(name, options) ??
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
