import { describe, expect, it, vi } from "vitest";
import { createLimiter } from "../concurrency.js";

describe("createLimiter", () => {
  it("rejects a non-positive or non-integer max", () => {
    expect(() => createLimiter(0)).toThrow();
    expect(() => createLimiter(-1)).toThrow();
    expect(() => createLimiter(1.5)).toThrow();
  });

  it("never exceeds the configured concurrency and still runs every task", async () => {
    const max = 3;
    const limit = createLimiter(max);
    let active = 0;
    let peak = 0;
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        limit(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
          return i;
        }),
      ),
    );
    expect(peak).toBeLessThanOrEqual(max);
    expect(results).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("frees a slot when a task rejects (a failure doesn't deadlock the queue)", async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    // The slot must have been released, so a subsequent task runs.
    await expect(limit(async () => "ok")).resolves.toBe("ok");
  });

  it("propagates a synchronous throw as a rejection", async () => {
    const limit = createLimiter(2);
    await expect(
      limit(() => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
  });

  it("queues work beyond the limit and runs it as slots free", async () => {
    const limit = createLimiter(2);
    const started: number[] = [];
    const release: Array<() => void> = [];
    const tasks = Array.from({ length: 4 }, (_, i) =>
      limit(async () => {
        started.push(i);
        await new Promise<void>((r) => release.push(r));
      }),
    );
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    release[0]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2]));
    release[1]();
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    for (const r of release) r();
    await Promise.all(tasks);
  });
});
