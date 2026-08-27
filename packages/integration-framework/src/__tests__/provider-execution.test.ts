import { describe, expect, it, vi } from "vitest";
import {
  mapSettledWithConcurrency,
  ProviderCancelledError,
  ProviderTimeoutError,
  runWithProviderDeadline,
} from "../provider-execution";

describe("provider execution", () => {
  it("actively aborts provider work at the deadline", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    const work = runWithProviderDeadline(
      ({ signal }) => {
        providerSignal = signal;
        return new Promise(() => {});
      },
      { timeoutMs: 1_200 },
    );
    const rejection = expect(work).rejects.toBeInstanceOf(ProviderTimeoutError);

    await vi.advanceTimersByTimeAsync(1_200);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("propagates caller cancellation distinctly from a timeout", async () => {
    const controller = new AbortController();
    const work = runWithProviderDeadline(() => new Promise(() => {}), {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    await expect(work).rejects.toBeInstanceOf(ProviderCancelledError);
  });

  it("caps parallel provider work and preserves input ordering", async () => {
    let active = 0;
    let peak = 0;
    const releases = new Map<number, () => void>();
    const started: number[] = [];
    const work = mapSettledWithConcurrency([0, 1, 2, 3, 4], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(value);
      await new Promise<void>((resolve) => releases.set(value, resolve));
      active -= 1;
      return value * 2;
    });
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    releases.get(0)?.();
    releases.get(1)?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    releases.get(2)?.();
    releases.get(3)?.();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3, 4]));
    releases.get(4)?.();

    const results = await work;
    expect(peak).toBe(2);
    expect(results.map((result) => result.status === "fulfilled" && result.value)).toEqual([
      0, 2, 4, 6, 8,
    ]);
  });
});
