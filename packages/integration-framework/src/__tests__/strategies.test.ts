import { describe, expect, it, vi } from "vitest";
import { ProviderCancelledError } from "../provider-execution";
import { createFallbackChain, createMergeAll } from "../strategies";

describe("provider strategies", () => {
  it("aborts a timed-out fallback provider before trying the next", async () => {
    vi.useFakeTimers();
    let firstAborted = false;
    const fallback = createFallbackChain(
      () => ["slow", "fast"],
      async (provider, { signal }) => {
        if (provider === "fast") return ["result"];
        return new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              firstAborted = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      { timeoutMs: 100 },
    );
    const work = fallback();

    await vi.advanceTimersByTimeAsync(100);

    await expect(work).resolves.toEqual(["result"]);
    expect(firstAborted).toBe(true);
    vi.useRealTimers();
  });

  it("caps merge fan-out", async () => {
    let active = 0;
    let peak = 0;
    const merge = createMergeAll(
      () => [0, 1, 2, 3, 4, 5],
      async (provider) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return [provider];
      },
      { maxConcurrency: 2 },
    );

    await expect(merge(6)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("does not turn caller cancellation into fallback or a partial merge", async () => {
    const controller = new AbortController();
    controller.abort();
    const fallback = createFallbackChain(
      () => ["one", "two"],
      async () => ["unexpected"],
    );
    const merge = createMergeAll(
      () => ["one", "two"],
      async () => ["unexpected"],
    );

    await expect(fallback({ signal: controller.signal })).rejects.toBeInstanceOf(
      ProviderCancelledError,
    );
    await expect(merge(2, { signal: controller.signal })).rejects.toBeInstanceOf(
      ProviderCancelledError,
    );
  });
});
