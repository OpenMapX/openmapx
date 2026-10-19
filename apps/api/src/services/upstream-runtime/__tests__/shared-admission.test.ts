import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedisUpstreamRuntime, type UpstreamRedisClient } from "../index";

function runtime(evalCommand: UpstreamRedisClient["eval"]) {
  return createRedisUpstreamRuntime(
    { get: async () => null, set: async () => "OK", del: async () => 0, eval: evalCommand },
    { namespace: "test", integrationId: "one" },
  );
}
const identity = { scope: "origin/client", key: "journey" };
const policy = { id: "trip", limit: 500, durationMs: 60_000, minIntervalMs: 7 };

afterEach(() => vi.useRealTimers());

describe("shared admission storage boundary", () => {
  it("fails closed on unavailable storage and rejects failed cooldown writes", async () => {
    const subject = runtime(async () => {
      throw new Error("private connection details");
    });
    expect(await subject.admitSharedRequest({ ...identity, policy })).toEqual({
      allowed: false,
      reason: "store_unavailable",
      retryAfterMs: null,
    });
    await expect(subject.deferSharedRequests({ ...identity, delayMs: 100 })).rejects.toThrow(
      "Shared upstream store unavailable",
    );
  });

  it("bounds hung admissions and cooldown writes to three seconds", async () => {
    vi.useFakeTimers();
    const subject = runtime(() => new Promise(() => {}));
    const admission = subject.admitSharedRequest({ ...identity, policy });
    const cooldown = expect(
      subject.deferSharedRequests({ ...identity, delayMs: 10 }),
    ).rejects.toThrow("Shared upstream store unavailable");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await admission).toEqual({
      allowed: false,
      reason: "store_unavailable",
      retryAfterMs: null,
    });
    await cooldown;
  });

  it("cancels a hung operation promptly and never submits an already aborted request", async () => {
    const command = vi.fn(() => new Promise<unknown>(() => {}));
    const subject = runtime(command);
    const controller = new AbortController();
    const admission = expect(
      subject.admitSharedRequest({ ...identity, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await admission;
    await expect(
      subject.deferSharedRequests({ ...identity, delayMs: 1, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    "{}",
    '{"allowed":true,"remaining":-1}',
    '{"allowed":false,"reason":"quota","retryAfterMs":null}',
  ])("fails closed on malformed store replies: %s", async (reply) => {
    expect(await runtime(async () => reply).admitSharedRequest({ ...identity, policy })).toEqual({
      allowed: false,
      reason: "store_unavailable",
      retryAfterMs: null,
    });
  });

  it.each([
    { scope: " " },
    { key: "" },
    { policy: { ...policy, id: "" } },
    { policy: { ...policy, limit: 0 } },
    { policy: { ...policy, limit: 1.5 } },
    { policy: { ...policy, durationMs: Infinity } },
    { policy: { ...policy, durationMs: Number.MAX_SAFE_INTEGER + 1 } },
    { policy: { ...policy, minIntervalMs: -1 } },
  ])("rejects invalid identity/policy before storage: %j", async (invalid) => {
    const command = vi.fn(async () => "{}");
    await expect(
      runtime(command).admitSharedRequest({ ...identity, policy, ...invalid }),
    ).rejects.toThrow();
    expect(command).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid cooldown: %s",
    async (delayMs) => {
      await expect(
        runtime(async () => 0).deferSharedRequests({ ...identity, delayMs }),
      ).rejects.toThrow();
    },
  );
});
