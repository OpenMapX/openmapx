import { describe, expect, it } from "vitest";
import {
  INTERRUPTED_STATUS,
  type JobReconcileWriter,
  reconcileOrphanedJobs,
} from "../src/jobs/reconcile.js";

/**
 * `reconcileOrphanedJobs` issues a single `update(jobs).set(...).where(...)
 * .returning(...)`. Each test passes a hand-rolled stub that mirrors that
 * drizzle chain — same approach as staleness-alerts.test.ts — so we exercise
 * the function without spinning up Postgres, while capturing the values it
 * writes.
 */
function buildFakeDb(rows: Array<{ id: string }>): {
  handle: JobReconcileWriter;
  captured: { set?: { status: string; finishedAt: Date }; whereCalled: boolean };
} {
  const captured: { set?: { status: string; finishedAt: Date }; whereCalled: boolean } = {
    whereCalled: false,
  };
  const handle = {
    update(_table: unknown) {
      return {
        set(values: { status: string; finishedAt: Date }) {
          captured.set = values;
          return {
            where(_predicate: unknown) {
              captured.whereCalled = true;
              return {
                returning(_columns: unknown) {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
  return { handle: handle as unknown as JobReconcileWriter, captured };
}

describe("reconcileOrphanedJobs", () => {
  it("stamps running jobs as interrupted with a finish time and returns their ids", async () => {
    const now = new Date("2026-06-27T10:00:00.000Z");
    const { handle, captured } = buildFakeDb([{ id: "job-a" }, { id: "job-b" }]);

    const ids = await reconcileOrphanedJobs({ db: handle, now: () => now });

    expect(ids).toEqual(["job-a", "job-b"]);
    expect(captured.whereCalled).toBe(true);
    expect(captured.set).toEqual({ status: INTERRUPTED_STATUS, finishedAt: now });
    expect(INTERRUPTED_STATUS).toBe("interrupted");
  });

  it("returns an empty list on a clean boot (no running jobs)", async () => {
    const { handle, captured } = buildFakeDb([]);
    const ids = await reconcileOrphanedJobs({ db: handle });
    expect(ids).toEqual([]);
    expect(captured.set?.status).toBe(INTERRUPTED_STATUS);
  });
});
