import { createHash } from "node:crypto";
import type {
  SharedRequestDecision,
  SharedRequestIdentity,
  SharedRequestPolicy,
} from "@openmapx/integration-framework";
import type { UpstreamRedisClient } from "./index";
import { SHARED_REQUEST_SCRIPT } from "./scripts";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validateIdentity(identity: SharedRequestIdentity): void {
  if (!identity.scope?.trim() || !identity.key?.trim()) {
    throw new Error("Shared upstream scope and key must be nonempty");
  }
}

function validateInteger(value: number, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error("Shared upstream values must be safe integers within range");
  }
}

function validatePolicy(policy: SharedRequestPolicy): void {
  if (!policy.id?.trim()) throw new Error("Shared upstream policy id must be nonempty");
  validateInteger(policy.limit, 1);
  validateInteger(policy.durationMs, 1);
  validateInteger(policy.minIntervalMs, 0);
}

const unavailable = (): SharedRequestDecision => ({
  allowed: false,
  reason: "store_unavailable",
  retryAfterMs: null,
});

function decodeInteger(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("Invalid shared upstream integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Invalid shared upstream integer");
  return parsed;
}

function decode(raw: unknown): SharedRequestDecision {
  // Decimal strings avoid rounding in Lua cjson and Redis clients' integer parsers.
  if (Array.isArray(raw)) {
    if (raw[0] === 1 && raw.length === 1) return { allowed: true, remaining: null };
    if (raw[0] === 1 && raw.length === 2) {
      return { allowed: true, remaining: decodeInteger(raw[1]) };
    }
    if (raw[0] === 0 && raw.length === 3) {
      const reason: unknown = raw[1];
      const retryAfterMs = decodeInteger(raw[2]);
      if (
        (reason === "quota" || reason === "spacing" || reason === "cooldown") &&
        retryAfterMs > 0
      ) {
        return { allowed: false, reason, retryAfterMs };
      }
    }
  }
  throw new Error("Invalid shared upstream response");
}

async function bounded<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Shared upstream store unavailable")), 3_000);
      abort = () => reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      // A dispatched Redis command cannot be recalled. Late completion never admits this caller.
      Promise.resolve()
        .then(() => {
          signal?.throwIfAborted();
          return operation();
        })
        .then(resolve, reject);
    });
  } finally {
    clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
  }
}

export function createSharedAdmission(redis: UpstreamRedisClient, namespace: string) {
  const keyFor = ({ scope, key }: SharedRequestIdentity) =>
    `upstream-shared:${namespace}:${digest(JSON.stringify([scope, key]))}`;
  return {
    async admitSharedRequest(
      input: SharedRequestIdentity & { policy?: SharedRequestPolicy; signal?: AbortSignal },
    ): Promise<SharedRequestDecision> {
      validateIdentity(input);
      if (input.policy) validatePolicy(input.policy);
      try {
        const policy = input.policy;
        const raw = await bounded(
          () =>
            redis.eval(
              SHARED_REQUEST_SCRIPT,
              1,
              keyFor(input),
              "admit",
              policy ? digest(policy.id) : "",
              String(policy?.limit ?? 0),
              String(policy?.durationMs ?? 0),
              String(policy?.minIntervalMs ?? 0),
            ),
          input.signal,
        );
        input.signal?.throwIfAborted();
        return decode(raw);
      } catch {
        input.signal?.throwIfAborted();
        return unavailable();
      }
    },
    async deferSharedRequests(
      input: SharedRequestIdentity & { delayMs: number; signal?: AbortSignal },
    ): Promise<void> {
      validateIdentity(input);
      validateInteger(input.delayMs, 0);
      try {
        const result = await bounded(
          () => redis.eval(SHARED_REQUEST_SCRIPT, 1, keyFor(input), "defer", String(input.delayMs)),
          input.signal,
        );
        if (result !== 1) throw new Error("Invalid shared upstream response");
      } catch {
        input.signal?.throwIfAborted();
        throw new Error("Shared upstream store unavailable");
      }
    },
  };
}
