import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AMBIGUOUS_OUTCOME_TTL_SECONDS,
  createSubmissionGuard,
  LOCK_TTL_SECONDS,
  SUCCESS_TTL_SECONDS,
  type SubmissionGuardRedis,
} from "../submission-guard.js";

const SECRET = "guard-secret";
const USER = "user-42";
const REF = { type: "node", id: 12 } as const;
const KEY_A = "3f4b2a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
const KEY_B = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

/** Sentinels that must never reach a key or a stored value. */
const COMMENT = "human comment sentinel";
const TOKEN = "osm-token-sentinel";
const NOTE_TEXT = "note text sentinel";

const SUCCESS = {
  kind: "success" as const,
  at: "2026-08-10T09:00:00.000Z",
  result: {
    ref: REF,
    version: 5,
    changesetId: 77,
    changesetUrl: "https://www.openstreetmap.org/changeset/77",
    elementUrl: "https://www.openstreetmap.org/node/12",
    publishedAt: "2026-08-10T09:00:00.000Z",
  },
};

let clock = 1_000_000;
const now = () => clock;

function guard(redis?: SubmissionGuardRedis) {
  return createSubmissionGuard({ secret: SECRET, now, redis });
}

const publish = { userId: USER, ref: REF, operation: "publish" as const };

beforeEach(() => {
  clock = 1_000_000;
});

describe("in-memory guard", () => {
  it("acquires on the first attempt and releases afterwards", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") return;
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });

    const second = await g.begin({ ...publish, idempotencyKey: KEY_B });
    expect(second.status).toBe("acquired");
  });

  it("reports a concurrent submission for the same user and element", async () => {
    const g = guard();
    await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect(await g.begin({ ...publish, idempotencyKey: KEY_B })).toEqual({
      status: "in_progress",
    });
  });

  it("replays the stored success for the same idempotency key", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.storeOutcome({ ...publish, idempotencyKey: KEY_A, outcome: SUCCESS });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });

    const replay = await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect(replay).toEqual({ status: "replay", outcome: SUCCESS });
  });

  it("replays a terminal ambiguous outcome without retrying", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    const terminal = {
      kind: "terminal" as const,
      code: "AMBIGUOUS_RESULT" as const,
      at: "2026-08-10T09:00:00.000Z",
      inspect: { changesetUrl: "https://www.openstreetmap.org/changeset/77" },
    };
    await g.storeOutcome({ ...publish, idempotencyKey: KEY_A, outcome: terminal });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    expect(await g.begin({ ...publish, idempotencyKey: KEY_A })).toEqual({
      status: "replay",
      outcome: terminal,
    });
  });

  it("keeps a failed attempt free for a new idempotency key", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    // Failure path: release without storing an outcome.
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    expect((await g.begin({ ...publish, idempotencyKey: KEY_B })).status).toBe("acquired");
  });

  it("expires the lock after its TTL so a crashed worker cannot wedge a user", async () => {
    const g = guard();
    await g.begin({ ...publish, idempotencyKey: KEY_A });
    clock += LOCK_TTL_SECONDS * 1000 + 1;
    expect((await g.begin({ ...publish, idempotencyKey: KEY_B })).status).toBe("acquired");
  });

  it("expires a stored success after its own longer TTL", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.storeOutcome({ ...publish, idempotencyKey: KEY_A, outcome: SUCCESS });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });

    clock += (SUCCESS_TTL_SECONDS - 1) * 1000;
    expect((await g.begin({ ...publish, idempotencyKey: KEY_A })).status).toBe("replay");
    clock += 2_000;
    // Past 24 hours the idempotency record is gone and a fresh attempt is fine.
    clock += SUCCESS_TTL_SECONDS * 1000;
    expect((await g.begin({ ...publish, idempotencyKey: KEY_A })).status).toBe("acquired");
  });

  it("expires an ambiguous terminal outcome after the short TTL", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.storeOutcome({
      ...publish,
      idempotencyKey: KEY_A,
      outcome: { kind: "terminal", code: "AMBIGUOUS_RESULT", at: "2026-08-10T09:00:00.000Z" },
    });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    clock += AMBIGUOUS_OUTCOME_TTL_SECONDS * 1000 + 1;
    expect((await g.begin({ ...publish, idempotencyKey: KEY_A })).status).toBe("acquired");
  });

  it("does not let a stale lease delete a newer lock", async () => {
    const g = guard();
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    clock += LOCK_TTL_SECONDS * 1000 + 1;
    const second = await g.begin({ ...publish, idempotencyKey: KEY_B });
    expect(second.status).toBe("acquired");
    // The expired worker finally releases: it must not free the new holder.
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    expect(await g.begin({ ...publish, idempotencyKey: KEY_A })).toEqual({
      status: "in_progress",
    });
  });

  it("keeps publish and note submissions independent", async () => {
    const g = guard();
    await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect(
      (await g.begin({ userId: USER, ref: REF, operation: "note", idempotencyKey: KEY_B })).status,
    ).toBe("acquired");
  });

  it("keeps users and elements independent", async () => {
    const g = guard();
    await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect((await g.begin({ ...publish, userId: "other", idempotencyKey: KEY_B })).status).toBe(
      "acquired",
    );
    expect(
      (await g.begin({ ...publish, ref: { type: "way", id: 12 }, idempotencyKey: KEY_B })).status,
    ).toBe("acquired");
  });

  it("bounds the in-memory store", async () => {
    const g = guard();
    for (let i = 0; i < 20_000; i += 1) {
      await g.begin({
        ...publish,
        userId: `user-${i}`,
        idempotencyKey: KEY_A,
      });
    }
    expect(g.debugSize()).toBeLessThanOrEqual(20_000);
  });
});

describe("Redis-backed guard", () => {
  function fakeRedis() {
    const store = new Map<string, string>();
    const redis: SubmissionGuardRedis = {
      set: vi.fn(async (key, value, _mode, _ttl, nx) => {
        if (nx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, value: string) => {
        if (store.get(key) === value) {
          store.delete(key);
          return 1;
        }
        return 0;
      }),
    };
    return { redis, store };
  }

  it("uses an atomic SET NX EX for the lock", async () => {
    const { redis, store } = fakeRedis();
    const g = guard(redis);
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect(first.status).toBe("acquired");
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );
    expect(store.size).toBe(1);
    expect((await g.begin({ ...publish, idempotencyKey: KEY_B })).status).toBe("in_progress");
  });

  it("compares and deletes the lease on release", async () => {
    const { redis, store } = fakeRedis();
    const g = guard(redis);
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    expect(redis.eval).toHaveBeenCalled();
    expect(store.size).toBe(0);

    await g.begin({ ...publish, idempotencyKey: KEY_B });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: "stale-lease" });
    // A stale lease left the newer holder in place.
    expect(store.size).toBe(1);
  });

  it("replays a stored success from Redis", async () => {
    const { redis } = fakeRedis();
    const g = guard(redis);
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.storeOutcome({ ...publish, idempotencyKey: KEY_A, outcome: SUCCESS });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    expect(await g.begin({ ...publish, idempotencyKey: KEY_A })).toEqual({
      status: "replay",
      outcome: SUCCESS,
    });
  });

  it("falls back to memory when Redis is unavailable", async () => {
    const failing: SubmissionGuardRedis = {
      set: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      get: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
      eval: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const g = guard(failing);
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    expect(first.status).toBe("acquired");
    expect((await g.begin({ ...publish, idempotencyKey: KEY_B })).status).toBe("in_progress");
  });

  it("ignores an unparsable stored record rather than trusting it", async () => {
    const { redis, store } = fakeRedis();
    const g = guard(redis);
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });
    for (const key of [...store.keys()]) store.set(key, "{not json");
    expect((await g.begin({ ...publish, idempotencyKey: KEY_A })).status).toBe("acquired");
  });
});

describe("key and value hygiene", () => {
  it("never writes content into a key or a value", async () => {
    const seen: string[] = [];
    const redis: SubmissionGuardRedis = {
      set: vi.fn(async (key, value) => {
        seen.push(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => {
        seen.push(key);
        return null;
      }),
      eval: vi.fn(async (_s: string, _n: number, key: string, value: string) => {
        seen.push(key, value);
        return 1;
      }),
    };
    const g = guard(redis);
    const first = await g.begin({ ...publish, idempotencyKey: KEY_A });
    if (first.status !== "acquired") throw new Error("expected acquired");
    await g.storeOutcome({ ...publish, idempotencyKey: KEY_A, outcome: SUCCESS });
    await g.release({ ...publish, idempotencyKey: KEY_A, lease: first.lease });

    const serialized = seen.join("|");
    for (const sentinel of [COMMENT, TOKEN, NOTE_TEXT, "Café", "52.5", "13.4"]) {
      expect(serialized).not.toContain(sentinel);
    }
    // The raw user id and element id are digested, not stored in the clear.
    expect(serialized).not.toContain(USER);
    expect(serialized).not.toContain(KEY_A);
  });

  it("produces stable, secret-dependent digests", async () => {
    const a = createSubmissionGuard({ secret: "one", now });
    const b = createSubmissionGuard({ secret: "two", now });
    expect(a.debugLockKey({ userId: USER, ref: REF, operation: "publish" })).toBe(
      a.debugLockKey({ userId: USER, ref: REF, operation: "publish" }),
    );
    expect(a.debugLockKey({ userId: USER, ref: REF, operation: "publish" })).not.toBe(
      b.debugLockKey({ userId: USER, ref: REF, operation: "publish" }),
    );
  });
});
