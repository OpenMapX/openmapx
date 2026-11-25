import { type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";

/** `<column> in ('a', 'b', …)` for a CHECK on a closed vocabulary. */
export function oneOf(column: AnyPgColumn, values: readonly string[]): SQL {
  for (const value of values)
    if (!/^[a-z0-9_.-]+$/.test(value)) throw new Error(`Unsafe vocabulary value: ${value}`);
  return sql`${column} in (${sql.raw(values.map((value) => `'${value}'`).join(", "))})`;
}
