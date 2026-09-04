import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  preservationAllowsDeletion,
  preservationHoldsCandidate,
  preservationReleaseTransition,
  withPreservationRetentionLock,
} from "./preservation.js";

const dialect = new PgDialect();

describe("privacy preservation", () => {
  const base = {
    registrationId: "saved-places",
    locatorDigest: "d",
    sourceCutoffAt: new Date("2024-01-10T00:00:00Z"),
    status: "held",
    releasedAt: null,
  } as const;
  it("holds only the matching subject, source and cutoff", () => {
    expect(
      preservationHoldsCandidate(base, "saved-places", "d", new Date("2024-01-09T00:00:00Z")),
    ).toBe(true);
    expect(
      preservationHoldsCandidate(base, "saved-places", "other", new Date("2024-01-09T00:00:00Z")),
    ).toBe(false);
    expect(
      preservationHoldsCandidate(base, "saved-places", "d", new Date("2024-01-11T00:00:00Z")),
    ).toBe(false);
    expect(
      preservationHoldsCandidate(
        { ...base, status: "captured" },
        "saved-places",
        "d",
        new Date("2024-01-09T00:00:00Z"),
      ),
    ).toBe(false);
  });
  it("makes capture/release idempotent", () => {
    expect(preservationReleaseTransition("held", null, "capture")).toEqual({
      status: "captured",
      released: false,
    });
    expect(preservationReleaseTransition("captured", null, "release")).toEqual({
      status: "released",
      released: true,
    });
    expect(preservationReleaseTransition("released", new Date(), "release")).toEqual({
      status: "released",
      released: false,
    });
  });

  it("builds an atomic source-scoped deletion guard for all exact subject columns", () => {
    const query = dialect.sqlToQuery(
      preservationAllowsDeletion({
        registrationId: "admin-audit-attribution",
        candidateTimestamp: sql.identifier("created_at"),
        subjectIds: [sql.identifier("actor_id"), sql.identifier("target_id")],
      }),
    );

    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain("data_subject_request_preservation");
    expect(query.sql).toContain("data_subject_request");
    expect(query.sql).toContain("preservation.status = 'held'");
    expect(query.sql).toContain('source_cutoff_at >= "created_at"');
    expect(query.sql).toContain('user_id = "actor_id"');
    expect(query.sql).toContain('user_id = "target_id"');
    expect(query.params).toEqual(["admin-audit-attribution"]);
  });

  it("takes the transaction lock in a separate statement before retention work", async () => {
    const order: string[] = [];
    const transaction = {
      execute: async () => {
        order.push("lock");
      },
    };
    const database = {
      transaction: async (callback: (tx: typeof transaction) => Promise<string>) => {
        order.push("transaction");
        return callback(transaction);
      },
    };
    const result = await withPreservationRetentionLock(database as never, async (tx) => {
      expect(tx).toBe(transaction);
      order.push("delete");
      return "done";
    });
    expect(result).toBe("done");
    expect(order).toEqual(["transaction", "lock", "delete"]);
  });
});
