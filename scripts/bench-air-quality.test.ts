import { describe, expect, it } from "vitest";

import { percentile, runBenchmark } from "./bench-air-quality.js";

describe("air-quality benchmark harness", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 100], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 100], 0.95)).toBe(100);
  });

  it("excludes warm-up samples and respects concurrency", async () => {
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const result = await runBenchmark({
      name: "current",
      requests: 12,
      warmups: 3,
      concurrency: 4,
      inject: async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return { statusCode: 200, payloadBytes: 100 + calls };
      },
    });
    expect(calls).toBe(15);
    expect(result.samples).toBe(12);
    expect(maximumActive).toBe(4);
    expect(result.maximumPayloadBytes).toBe(115);
  });

  it("rejects non-200 responses and oversized JSON", async () => {
    await expect(
      runBenchmark({
        name: "bad-status",
        requests: 1,
        warmups: 0,
        concurrency: 1,
        inject: async () => ({ statusCode: 503, payloadBytes: 2 }),
      }),
    ).rejects.toThrow("status 503");
    await expect(
      runBenchmark({
        name: "oversized",
        requests: 1,
        warmups: 0,
        concurrency: 1,
        maximumPayloadBytes: 10,
        inject: async () => ({ statusCode: 200, payloadBytes: 11 }),
      }),
    ).rejects.toThrow("payload limit");
  });
});
