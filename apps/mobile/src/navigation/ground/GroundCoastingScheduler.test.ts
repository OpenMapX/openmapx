import {
  COAST_START_DELAY_MS,
  type FixInput,
  type GroundMobileSession,
  MAX_COAST_MS,
} from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import {
  anchorFor,
  COAST_DISPATCH_MS,
  type CoastOrigin,
  canCoast,
  GroundCoastingScheduler,
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
      coastingAnchor: { acceptedAtMs: NOW, alongMeters: 500, speedMps: 20 },
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
    current.payload.coastingAnchor = { acceptedAtMs: NOW, alongMeters: 500, speedMps: 0 };

    expect(canCoast(current, "active")).toBe(false);
  });

  it("refuses without a real fix to anchor to", () => {
    const current = session();
    current.payload.coastingAnchor = undefined;

    expect(canCoast(current, "active")).toBe(false);
  });

  it.each(["preparing", "arrived", "stopped", "expired", "error"] as const)(
    "refuses a %s session",
    (status) => {
      expect(canCoast(session({ status }), "active")).toBe(false);
    },
  );
});

describe("GroundCoastingScheduler", () => {
  function harness() {
    let now = NOW;
    const dispatched: FixInput[] = [];
    const origins: CoastOrigin[] = [];
    const timers = new Map<number, { callback: () => void; dueAtMs: number }>();
    let nextHandle = 1;

    const scheduler = new GroundCoastingScheduler({
      now: () => now,
      schedule: (callback, delayMs) => {
        const handle = nextHandle++;
        timers.set(handle, { callback, dueAtMs: now + delayMs });
        return () => {
          timers.delete(handle);
        };
      },
      dispatch: (fix, origin) => {
        dispatched.push(fix);
        origins.push(origin);
      },
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

    return { scheduler, dispatched, origins, advance, timerCount: () => timers.size };
  }

  it("does not start for a session that cannot coast", () => {
    const { scheduler } = harness();

    scheduler.sync(session(), "background");

    expect(scheduler.running).toBe(false);
  });

  it("starts after the delay and dispatches synthetic fixes at most once per second", () => {
    const { scheduler, dispatched, origins, advance } = harness();
    scheduler.sync(session(), "active");
    expect(scheduler.running).toBe(true);
    advance(COAST_START_DELAY_MS - 1);
    expect(dispatched).toEqual([]);
    advance(10_000 - (COAST_START_DELAY_MS - 1));

    expect(dispatched.length).toBeGreaterThan(0);
    for (const fix of dispatched) expect(fix.coasted).toBe(true);
    expect(new Set(origins.map((origin) => JSON.stringify(origin)))).toEqual(
      new Set([JSON.stringify({ sessionId: session().sessionId, anchorAtMs: NOW })]),
    );
    for (let index = 1; index < dispatched.length; index++)
      expect(dispatched[index].timestampMs - dispatched[index - 1].timestampMs).toBe(
        COAST_DISPATCH_MS,
      );
  });

  it("stops itself when the coast runs out", () => {
    const { scheduler, advance } = harness();
    scheduler.sync(session(), "active");

    advance(MAX_COAST_MS + 10_000);

    expect(scheduler.running).toBe(false);
  });

  it.each(["inactive", "background"] as const)("cancels when the app becomes %s", (visibility) => {
    const { scheduler, advance, dispatched, timerCount } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    scheduler.sync(session(), visibility);

    expect(scheduler.running).toBe(false);
    expect(timerCount()).toBe(0);
    const count = dispatched.length;
    advance(30_000);
    expect(dispatched).toHaveLength(count);
  });

  it("cancels when the session goes off route", () => {
    const { scheduler, advance, dispatched, timerCount } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    const offRoute = session();
    offRoute.payload.offRoute = true;
    scheduler.sync(offRoute, "active");

    expect(scheduler.running).toBe(false);
    expect(timerCount()).toBe(0);
    const count = dispatched.length;
    advance(30_000);
    expect(dispatched).toHaveLength(count);
  });

  it("cancels when the session ends", () => {
    const { scheduler, advance, dispatched, timerCount } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);

    scheduler.sync(null, "active");

    expect(scheduler.running).toBe(false);
    expect(timerCount()).toBe(0);
    const count = dispatched.length;
    advance(30_000);
    expect(dispatched).toHaveLength(count);
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
    reanchored.payload.coastingAnchor = {
      acceptedAtMs: NOW + 10_000,
      alongMeters: 900,
      speedMps: 20,
    };
    scheduler.sync(reanchored, "active");
    advance(1_000);

    // The fresh anchor restarts the delay, so nothing is dispatched yet.
    expect(dispatched).toHaveLength(before);
  });

  it("keeps its coast when a coasted commit leaves the anchor unchanged", () => {
    const { scheduler, dispatched, advance } = harness();
    scheduler.sync(session(), "active");
    advance(5_000);
    const before = dispatched.length;

    // The committed progress has moved on with the coast, the anchor has not.
    const coasted = session();
    coasted.payload.progress = { alongMeters: 560, speedMps: 19 } as never;
    coasted.payload.coasting = true;
    scheduler.sync(coasted, "active");
    advance(1_000);

    expect(dispatched.length).toBeGreaterThan(before);
  });
});

describe("anchorFor", () => {
  it("reads the anchor the last real fix left", () => {
    expect(anchorFor(session())).toEqual({ alongMeters: 500, speedMps: 20, atMs: NOW });
  });

  it("has no anchor before a real fix", () => {
    const current = session();
    current.payload.coastingAnchor = undefined;

    expect(anchorFor(current)).toBeNull();
  });
});
