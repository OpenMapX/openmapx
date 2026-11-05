import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "../db";
export type AuthDatabase = Pick<
  typeof db,
  "select" | "insert" | "update" | "delete" | "execute" | "query" | "transaction"
>;
const context = new AsyncLocalStorage<AuthDatabase>();
export function currentAuthDatabase(): AuthDatabase {
  return context.getStore() ?? db;
}
export function withAuthDatabase<T>(database: AuthDatabase, run: () => Promise<T>): Promise<T> {
  return context.run(database, run);
}
export function isTransactionalAuthDatabase() {
  return context.getStore() !== undefined;
}
