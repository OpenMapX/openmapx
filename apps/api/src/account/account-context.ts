import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthDatabase } from "./auth-database";
export interface AccountMutationContext {
  database: AuthDatabase;
  actorId: string | null;
  targetId: string | null;
  action: "role" | "ban" | "unban" | "delete" | "create" | "profile";
  mutationKey: string;
  roleAudit: boolean;
  afterCommit: Array<() => Promise<void>>;
}
const context = new AsyncLocalStorage<AccountMutationContext>();
export function currentAccountMutation() {
  return context.getStore();
}
export function withAccountMutationContext<T>(
  value: AccountMutationContext,
  run: () => Promise<T>,
) {
  return context.run(value, run);
}
