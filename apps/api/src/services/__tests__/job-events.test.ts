import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JobEventBus, TERMINAL_JOB_STATUSES } from "../job-events";

function log(seq: number) {
  return {
    type: "log" as const,
    id: `log-${seq}`,
    seq,
    stream: "stdout",
    line: `line ${seq}`,
    createdAt: "2026-09-06T08:00:00.000Z",
  };
}

describe("JobEventBus", () => {
  it("assigns monotonic cursors per job starting at 1", () => {
    const bus = new JobEventBus();
    expect(bus.publish("a", log(0)).cursor).toBe(1);
    expect(bus.publish("a", log(1)).cursor).toBe(2);
    expect(bus.publish("b", log(0)).cursor).toBe(1);
    expect(bus.latestCursor("a")).toBe(2);
    expect(bus.latestCursor("unknown")).toBe(0);
    expect(bus.metrics.publishedEvents).toBe(3);
  });

  it("replays history after a cursor and reports expiry when the ring rolled over", () => {
    const bus = new JobEventBus({ ringSize: 3 });
    for (let i = 0; i < 4; i += 1) bus.publish("a", log(i));
    expect(bus.history("a", 0)).toBeNull();
    expect(bus.history("a", 1)?.map((stored) => stored.cursor)).toEqual([2, 3, 4]);
    expect(bus.history("a", 2)?.map((stored) => stored.cursor)).toEqual([3, 4]);
    expect(bus.history("a", 4)).toEqual([]);
    expect(bus.history("unknown", 0)).toBeNull();
  });

  it("treats a cursor it never issued as expired", () => {
    const bus = new JobEventBus();
    bus.subscribe("a", () => {});
    expect(bus.history("a", 42)).toBeNull();
    bus.publish("a", log(0));
    expect(bus.history("a", 1)).toEqual([]);
    expect(bus.history("a", 2)).toBeNull();
  });

  it("fans out live events until unsubscribed", () => {
    const bus = new JobEventBus();
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("a", listener);
    const first = bus.publish("a", log(0));
    expect(listener).toHaveBeenCalledWith(first);
    unsubscribe();
    bus.publish("a", log(1));
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("records handler durations", () => {
    const bus = new JobEventBus();
    bus.recordHandlerDuration(120);
    bus.recordHandlerDuration(30);
    expect(bus.metrics.handlerDurations).toEqual({ count: 2, totalMs: 150, maxMs: 120 });
  });

  it("tracks delivery lag for live events and reconnect replay", () => {
    let now = 10;
    const bus = new JobEventBus({ nowMs: () => now });
    const first = bus.publish("a", log(0));
    now = 35;
    bus.recordDelivery(first);
    expect(bus.metrics.maxPublishLagMs).toBe(25);
    const second = bus.publish("a", log(1));
    now = 45;
    bus.recordDelivery(second);
    expect(bus.metrics.maxPublishLagMs).toBe(25);
    now = 100;
    const replayed = bus.history("a", 0)?.[0];
    if (!replayed) throw new Error("Published event must remain replayable");
    bus.recordDelivery(replayed);
    expect(bus.metrics.maxPublishLagMs).toBe(90);
  });

  it("records cumulative handler duration buckets including boundaries and overflow", () => {
    const bus = new JobEventBus();
    for (const duration of [0, 100, 101, 1000, 1001, 60001]) {
      bus.recordHandlerDuration(duration);
    }
    expect(bus.metrics.handlerDurationMs).toEqual([
      { upperBoundMs: 100, count: 2 },
      { upperBoundMs: 1000, count: 4 },
      { upperBoundMs: 10000, count: 5 },
      { upperBoundMs: 60000, count: 5 },
      { upperBoundMs: null, count: 6 },
    ]);
  });

  it("knows the terminal statuses", () => {
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual(["canceled", "failed", "success"]);
  });

  describe("terminal retention", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("drops job state after the retention window", () => {
      const bus = new JobEventBus({ terminalRetentionMs: 1_000 });
      bus.publish("a", log(0));
      bus.markTerminal("a");
      expect(bus.history("a", 0)).toHaveLength(1);
      vi.advanceTimersByTime(1_001);
      expect(bus.history("a", 0)).toBeNull();
      expect(bus.latestCursor("a")).toBe(0);
    });
  });
});
