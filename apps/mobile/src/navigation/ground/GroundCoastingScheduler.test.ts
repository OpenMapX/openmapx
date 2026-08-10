import type { FixInput, GroundMobileSession } from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import {
  anchorFor,
  COAST_PERSIST_MS,
  COAST_START_DELAY_MS,
  COAST_TICK_MS,
  canCoast,
  catchUpFixes,
  coastFixAt,
  GroundCoastingScheduler,
  MAX_CATCH_UP_POINTS,
  MAX_COAST_MS,
} from "./GroundCoastingScheduler";

const NOW = 1_700_000_100_000;

/** A route long enough that a coast has somewhere to go. */
const GEOMETRY: Array<[number, number]> = Array.from({ length: 200 }, (_, index) => [
  8.68 + index * 0.001,
  50.11,
]);

function session(overrides: Partial<GroundMobileSession> = {}): GroundMobileSession {
  const base = groundSessionFixture({ status: "active", ...overrides });
  return {
    ...base,
    lastAcceptedFix: { coords: [8.69, 50.11], accuracy: 5, timestampMs: NOW },
    ...overrides,
    payload: {
      ...base.payload,
      startPackage: {
        ...base.payload.startPackage,
        route: { ...base.payload.startPackage.route, geometry: GEOMETRY } as never,
      },
      progress: { alongMeters: 500, speedMps: 20 } as never,
      ...(overrides.payload ?? {}),
    },
  };
}

describe("canCoast", () => {
  it("allows a moving, on-route, visible session", () => {
    expect(canCoast(session(), "active")).toBe(true);
  });

  it.each(["inactive", "background"] as const)("refuses while the app is %s", (visibility) => {
    // A suspended app runs no timers, so a coast started here would only claim
    // movement that nothing measured.
    expect(canCoast(session(), visibility)).toBe(false);
  });

  it("refuses while off route, where there is no line to follow", () => {
    const current = session();
    current.payload.offRoute = true;

    expect(canCoast(current, "active")).toBe(false);
  });

  it("refuses while a reroute is in flight, because the route is about to change", () => {
    const current = session();
    current.payload.reroute = { status: "in-flight", attempts: 1 };

    expect(canCoast(current, "active")).toBe(false);
  });

  it("refuses when stationary, where there is no motion to continue", () => {
    const current = session();
    current.payload.progress = { alongMeters: 500, speedMps: 0 } as never;

    expect(canCoast(current, "active")).toBe(false);
  });

  it("refuses without a real fix to anchor to", () => {
    const current = session();
    current.lastAcceptedFix = undefined;

    expect(canCoast(current, "active")).toBe(false);
  });

  it.each(["preparing", "arrived", "stopped", "expired", "error"] as const)(
    "refuses a %s session",
    (status) => {
      expect(canCoast(session({ status }), "active")).toBe(false);
    },
  );
});

describe("coastFixAt", () => {
  const anchor = { alongMeters: 500, speedMps: 20, atMs: NOW };

  it("produces nothing before the start delay", () => {
    expect(coastFixAt(session(), anchor, NOW + COAST_START_DELAY_MS - 1)).toBeNull();
  });

  it("produces a synthetic fix once the delay has passed", () => {
    const fix = coastFixAt(session(), anchor, NOW + COAST_START_DELAY_MS);

    expect(fix?.coasted).toBe(true);
    expect(fix?.timestampMs).toBe(NOW + COAST_START_DELAY_MS);
  });

  it("marks the position as exactly on route rather than reporting a measurement", () => {
    const fix = coastFixAt(session(), anchor, NOW + 5_000);

    // Accuracy 1 is an internal on-route marker; it is not a GPS reading, and
    // the coasted flag is what stops it being treated as one.
    expect(fix?.accuracy).toBe(1);
    expect(fix?.coasted).toBe(true);
  });

  it("moves further along the route as time passes", () => {
    const early = coastFixAt(session(), anchor, NOW + 4_000);
    const later = coastFixAt(session(), anchor, NOW + 20_000);

    expect(later?.coords[0]).toBeGreaterThan(early?.coords[0] ?? 0);
  });

  it("slows down rather than continuing at the anchored speed", () => {
    const early = coastFixAt(session(), anchor, NOW + 4_000);
    const later = coastFixAt(session(), anchor, NOW + 60_000);

    expect(later?.speed).toBeLessThan(early?.speed ?? 0);
  });

  it("stops entirely past the coast limit", () => {
    expect(coastFixAt(session(), anchor, NOW + MAX_COAST_MS + 1)).toBeNull();
  });
});

describe("catchUpFixes", () => {
  const realFix = (timestampMs: number): FixInput => ({
    coords: [8.75, 50.11],
    accuracy: 5,
    speed: 20,
    timestampMs,
  });

  it("produces nothing for a normal one-second gap", () => {
    expect(catchUpFixes(session(), realFix(NOW + 1_000))).toEqual([]);
  });

  it("fills a twenty-second gap at one point per second", () => {
    const points = catchUpFixes(session(), realFix(NOW + 20_000));

    expect(points.length).toBeGreaterThan(10);
    for (const point of points) {
      expect(point.coasted).toBe(true);
      expect(point.timestampMs).toBeLessThan(NOW + 20_000);
    }
  });

  it("produces strictly increasing timestamps", () => {
    const points = catchUpFixes(session(), realFix(NOW + 30_000));

    for (let index = 1; index < points.length; index += 1) {
      expect(points[index].timestampMs).toBeGreaterThan(points[index - 1].timestampMs);
      expect(points[index].timestampMs - points[index - 1].timestampMs).toBe(COAST_PERSIST_MS);
    }
  });

  it("never extrapolates to the real fix after a long blackout", () => {
    // Five minutes of nothing. The coast runs out; it does not jump to wherever
    // the user turned out to be.
    const points = catchUpFixes(session(), realFix(NOW + 5 * 60_000));

    expect(points.length).toBeLessThanOrEqual(MAX_CATCH_UP_POINTS);
    const last = points[points.length - 1];
    expect(last.timestampMs).toBeLessThanOrEqual(NOW + MAX_COAST_MS);
  });

  it("stays within the bounded point count", () => {
    expect(catchUpFixes(session(), realFix(NOW + 60 * 60_000)).length).toBeLessThanOrEqual(
      MAX_CATCH_UP_POINTS,
    );
  });

  it.each([
    ["off route", (s: GroundMobileSession) => (s.payload.offRoute = true)],
    [
      "stationary",
      (s: GroundMobileSession) => (s.payload.progress = { alongMeters: 1, speedMps: 0 } as never),
    ],
    [
      "rerouting",
      (s: GroundMobileSession) => (s.payload.reroute = { status: "in-flight", attempts: 1 }),
    ],
  ])("synthesises nothing while %s", (_label, mutate) => {
    const current = session();
    mutate(current);

    expect(catchUpFixes(current, realFix(NOW + 30_000))).toEqual([]);
  });

  it("synthesises nothing without an anchor", () => {
    const current = session();
    current.lastAcceptedFix = undefined;

    expect(catchUpFixes(current, realFix(NOW + 30_000))).toEqual([]);
  });
});

describe("GroundCoastingScheduler", () => {
  function harness() {
    let now = NOW;
    const dispatched: FixInput[] = [];
    const timers = new Map<number, { callback: () => void; dueAtMs: number }>();
    let nextHandle = 1;

    const scheduler = new GroundCoastingScheduler({
      now: () => now,
      schedule: (callback, delayMs) => {
        const handle = nextHandle++;
        timers.set(handle, { callback, dueAtMs: now + delayMs });
        return handle;
      },
      cancel: (handle) => {
        timers.delete(handle as number);
      },
      dispatch: (fix) => dispatched.push(fix),
    });

    /** Advances the fake clock, firing due timers in order. */
    const advance = (ms: number) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.dueAtMs <= target)
          .sort((a, b) => a[1].dueAtMs - b[1].dueAtMs)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].dueAtMs;
        due[1].callback();
      }
      now = target;
    };

    return { scheduler, dispatched, advance, timerCount: () => timers.size };
  }

  it("does not start for a session that cannot coast", () => {
    const { scheduler } = harness();

    scheduler.sync(session(), "background");

    expect(scheduler.running).toBe(false);
  });

  it("starts for an active, visible, moving session", () => {
    const { scheduler } = harness();

    scheduler.sync(session(), "active");

    expect(scheduler.running).toBe(true);
  });

  it("dispatches nothing before the start delay", () => {
    const { scheduler, dispatched, advance } = harness();
    scheduler.sync(session(), "active");

    advance(COAST_START_DELAY_MS - COAST_TICK_MS);

    expect(dispatched).toEqual([]);
  });

  it("dispatches synthetic fixes once coasting begins", () => {
    const { scheduler, dispatched, advance } = harness();
    scheduler.sync(session(), "active");

    advance(10_000);

    expect(dispatched.length).toBeGreaterThan(0);
    for (const fix of dispatched) expect(fix.coasted).toBe(true);
  });

  it("persists at most one synthetic fix per second despite a faster redraw", () => {
    const { scheduler, dispatched, advance } = harness();
    scheduler.sync(session(), "active");

    advance(10_000);

    // Ten seconds of coasting, ticking four times a second.
    expect(dispatched.length).toBeLessThanOrEqual(9);
  });

  it("stops itself when the coast runs out", () => {
    const { scheduler, advance } = harness();
    scheduler.sync(session(), "active");

    advance(MAX_COAST_MS + 10_000);

    expect(scheduler.running).toBe(false);
  });

  it.each(["inactive", "background"] as const)("cancels when the app becomes %s", (visibility) => {
    const { scheduler, advance } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    scheduler.sync(session(), visibility);

    expect(scheduler.running).toBe(false);
  });

  it("cancels when the session goes off route", () => {
    const { scheduler, advance } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    const offRoute = session();
    offRoute.payload.offRoute = true;
    scheduler.sync(offRoute, "active");

    expect(scheduler.running).toBe(false);
  });

  it("cancels when the session ends", () => {
    const { scheduler, advance } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    scheduler.sync(null, "active");

    expect(scheduler.running).toBe(false);
  });

  it("leaves no timer behind after stopping", () => {
    const { scheduler, advance, timerCount } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    scheduler.stop();

    expect(timerCount()).toBe(0);
  });

  it("reanchors on a new real fix rather than continuing the old coast", () => {
    const { scheduler, dispatched, advance } = harness();
    scheduler.sync(session(), "active");
    advance(10_000);
    const before = dispatched.length;

    const reanchored = session();
    reanchored.lastAcceptedFix = { coords: [8.72, 50.11], accuracy: 5, timestampMs: NOW + 10_000 };
    reanchored.payload.progress = { alongMeters: 900, speedMps: 20 } as never;
    scheduler.sync(reanchored, "active");
    advance(1_000);

    // The fresh anchor restarts the delay, so nothing is dispatched yet.
    expect(dispatched).toHaveLength(before);
  });
});

describe("anchorFor", () => {
  it("reads the anchor from progress and the last real fix", () => {
    expect(anchorFor(session())).toEqual({ alongMeters: 500, speedMps: 20, atMs: NOW });
  });

  it("has no anchor without progress", () => {
    const current = session();
    current.payload.progress = null;

    expect(anchorFor(current)).toBeNull();
  });

  it("has no anchor without a fix", () => {
    const current = session();
    current.lastAcceptedFix = undefined;

    expect(anchorFor(current)).toBeNull();
  });
});
