/**
 * Cross-click protection for contribution mutations.
 *
 * Two records exist per submission: a short *lock* keyed by user + element +
 * operation, which stops a second concurrent attempt, and a longer
 * *idempotency* record keyed by user + operation + the client's UUID, which
 * replays the original sanitized outcome instead of writing twice.
 *
 * Every key is an HMAC-SHA-256 digest under a server-only secret, and every
 * value holds only public result ids, trusted URLs and timestamps — no token,
 * comment, source detail, note text, tag, place name or coordinate.
 *
 * Redis is used when configured, with a bounded in-memory fallback so a single
 * instance still works. Correctness never depends on it: OSM's exact element
 * version remains the cross-instance data-safety boundary.
 */
import { createHmac, randomUUID } from "node:crypto";
import type { OsmContributionPublishResult, OsmElementRef, OsmNoteResult } from "@openmapx/core";

/** A crashed worker must not wedge a person out for long. */
export const LOCK_TTL_SECONDS = 120;
/** A successful publish stays replayable for a day. */
export const SUCCESS_TTL_SECONDS = 24 * 60 * 60;
/** An ambiguous create is terminal, but only briefly. */
export const AMBIGUOUS_OUTCOME_TTL_SECONDS = 120;
/** Bound on in-memory entries; oldest expiring entries are evicted first. */
const MAX_MEMORY_ENTRIES = 20_000;

export type SubmissionOperation = "publish" | "note";

export type StoredOutcome =
  | { kind: "success"; at: string; result: OsmContributionPublishResult | OsmNoteResult }
  | {
      kind: "terminal";
      at: string;
      code: "AMBIGUOUS_RESULT";
      inspect?: { changesetUrl?: string; elementUrl?: string };
    };

export interface SubmissionIdentity {
  userId: string;
  ref: OsmElementRef;
  operation: SubmissionOperation;
}

export type BeginResult =
  | { status: "acquired"; lease: string }
  | { status: "in_progress" }
  | { status: "replay"; outcome: StoredOutcome };

/** The minimal ioredis surface this guard uses. */
export interface SubmissionGuardRedis {
  set(
    key: string,
    value: string,
    mode: "EX",
    ttlSeconds: number,
    nx?: "NX",
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, key: string, value: string): Promise<unknown>;
}

export interface SubmissionGuard {
  begin(input: SubmissionIdentity & { idempotencyKey: string }): Promise<BeginResult>;
  storeOutcome(
    input: SubmissionIdentity & { idempotencyKey: string; outcome: StoredOutcome },
  ): Promise<void>;
  release(input: SubmissionIdentity & { idempotencyKey: string; lease: string }): Promise<void>;
}

/**
 * Delete only when the stored value still matches our lease, so an expired
 * worker cannot free a newer holder's lock.
 *
 * This is Redis's `EVAL` (a server-side Lua script), not JavaScript `eval`. The
 * script is a fixed constant with nothing interpolated into it; the key and the
 * lease travel as separate `KEYS`/`ARGV` arguments, which is exactly the
 * mechanism that keeps them out of the executed program.
 */
const COMPARE_AND_DELETE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

interface Store {
  setIfAbsent(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  deleteIfMatches(key: string, value: string): Promise<void>;
}

function createMemoryStore(now: () => number): Store {
  const entries = new Map<string, { value: string; expiresAt: number }>();

  function prune(): void {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(key);
    }
    while (entries.size > MAX_MEMORY_ENTRIES) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  function read(key: string): string | null {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  }

  return {
    async setIfAbsent(key, value, ttlSeconds) {
      prune();
      if (read(key) !== null) return false;
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
      return true;
    },
    async get(key) {
      return read(key);
    },
    async set(key, value, ttlSeconds) {
      prune();
      entries.set(key, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    async deleteIfMatches(key, value) {
      if (read(key) === value) entries.delete(key);
    },
  };
}

function createRedisStore(redis: SubmissionGuardRedis, fallback: Store): Store {
  return {
    async setIfAbsent(key, value, ttlSeconds) {
      try {
        return (await redis.set(key, value, "EX", ttlSeconds, "NX")) === "OK";
      } catch {
        return fallback.setIfAbsent(key, value, ttlSeconds);
      }
    },
    async get(key) {
      try {
        return await redis.get(key);
      } catch {
        return fallback.get(key);
      }
    },
    async set(key, value, ttlSeconds) {
      try {
        await redis.set(key, value, "EX", ttlSeconds);
      } catch {
        await fallback.set(key, value, ttlSeconds);
      }
    },
    async deleteIfMatches(key, value) {
      try {
        await redis.eval(COMPARE_AND_DELETE, 1, key, value);
      } catch {
        await fallback.deleteIfMatches(key, value);
      }
    },
  };
}

export interface SubmissionGuardDeps {
  secret: string;
  now?: () => number;
  redis?: SubmissionGuardRedis;
}

export function createSubmissionGuard(deps: SubmissionGuardDeps): SubmissionGuard {
  const now = deps.now ?? (() => Date.now());
  const memory = createMemoryStore(now);
  const store = deps.redis ? createRedisStore(deps.redis, memory) : memory;

  function digest(kind: string, parts: readonly string[]): string {
    const hmac = createHmac("sha256", deps.secret);
    hmac.update(kind);
    for (const part of parts) {
      // Escaped, never a literal control byte in source: a raw NUL here made
      // git treat this file as binary and hid its diff from review.
      hmac.update("\u0000");
      hmac.update(part);
    }
    return `osmc:${kind}:${hmac.digest("hex")}`;
  }

  function lockKey(identity: SubmissionIdentity): string {
    return digest("lock", [
      identity.userId,
      identity.operation,
      identity.ref.type,
      String(identity.ref.id),
    ]);
  }

  function idempotencyKey(identity: SubmissionIdentity, clientKey: string): string {
    return digest("idem", [identity.userId, identity.operation, clientKey]);
  }

  function outcomeTtl(outcome: StoredOutcome): number {
    return outcome.kind === "success" ? SUCCESS_TTL_SECONDS : AMBIGUOUS_OUTCOME_TTL_SECONDS;
  }

  return {
    async begin(input) {
      const stored = await store.get(idempotencyKey(input, input.idempotencyKey));
      if (stored !== null) {
        try {
          // First request wins: the original outcome is replayed verbatim.
          return { status: "replay", outcome: JSON.parse(stored) as StoredOutcome };
        } catch {
          // A corrupt record is not a licence to double-write, but it is also
          // not evidence of a prior success — fall through and take the lock.
        }
      }
      const lease = randomUUID();
      const acquired = await store.setIfAbsent(lockKey(input), lease, LOCK_TTL_SECONDS);
      return acquired ? { status: "acquired", lease } : { status: "in_progress" };
    },

    async storeOutcome(input) {
      await store.set(
        idempotencyKey(input, input.idempotencyKey),
        JSON.stringify(input.outcome),
        outcomeTtl(input.outcome),
      );
    },

    async release(input) {
      await store.deleteIfMatches(lockKey(input), input.lease);
    },
  };
}
