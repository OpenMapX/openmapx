import { inArray } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";

export interface ActorSummary {
  id: string;
  name: string;
  email: string;
}

/**
 * Look up a set of user IDs and return a map id → { id, name, email }.
 * Used by /admin/audit and /admin/jobs to render the actor column without
 * each row having to round-trip the users API.
 */
export async function resolveActors(ids: Array<string | null>): Promise<Map<string, ActorSummary>> {
  const distinct = Array.from(new Set(ids.filter((id): id is string => !!id)));
  if (distinct.length === 0) return new Map();

  const rows = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(inArray(user.id, distinct));

  return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, email: r.email }]));
}
