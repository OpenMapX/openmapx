interface KeyBudget {
  active: number;
  lastRefill: number;
  tokens: number;
}

export interface RollingStreamBudgetOptions {
  maxBytesPerKey: number;
  windowMs: number;
  maxConcurrentPerKey: number;
  maxConcurrentGlobal: number;
  now?: () => number;
}

export type RollingStreamBudgetRejectionReason = "key-concurrency" | "global-concurrency" | "bytes";

export type RollingStreamBudgetRejection = {
  [Reason in RollingStreamBudgetRejectionReason]: {
    allowed: false;
    reason: Reason;
    retryAfterSeconds: number;
  };
}[RollingStreamBudgetRejectionReason];

export interface RollingStreamBudgetLease {
  consume(
    bytes: number,
  ):
    | { allowed: true; retryAfterSeconds: 0 }
    | Extract<RollingStreamBudgetRejection, { reason: "bytes" }>;
  refund(bytes: number): void;
  release(): void;
}

export type RollingStreamBudgetAdmission =
  | { allowed: true; lease: RollingStreamBudgetLease }
  | RollingStreamBudgetRejection;

/**
 * Per-process stream admission with keyed byte tokens and keyed/global active
 * ceilings. Callers choose the trust-worthy key; using one constant key makes
 * both concurrency and bytes process-global.
 */
export class RollingStreamBudget {
  private readonly keys = new Map<string, KeyBudget>();
  private readonly now: () => number;
  private readonly retryAfterSeconds: number;
  private activeGlobal = 0;
  private acquisitions = 0;

  constructor(private readonly options: RollingStreamBudgetOptions) {
    for (const name of [
      "maxBytesPerKey",
      "windowMs",
      "maxConcurrentPerKey",
      "maxConcurrentGlobal",
    ] as const) {
      const value = options[name];
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`RollingStreamBudget ${name} must be a positive safe integer`);
      }
    }
    this.now = options.now ?? Date.now;
    this.retryAfterSeconds = Math.max(1, Math.ceil(options.windowMs / 1_000));
  }

  tryAcquire(key: string): RollingStreamBudgetAdmission {
    const now = this.now();
    this.acquisitions += 1;
    if (this.acquisitions % 256 === 0) this.cleanup(now);
    if (this.activeGlobal >= this.options.maxConcurrentGlobal) {
      return this.reject("global-concurrency");
    }

    const keyBudget = this.key(key, now);
    if (keyBudget.active >= this.options.maxConcurrentPerKey) {
      return this.reject("key-concurrency");
    }

    keyBudget.active += 1;
    this.activeGlobal += 1;
    let released = false;
    return {
      allowed: true,
      lease: {
        consume: (bytes) => {
          if (released) throw new Error("RollingStreamBudget lease has already been released");
          return this.consume(keyBudget, bytes);
        },
        refund: (bytes) => {
          if (released) throw new Error("RollingStreamBudget lease has already been released");
          this.refund(keyBudget, bytes);
        },
        release: () => {
          if (released) return;
          released = true;
          keyBudget.active = Math.max(0, keyBudget.active - 1);
          this.activeGlobal = Math.max(0, this.activeGlobal - 1);
        },
      },
    };
  }

  private key(key: string, now: number): KeyBudget {
    const existing = this.keys.get(key);
    if (existing) return existing;
    const created = { active: 0, lastRefill: now, tokens: this.options.maxBytesPerKey };
    this.keys.set(key, created);
    return created;
  }

  private consume(
    key: KeyBudget,
    bytes: number,
  ):
    | { allowed: true; retryAfterSeconds: 0 }
    | Extract<RollingStreamBudgetRejection, { reason: "bytes" }> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("RollingStreamBudget bytes must be a non-negative safe integer");
    }
    if (bytes > this.options.maxBytesPerKey) {
      return { allowed: false, reason: "bytes", retryAfterSeconds: this.retryAfterSeconds };
    }

    const now = this.now();
    const elapsed = Math.max(0, now - key.lastRefill);
    key.tokens = Math.min(
      this.options.maxBytesPerKey,
      key.tokens + (elapsed / this.options.windowMs) * this.options.maxBytesPerKey,
    );
    key.lastRefill = now;
    if (key.tokens >= bytes) {
      key.tokens -= bytes;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const missing = bytes - key.tokens;
    const retryAfterSeconds = Math.max(
      1,
      Math.min(
        this.retryAfterSeconds,
        Math.ceil((missing / this.options.maxBytesPerKey) * this.retryAfterSeconds),
      ),
    );
    return { allowed: false, reason: "bytes", retryAfterSeconds };
  }

  private reject(reason: Exclude<RollingStreamBudgetRejectionReason, "bytes">) {
    return { allowed: false, reason, retryAfterSeconds: this.retryAfterSeconds } as const;
  }

  private refund(key: KeyBudget, bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("RollingStreamBudget refund must be a non-negative safe integer");
    }
    key.tokens = Math.min(this.options.maxBytesPerKey, key.tokens + bytes);
  }

  private cleanup(now: number): void {
    for (const [key, budget] of this.keys) {
      if (budget.active === 0 && now - budget.lastRefill > this.options.windowMs * 2) {
        this.keys.delete(key);
      }
    }
  }
}
