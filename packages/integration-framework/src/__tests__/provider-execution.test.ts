import { describe, expect, it, vi } from "vitest";
import {
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
});
