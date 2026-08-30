import { describe, expect, it, vi } from "vitest";
import { loadOpenAQCached, OPENAQ_SERIES_TTL } from "./cache-policy.js";
import { MemoryUpstreamRuntime } from "./test-helpers.js";

describe("OpenAQ soft cache policy", () => {
  it("coalesces misses, writes only successful refreshes, and releases its lease", async () => {
    const runtime = new MemoryUpstreamRuntime(() => 1_000);
    const refresh = vi.fn(async () => ({ observedAt: "2026-08-30T12:00:00Z" }));
    const result = await loadOpenAQCached({
      runtime,
      key: "series",
      ttl: OPENAQ_SERIES_TTL,
      signal: new AbortController().signal,
      refresh,
    });
    expect(result.state).toBe("miss");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(runtime.leases.size).toBe(0);
    await expect(runtime.read("series", 1_001)).resolves.toMatchObject({ state: "fresh" });
  });

  it("serves hard-expired cache only as stale-if-error", async () => {
    let now = 1_000;
    const runtime = new MemoryUpstreamRuntime(() => now);
    await runtime.write("series", { old: true }, { softMs: 10, hardMs: 20, staleIfErrorMs: 100 });
    now = 1_050;
    const result = await loadOpenAQCached({
      runtime,
      key: "series",
      ttl: OPENAQ_SERIES_TTL,
      signal: new AbortController().signal,
      refresh: async () => {
        throw new Error("upstream");
      },
    });
    expect(result).toEqual({ value: { old: true }, state: "stale-if-error" });
    expect(runtime.leases.size).toBe(0);
  });

  it("serves soft-stale evidence before its single leased refresh completes", async () => {
    let now = 1_000;
    const runtime = new MemoryUpstreamRuntime(() => now);
    await runtime.write(
      "series",
      { old: true },
      { softMs: 10, hardMs: 100, staleIfErrorMs: 1_000 },
    );
    now = 1_020;
    let finish: ((value: { old: boolean }) => void) | undefined;
    const refresh = new Promise<{ old: boolean }>((resolve) => {
      finish = resolve;
    });
    const result = await loadOpenAQCached({
      runtime,
      key: "series",
      ttl: OPENAQ_SERIES_TTL,
      signal: new AbortController().signal,
      refresh: () => refresh,
    });
    expect(result).toEqual({ value: { old: true }, state: "stale" });
    expect(runtime.leases.size).toBe(1);
    finish?.({ old: false });
    await refresh;
    await vi.waitFor(() => expect(runtime.leases.size).toBe(0));
  });

  it("does not overwrite evidence or leak a lease after cancellation", async () => {
    const runtime = new MemoryUpstreamRuntime(() => 1_000);
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadOpenAQCached({
        runtime,
        key: "cancel",
        ttl: OPENAQ_SERIES_TTL,
        signal: controller.signal,
        refresh: async () => ({ new: true }),
      }),
    ).rejects.toThrow();
    expect(runtime.values.has("cancel")).toBe(false);
    expect(runtime.leases.size).toBe(0);
  });
});
