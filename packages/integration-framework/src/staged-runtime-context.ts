export interface StagedRuntimeContext<T> {
  init(context: T): void;
  begin(): void;
  stageCommit(action: () => void, rollback?: () => void): void;
  commit(): void;
  rollback(): void;
  get(): T;
}

export interface StagedRuntimeValue<T> {
  stage(runtime: Pick<StagedRuntimeContext<unknown>, "stageCommit">, value: T): void;
}

interface ActivationRegistrar {
  onActivate(activate: () => void, rollback?: () => void): void;
}

interface StagedAction {
  commit: () => void;
  rollback?: () => void;
}

interface StagedTransaction<T> {
  context: T | undefined;
  previousContext: T | undefined;
  actions: StagedAction[];
  appliedActions: number;
  state: "staged" | "committing" | "committed";
}

export function createStagedRuntimeContext<T>(label: string): StagedRuntimeContext<T> {
  let activeContext: T | undefined;
  let staged: StagedTransaction<T> | null = null;

  const finalizeCommitted = (): void => {
    if (staged?.state === "committed") staged = null;
  };

  return {
    init(context) {
      finalizeCommitted();
      if (staged) {
        staged.context = context;
      } else {
        activeContext = context;
      }
    },
    begin() {
      finalizeCommitted();
      if (staged) throw new Error(`${label} runtime staging is already active`);
      staged = {
        context: undefined,
        previousContext: activeContext,
        actions: [],
        appliedActions: 0,
        state: "staged",
      };
    },
    stageCommit(action, rollback) {
      finalizeCommitted();
      if (staged) staged.actions.push({ commit: action, rollback });
      else action();
    },
    commit() {
      if (staged?.state !== "staged") {
        throw new Error(`${label} runtime staging is not active`);
      }
      staged.state = "committing";
      activeContext = staged.context;
      for (let index = 0; index < staged.actions.length; index++) {
        staged.appliedActions = index + 1;
        staged.actions[index].commit();
      }
      staged.state = "committed";
    },
    rollback() {
      if (!staged) return;
      const transaction = staged;
      staged = null;
      if (transaction.state === "staged") return;
      activeContext = transaction.previousContext;
      let firstError: unknown;
      for (let index = transaction.appliedActions - 1; index >= 0; index--) {
        try {
          transaction.actions[index].rollback?.();
        } catch (error) {
          firstError ??= error;
        }
      }
      if (firstError !== undefined) throw firstError;
    },
    get() {
      if (activeContext === undefined) {
        throw new Error(
          `${label} runtime: integration context not initialised — call initRuntime(ctx) in setup()`,
        );
      }
      return activeContext;
    },
  };
}

export function createStagedRuntimeValue<T>(apply: (value: T) => void): StagedRuntimeValue<T> {
  let activeValue: T;
  let hasActiveValue = false;
  return {
    stage(runtime, value) {
      const previousValue = activeValue;
      const hadPreviousValue = hasActiveValue;
      runtime.stageCommit(
        () => {
          apply(value);
          activeValue = value;
          hasActiveValue = true;
        },
        () => {
          if (!hadPreviousValue) {
            hasActiveValue = false;
            return;
          }
          apply(previousValue);
          activeValue = previousValue;
          hasActiveValue = true;
        },
      );
    },
  };
}

export function stageRuntimeGeneration<T>(
  activation: ActivationRegistrar,
  runtime: StagedRuntimeContext<T>,
  context: T,
  prepare: () => void,
): void {
  runtime.begin();
  try {
    runtime.init(context);
    prepare();
  } catch (error) {
    runtime.rollback();
    throw error;
  }
  activation.onActivate(runtime.commit, runtime.rollback);
}
