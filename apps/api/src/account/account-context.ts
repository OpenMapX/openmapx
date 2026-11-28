import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthDatabase } from "./auth-database";
export interface AccountMutationContext {
  database: AuthDatabase;
  actorId: string | null;
  targetId: string | null;
  action:
    | "role"
    | "ban"
    | "unban"
    | "delete"
    | "create"
    | "profile"
    | "password"
    | "verify"
    | "mail";
  mutationKey: string;
  roleAudit: boolean;
  afterCommit: Array<() => Promise<void>>;
  /**
   * Errors better-auth caught inside the mutation and answered as a response,
   * so the mutation can still recognise them once it rolls back.
   */
  failures: unknown[];
}
const context = new AsyncLocalStorage<AccountMutationContext>();
export function currentAccountMutation() {
  return context.getStore();
}
/** Keeps `error` for the account mutation it was thrown in, if any. */
export function recordAccountMutationFailure(error: unknown): void {
  context.getStore()?.failures.push(error);
}
export function withAccountMutationContext<T>(
  value: AccountMutationContext,
  run: () => Promise<T>,
) {
  return context.run(value, run);
}
