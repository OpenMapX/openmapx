export type IntegrationActivation = () => void;

export interface ActivationTransactionScope {
  register(activate: IntegrationActivation, rollback?: IntegrationActivation): void;
  activate(): void;
  rollback(): unknown[];
  complete(): void;
}

interface ActivationTransaction {
  activate: IntegrationActivation;
  rollback?: IntegrationActivation;
  activated: boolean;
  rolledBack: boolean;
}

export function createActivationTransactionScope(
  options: { activateOnRegister?: boolean } = {},
): ActivationTransactionScope {
  const transactions: ActivationTransaction[] = [];
  let completed = false;
  let rolledBack = false;

  const activateTransaction = (transaction: ActivationTransaction): void => {
    if (transaction.activated) return;
    transaction.activated = true;
    transaction.activate();
  };

  return {
    register(activate, rollback) {
      if (completed || rolledBack) {
        throw new Error("integration activation transaction is closed");
      }
      const transaction: ActivationTransaction = {
        activate,
        rollback,
        activated: false,
        rolledBack: false,
      };
      transactions.push(transaction);
      if (options.activateOnRegister) activateTransaction(transaction);
    },
    activate() {
      if (completed || rolledBack) {
        throw new Error("integration activation transaction is closed");
      }
      for (const transaction of transactions) activateTransaction(transaction);
    },
    rollback() {
      if (completed || rolledBack) return [];
      rolledBack = true;
      const errors: unknown[] = [];
      for (let index = transactions.length - 1; index >= 0; index--) {
        const transaction = transactions[index];
        if (transaction.rolledBack || !transaction.rollback) continue;
        transaction.rolledBack = true;
        try {
          transaction.rollback();
        } catch (error) {
          errors.push(error);
        }
      }
      return errors;
    },
    complete() {
      if (rolledBack) throw new Error("integration activation transaction is closed");
      if (transactions.some((transaction) => !transaction.activated)) {
        throw new Error("integration activation transaction has staged callbacks");
      }
      completed = true;
    },
  };
}

export function runImmediateActivation(
  activate: IntegrationActivation,
  rollback?: IntegrationActivation,
): void {
  const scope = createActivationTransactionScope({ activateOnRegister: true });
  try {
    scope.register(activate, rollback);
    scope.complete();
  } catch (error) {
    scope.rollback();
    throw error;
  }
}
