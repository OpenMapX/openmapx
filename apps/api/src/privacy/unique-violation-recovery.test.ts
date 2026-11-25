import { DrizzleQueryError } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { DATA_DISCLOSURE_EVENT_IDEMPOTENCY_KEY } from "../db/disclosure-schema.js";
import { ACTIVE_REQUEST_KIND_KEY, REQUEST_EVENT_IDEMPOTENCY_KEY } from "../db/privacy-schema.js";
import { recordDataDisclosure } from "./disclosures.js";
import { recordIdempotentEvent } from "./idempotency.js";
import { PrivacyRequestService } from "./request-service.js";

/** What drizzle-orm 0.45 + postgres.js actually throw for a unique violation. */
function uniqueViolation(constraint: string) {
  const driver = Object.assign(
    new Error(`duplicate key value violates unique constraint "${constraint}"`),
    { name: "PostgresError", code: "23505", constraint_name: constraint },
  );
  return new DrizzleQueryError('insert into "t" values ($1)', ["x"], driver);
}

/** Chainable select stub: each `.limit()` resolves the next queued result. */
function selectStub(results: unknown[][]) {
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "for"]) chain[m] = () => chain;
  chain.limit = async () => results.shift() ?? [];
  return () => chain;
}

function throwingInsert(error: unknown) {
  return () => ({
    values: async () => {
      throw error;
    },
  });
}

const createInput = {
  userId: "u1",
  kind: "access_and_portability",
  channel: "self_service",
  locale: "de",
  timeZone: "UTC",
} as const;

function serviceWith(fake: unknown) {
  return new PrivacyRequestService({
    database: fake as never,
    now: () => new Date("2026-03-01T12:00:00Z"),
  });
}

const disclosure = {
  userId: "u",
  occurredAt: new Date("2026-03-01T12:00:00Z"),
  recipientId: "osm",
  operationCode: "publish",
  categoryCode: "osm-publication",
  purposeCode: "publication",
  legalBasisCode: "consent",
} as const;

describe("privacy unique-constraint race recovery", () => {
  it("cannot see the constraint name in the wrapped driver error text", () => {
    expect(String(uniqueViolation(ACTIVE_REQUEST_KIND_KEY))).not.toContain(ACTIVE_REQUEST_KIND_KEY);
  });

  describe("create", () => {
    it("returns the winner's case when a concurrent first request won the race", async () => {
      const winnerRow = { id: "winner", state: "in_progress" };
      const fake = {
        select: selectStub([[], [winnerRow]]),
        transaction: vi.fn(async () => {
          throw uniqueViolation(ACTIVE_REQUEST_KIND_KEY);
        }),
      };
      await expect(serviceWith(fake).create(createInput)).resolves.toBe(winnerRow);
    });

    it("reports an active request when the winner's case is no longer active", async () => {
      const fake = {
        select: selectStub([[], []]),
        transaction: vi.fn(async () => {
          throw uniqueViolation(ACTIVE_REQUEST_KIND_KEY);
        }),
      };
      await expect(serviceWith(fake).create(createInput)).rejects.toMatchObject({
        code: "REQUEST_ALREADY_ACTIVE",
        statusCode: 409,
      });
    });

    it("rethrows a violation of a different constraint", async () => {
      const error = uniqueViolation("data_subject_request_pkey");
      const fake = {
        select: selectStub([[]]),
        transaction: vi.fn(async () => {
          throw error;
        }),
      };
      await expect(serviceWith(fake).create(createInput)).rejects.toBe(error);
    });
  });

  it("returns the current row when a mutation replay loses the idempotency race", async () => {
    const row = { id: "r1", userId: "u1", version: 1 };
    const fake = {
      select: selectStub([[row], [row]]),
      transaction: vi.fn(async () => {
        throw uniqueViolation(REQUEST_EVENT_IDEMPOTENCY_KEY);
      }),
    };
    await expect(serviceWith(fake).withdraw("r1", "u1", 1, "replay-key-0000000001")).resolves.toBe(
      row,
    );
  });

  describe("recordIdempotentEvent", () => {
    const input = {
      requestId: "r1",
      idempotencyKey: "replay-key-0000000001",
      eventType: "extended" as const,
      actorKind: "admin" as const,
    };

    it("treats an idempotency-key race as a replay", async () => {
      const fake = {
        insert: throwingInsert(uniqueViolation(REQUEST_EVENT_IDEMPOTENCY_KEY)),
        select: selectStub([[]]),
      };
      await expect(recordIdempotentEvent(fake as never, input)).resolves.toBeUndefined();
    });

    it("rethrows a violation of a different constraint", async () => {
      const error = uniqueViolation("other_idx");
      const fake = { insert: throwingInsert(error), select: selectStub([[]]) };
      await expect(recordIdempotentEvent(fake as never, input)).rejects.toBe(error);
    });
  });

  describe("recordDataDisclosure", () => {
    it("treats an idempotency-key race as success", async () => {
      const fake = {
        insert: throwingInsert(uniqueViolation(DATA_DISCLOSURE_EVENT_IDEMPOTENCY_KEY)),
      };
      await expect(
        recordDataDisclosure({ ...disclosure, idempotencyKey: "op-1" }, fake as never),
      ).resolves.toBeUndefined();
    });

    it("rethrows the idempotency-key violation when the write carried no key", async () => {
      const error = uniqueViolation(DATA_DISCLOSURE_EVENT_IDEMPOTENCY_KEY);
      const fake = { insert: throwingInsert(error) };
      await expect(recordDataDisclosure(disclosure, fake as never)).rejects.toBe(error);
    });

    it("rethrows a primary-key violation", async () => {
      const error = uniqueViolation("data_disclosure_event_pkey");
      const fake = { insert: throwingInsert(error) };
      await expect(
        recordDataDisclosure({ ...disclosure, idempotencyKey: "op-1" }, fake as never),
      ).rejects.toBe(error);
    });

    it("rethrows an error that only mentions a duplicate in its text", async () => {
      const error = new Error("duplicate something");
      const fake = { insert: throwingInsert(error) };
      await expect(
        recordDataDisclosure({ ...disclosure, idempotencyKey: "op-1" }, fake as never),
      ).rejects.toBe(error);
    });
  });
});
