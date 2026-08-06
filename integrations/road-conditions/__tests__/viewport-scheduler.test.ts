import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createViewportFetchScheduler,
  isViewportContained,
  type ViewportBox,
  type ViewportFetchSchedulerOptions,
} from "../viewport-scheduler";

const WORLD: ViewportBox = { west: -10, south: -10, east: 10, north: 10 };
const FAR_AWAY: ViewportBox = { west: -50, south: -50, east: 50, north: 50 };

describe("isViewportContained", () => {
  it("is true for a viewport equal to the reference with no padding", () => {
    expect(isViewportContained(WORLD, WORLD, 0)).toBe(true);
  });

  it("is true for a viewport that only reaches into the padding", () => {
    const shifted: ViewportBox = { west: -9, south: -9, east: 11, north: 11 };
    expect(isViewportContained(shifted, WORLD, 0.5)).toBe(true);
  });

  it("is false once the viewport crosses the padded edge", () => {
    const beyond: ViewportBox = { west: -21, south: -10, east: 10, north: 10 };
    expect(isViewportContained(beyond, WORLD, 0.5)).toBe(false);
  });
});

describe("createViewportFetchScheduler", () => {
  let onDue: ReturnType<typeof vi.fn>;
  let viewport: ViewportBox;
  let getViewportCalls: number;
  let timerCreations: number;

  beforeEach(() => {
    vi.useFakeTimers();
    onDue = vi.fn();
    viewport = { ...WORLD };
    getViewportCalls = 0;
    timerCreations = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeScheduler(overrides: Partial<ViewportFetchSchedulerOptions> = {}) {
    return createViewportFetchScheduler({
      freshnessDeadlineMs: 90_000,
      paddingFactor: 0.5,
      getViewport: () => {
        getViewportCalls += 1;
        return viewport;
      },
      onDue,
      setTimeout: (handler, delay) => {
        timerCreations += 1;
        return setTimeout(handler, delay);
      },
      clearTimeout: (handle) => clearTimeout(handle),
      ...overrides,
    });
  }

  it("evaluates almost immediately on the first markDirty after being idle", () => {
    const scheduler = makeScheduler();
    scheduler.recordFetch(WORLD, 0);
    viewport = FAR_AWAY;
    scheduler.markDirty();
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("bounds evaluations, getViewport reads, and timer creations under a 60Hz burst for a minute", () => {
    const scheduler = makeScheduler();
    scheduler.recordFetch(WORLD, Date.now());
    // Reset counters after the priming recordFetch above so this measures only
    // what the burst itself causes.
    getViewportCalls = 0;
    timerCreations = 0;

    for (let i = 0; i < 3600; i++) {
      scheduler.markDirty();
      vi.advanceTimersByTime(1000 / 60);
    }

    // ~60s of continuous motion throttled to one evaluation per 5s is ~12
    // evaluations, not 3600 — each evaluation reads the viewport once and,
    // since it never left the padded box, never fires onDue.
    expect(getViewportCalls).toBeGreaterThan(0);
    expect(getViewportCalls).toBeLessThanOrEqual(15);
    expect(timerCreations).toBeLessThanOrEqual(15);
    expect(onDue).not.toHaveBeenCalled();
  });

  it("crosses the padding threshold and fires onDue promptly", () => {
    const scheduler = makeScheduler();
    scheduler.recordFetch(WORLD, Date.now());
    viewport = FAR_AWAY;
    scheduler.markDirty();
    vi.advanceTimersByTime(0);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("fires onDue when the freshness deadline elapses with zero movement", () => {
    const scheduler = makeScheduler({ freshnessDeadlineMs: 90_000 });
    scheduler.recordFetch(WORLD, Date.now());
    vi.advanceTimersByTime(89_999);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("re-arms the freshness timer from the latest recordFetch, not the first one", () => {
    const scheduler = makeScheduler({ freshnessDeadlineMs: 10_000 });
    scheduler.recordFetch(WORLD, Date.now());
    vi.advanceTimersByTime(9000);
    scheduler.recordFetch(WORLD, Date.now());
    vi.advanceTimersByTime(9000);
    expect(onDue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(onDue).toHaveBeenCalledTimes(1);
  });

  it("holds no repeating short timer once motion stops — only the freshness deadline", () => {
    const scheduler = makeScheduler({ freshnessDeadlineMs: 90_000 });
    scheduler.recordFetch(WORLD, Date.now());
    for (let i = 0; i < 60; i++) {
      scheduler.markDirty();
      vi.advanceTimersByTime(1000 / 60);
    }
    // Let any evaluation the burst scheduled actually run.
    vi.advanceTimersByTime(6000);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("dispose cancels pending timers and stops further evaluations", () => {
    const scheduler = makeScheduler();
    scheduler.recordFetch(WORLD, Date.now());
    scheduler.markDirty();
    scheduler.dispose();
    vi.advanceTimersByTime(200_000);
    expect(onDue).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reads the viewport fresh at evaluation time, not at markDirty time", () => {
    const scheduler = makeScheduler();
    scheduler.recordFetch(WORLD, Date.now());
    viewport = WORLD;
    scheduler.markDirty();
    // The camera keeps moving between markDirty and the coalesced evaluation
    // actually running — the decision must reflect the viewport at the time
    // it runs, not a value captured back when markDirty fired.
    viewport = FAR_AWAY;
    vi.advanceTimersByTime(0);
    expect(onDue).toHaveBeenCalledTimes(1);
  });
});
