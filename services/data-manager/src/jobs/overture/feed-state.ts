import { feedState } from "@openmapx/db-schema";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assertDataPublication } from "../execution/worker-scope.js";
export async function writeOvertureFeedState(
  region: string,
  hash: string,
  log: { warn: (message: string, extra?: Record<string, unknown>) => void },
): Promise<void> {
  try {
    assertDataPublication();
    const feedRegion = `overture-places-${region}`;
    const feedName = "overture-places";
    const existing = await db
      .select({ id: feedState.id })
      .from(feedState)
      .where(and(eq(feedState.region, feedRegion), eq(feedState.name, feedName)))
      .limit(1);
    if (existing[0]) {
      await db
        .update(feedState)
        .set({
          hash,
          lastFetchedAt: new Date(),
          lastImportedAt: new Date(),
          validationStatus: "ok",
          validationMessage: `Imported Overture release ${hash}`,
          consecutiveFailures: 0,
          status: "active",
        })
        .where(eq(feedState.id, existing[0].id));
    } else {
      await db.insert(feedState).values({
        region: feedRegion,
        name: feedName,
        hash,
        lastFetchedAt: new Date(),
        lastImportedAt: new Date(),
        validationStatus: "ok",
        validationMessage: `Imported Overture release ${hash}`,
        consecutiveFailures: 0,
        status: "active",
      });
    }
  } catch (err) {
    log.warn("overture-cron: feed_state write failed", { err: (err as Error).message });
  }
}
