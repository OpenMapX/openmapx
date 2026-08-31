export interface StagedRuntimeContext<T> {
  init(context: T): void;
  begin(): void;
  stageCommit(action: () => void): void;
  commit(): void;
  rollback(): void;
  get(): T;
}

interface StagedTransaction<T> {
  context: T | undefined;
  commitActions: Array<() => void>;
}

export function createStagedRuntimeContext<T>(label: string): StagedRuntimeContext<T> {
  let activeContext: T | undefined;
  let staged: StagedTransaction<T> | null = null;

  return {
    init(context) {
      if (staged) staged.context = context;
      else activeContext = context;
    },
    begin() {
      if (staged) throw new Error(`${label} runtime staging is already active`);
      staged = { context: undefined, commitActions: [] };
    },
    stageCommit(action) {
      if (staged) staged.commitActions.push(action);
      else action();
    },
    commit() {
      if (!staged) throw new Error(`${label} runtime staging is not active`);
      const { context, commitActions } = staged;
      activeContext = context;
      staged = null;
      for (const action of commitActions) action();
    },
    rollback() {
      staged = null;
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
