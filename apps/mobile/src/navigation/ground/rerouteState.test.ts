import {
  CHURN_COOLDOWN_MS,
  CHURN_LIMIT,
  CHURN_WINDOW_MS,
  canRequestReroute,
  EMPTY_CHURN,
  MAX_CONSECUTIVE_FAILURES,
  onBackOnRoute,
  onRerouteFailed,
  onRerouteOffline,
  onRerouteRequested,
  onRerouteSucceeded,
  RETRY_DELAYS_MS,
  RETRY_JITTER_MS,
  type RerouteRuntime,
  recordSuccess,
  retryDelayMs,
} from "./rerouteState";

const NOW = 1_700_000_100_000;
const IDLE: RerouteRuntime = { status: "idle", attempts: 0 };

describe("canRequestReroute", () => {
  it("allows a first request", () => {
    expect(canRequestReroute(IDLE, EMPTY_CHURN, "online", NOW)).toEqual({ allow: true });
  });

  it("allows only one request at a time", () => {
    const inFlight: RerouteRuntime = { status: "in-flight", attempts: 0, requestId: "r1" };

    expect(canRequestReroute(inFlight, EMPTY_CHURN, "online", NOW)).toEqual({
      allow: false,
      reason: "in-flight",
    });
  });

  it("refuses while offline rather than failing", () => {
    // There is nothing to retry: the captured route still guides, and the
    // session simply waits for a connection.
    expect(canRequestReroute(IDLE, EMPTY_CHURN, "offline", NOW)).toEqual({
      allow: false,
      reason: "offline",
    });
  });

  it("allows a request when connectivity is merely unknown", () => {
    expect(canRequestReroute(IDLE, EMPTY_CHURN, "unknown", NOW)).toEqual({ allow: true });
  });

  it("respects the backoff after a failure", () => {
    const backingOff: RerouteRuntime = {
      status: "pending",
      attempts: 1,
      nextAttemptAtMs: NOW + 5_000,
    };

    expect(canRequestReroute(backingOff, EMPTY_CHURN, "online", NOW)).toEqual({
      allow: false,
      reason: "backoff",
    });
    expect(canRequestReroute(backingOff, EMPTY_CHURN, "online", NOW + 5_000)).toEqual({
      allow: true,
    });
  });

  it("stops asking after the retries are exhausted", () => {
    const exhausted: RerouteRuntime = { status: "failed", attempts: MAX_CONSECUTIVE_FAILURES };

    expect(canRequestReroute(exhausted, EMPTY_CHURN, "online", NOW)).toEqual({
      allow: false,
      reason: "exhausted",
    });
  });

  it("refuses during the churn cooldown", () => {
    const churn = { successAtMs: [NOW], cooldownUntilMs: NOW + CHURN_COOLDOWN_MS };

    expect(canRequestReroute(IDLE, churn, "online", NOW)).toEqual({
      allow: false,
      reason: "churn-cooldown",
    });
    expect(canRequestReroute(IDLE, churn, "online", NOW + CHURN_COOLDOWN_MS)).toEqual({
      allow: true,
    });
  });
});

describe("retryDelayMs", () => {
  it.each(RETRY_DELAYS_MS.map((delay, index) => [index + 1, delay]))(
    "waits %ims-indexed base delay on attempt %i",
    (attempts, base) => {
      expect(retryDelayMs(attempts as number, 0)).toBe(base);
    },
  );

  it("grows with each attempt", () => {
    const delays = RETRY_DELAYS_MS.map((_, index) => retryDelayMs(index + 1, 0));

    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]).toBeGreaterThan(delays[index - 1]);
    }
  });

  it("repeats the longest delay rather than growing without bound", () => {
    const longest = RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

    expect(retryDelayMs(99, 0)).toBe(longest);
  });

  it("adds bounded jitter so a fleet does not retry in lockstep", () => {
    expect(retryDelayMs(1, 1)).toBe(RETRY_DELAYS_MS[0] + RETRY_JITTER_MS);
    expect(retryDelayMs(1, 0.5)).toBe(RETRY_DELAYS_MS[0] + RETRY_JITTER_MS / 2);
  });

  it("clamps a jitter value outside the unit range", () => {
    expect(retryDelayMs(1, -5)).toBe(RETRY_DELAYS_MS[0]);
    expect(retryDelayMs(1, 5)).toBe(RETRY_DELAYS_MS[0] + RETRY_JITTER_MS);
  });
});

describe("reroute transitions", () => {
  it("marks a request in flight with its identifier", () => {
    expect(onRerouteRequested(IDLE, "r1")).toEqual({
      status: "in-flight",
      attempts: 0,
      requestId: "r1",
    });
  });

  it("schedules a retry after a failure", () => {
    const failed = onRerouteFailed({ status: "in-flight", attempts: 0 }, "timeout", NOW, 0);

    expect(failed.status).toBe("pending");
    expect(failed.attempts).toBe(1);
    expect(failed.nextAttemptAtMs).toBe(NOW + RETRY_DELAYS_MS[0]);
    expect(failed.lastFailureCode).toBe("timeout");
  });

  it("gives up after the last retry", () => {
    let runtime: RerouteRuntime = { status: "in-flight", attempts: MAX_CONSECUTIVE_FAILURES - 1 };

    runtime = onRerouteFailed(runtime, "network", NOW, 0);

    expect(runtime.status).toBe("failed");
    expect(runtime.attempts).toBe(MAX_CONSECUTIVE_FAILURES);
  });

  it("truncates a long failure code rather than storing it whole", () => {
    const failed = onRerouteFailed(IDLE, "e".repeat(500), NOW, 0);

    expect(failed.lastFailureCode).toHaveLength(64);
  });

  it("keeps the captured route when the network is the obstacle", () => {
    const offline = onRerouteOffline({ status: "in-flight", attempts: 2 });

    expect(offline).toEqual({ status: "unavailable", attempts: 2 });
  });

  it("clears the failure history on success", () => {
    const succeeded = onRerouteSucceeded();

    // The next problem starts from scratch rather than inheriting a backoff
    // from an outage that is now over.
    expect(succeeded).toEqual({ status: "idle", attempts: 0 });
  });

  it("clears the failure history once back on route", () => {
    expect(onBackOnRoute({ status: "failed", attempts: 4 })).toEqual({
      status: "idle",
      attempts: 0,
    });
  });

  it("leaves an already-idle runtime untouched", () => {
    expect(onBackOnRoute(IDLE)).toBe(IDLE);
  });
});

describe("recordSuccess", () => {
  it("cools off after three reroutes in two minutes", () => {
    let churn = EMPTY_CHURN;
    for (let index = 0; index < CHURN_LIMIT; index += 1) {
      churn = recordSuccess(churn, NOW + index * 10_000);
    }

    expect(churn.cooldownUntilMs).toBe(NOW + (CHURN_LIMIT - 1) * 10_000 + CHURN_COOLDOWN_MS);
  });

  it("does not cool off for reroutes spread across an hour", () => {
    let churn = EMPTY_CHURN;
    for (let index = 0; index < 6; index += 1) {
      churn = recordSuccess(churn, NOW + index * 10 * 60_000);
    }

    expect(churn.cooldownUntilMs).toBeUndefined();
  });

  it("forgets successes older than the window", () => {
    let churn = recordSuccess(EMPTY_CHURN, NOW);
    churn = recordSuccess(churn, NOW + CHURN_WINDOW_MS + 1);

    expect(churn.successAtMs).toEqual([NOW + CHURN_WINDOW_MS + 1]);
  });

  it("records the first two successes without any cooldown", () => {
    let churn = recordSuccess(EMPTY_CHURN, NOW);
    churn = recordSuccess(churn, NOW + 1_000);

    expect(churn.cooldownUntilMs).toBeUndefined();
    expect(churn.successAtMs).toHaveLength(2);
  });
});
