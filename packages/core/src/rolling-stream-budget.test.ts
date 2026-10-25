import { describe, expect, it } from "vitest";
import { RollingStreamBudget } from "./rolling-stream-budget";

function budget(overrides: Partial<ConstructorParameters<typeof RollingStreamBudget>[0]> = {}) {
  let now = 0;
  return {
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
    value: new RollingStreamBudget({
      maxBytesPerKey: 100,
      windowMs: 10_000,
      maxConcurrentPerKey: 1,
      maxConcurrentGlobal: 2,
      now: () => now,
      ...overrides,
    }),
  };
}

describe("RollingStreamBudget", () => {
  it("distinguishes per-key and process-global concurrency exhaustion", () => {
    const { value } = budget();
    const first = value.tryAcquire("client-a");
    expect(first.allowed).toBe(true);
    expect(value.tryAcquire("client-a")).toEqual({
      allowed: false,
      reason: "key-concurrency",
      retryAfterSeconds: 10,
    });

    const second = value.tryAcquire("client-b");
    expect(second.allowed).toBe(true);
    expect(value.tryAcquire("client-c")).toEqual({
      allowed: false,
      reason: "global-concurrency",
      retryAfterSeconds: 10,
    });
  });

  it("admits the exact byte boundary and refills deterministically", () => {
    const { advance, value } = budget({ maxConcurrentPerKey: 2 });
    const first = value.tryAcquire("client-a");
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected first lease");
    expect(first.lease.consume(100)).toEqual({ allowed: true, retryAfterSeconds: 0 });

    const second = value.tryAcquire("client-a");
    expect(second.allowed).toBe(true);
    if (!second.allowed) throw new Error("expected second lease");
    expect(second.lease.consume(1)).toEqual({
      allowed: false,
      reason: "bytes",
      retryAfterSeconds: 1,
    });

    advance(5_000);
    expect(second.lease.consume(50)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("bounds retry metadata when one response exceeds the entire byte allowance", () => {
    const { value } = budget();
    const admission = value.tryAcquire("client-a");
    expect(admission.allowed).toBe(true);
    if (!admission.allowed) throw new Error("expected lease");
    expect(admission.lease.consume(101)).toEqual({
      allowed: false,
      reason: "bytes",
      retryAfterSeconds: 10,
    });
  });

  it("refunds a byte reservation when delivery never starts", () => {
    const { value } = budget({ maxConcurrentPerKey: 2 });
    const first = value.tryAcquire("client-a");
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected first lease");
    expect(first.lease.consume(100)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    first.lease.refund(40);

    const second = value.tryAcquire("client-a");
    expect(second.allowed).toBe(true);
    if (!second.allowed) throw new Error("expected second lease");
    expect(second.lease.consume(40)).toEqual({ allowed: true, retryAfterSeconds: 0 });
  });

  it("releases active counters exactly once", () => {
    const { value } = budget({ maxConcurrentPerKey: 2 });
    const first = value.tryAcquire("client-a");
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected lease");
    first.lease.release();
    first.lease.release();

    expect(value.tryAcquire("client-b").allowed).toBe(true);
    expect(value.tryAcquire("client-c").allowed).toBe(true);
    expect(value.tryAcquire("client-d")).toMatchObject({
      allowed: false,
      reason: "global-concurrency",
    });
  });

  it.each([
    ["maxBytesPerKey", 0],
    ["windowMs", -1],
    ["maxConcurrentPerKey", 1.5],
    ["maxConcurrentGlobal", Number.POSITIVE_INFINITY],
  ] as const)("rejects an invalid %s option", (name, invalid) => {
    expect(
      () =>
        budget({
          [name]: invalid,
        }).value,
    ).toThrow(`${name} must be a positive safe integer`);
  });
});
