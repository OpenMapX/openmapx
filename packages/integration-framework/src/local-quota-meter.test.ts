import { describe, expect, it } from "vitest";
import { createLocalQuotaMeter } from "./local-quota-meter";

const windows = [
  { id: "minute", limit: 2, durationMs: 60_000 },
  { id: "day", limit: 3, durationMs: 86_400_000 },
];

describe("createLocalQuotaMeter", () => {
  it("charges every window only when all have room", () => {
    const meter = createLocalQuotaMeter();
    const at = 10 * 86_400_000;
    const consume = (now: number) => meter.consume({ bucket: "engine", cost: 1, windows }, now);

    expect(consume(at).allowed).toBe(true);
    expect(consume(at + 1).allowed).toBe(true);
    const minuteSpent = consume(at + 2);
    expect(minuteSpent).toMatchObject({ allowed: false, retryAt: at + 60_000 });
    // The refused call charged nothing, so the day window still has one left.
    expect(consume(at + 60_000).allowed).toBe(true);
    expect(consume(at + 120_000)).toMatchObject({ allowed: false, retryAt: at + 86_400_000 });
  });

  it("keeps buckets apart and bounds the number of counters", () => {
    const meter = createLocalQuotaMeter({ maxCounters: 2 });
    const one = [{ id: "w", limit: 1, durationMs: 60_000 }];
    expect(meter.consume({ bucket: "a", cost: 1, windows: one }, 0).allowed).toBe(true);
    expect(meter.consume({ bucket: "b", cost: 1, windows: one }, 0).allowed).toBe(true);
    expect(meter.consume({ bucket: "a", cost: 1, windows: one }, 0).allowed).toBe(false);
    expect(meter.consume({ bucket: "c", cost: 1, windows: one }, 0).allowed).toBe(true);
    // "a" was the oldest counter and made room for "c"; "b" is still counted.
    expect(meter.consume({ bucket: "b", cost: 1, windows: one }, 0).allowed).toBe(false);
    expect(meter.consume({ bucket: "a", cost: 1, windows: one }, 0).allowed).toBe(true);
  });
});
