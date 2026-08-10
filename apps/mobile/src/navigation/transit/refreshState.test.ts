import {
  isCurrentGeneration,
  MAX_CONSECUTIVE_FAILURES,
  onRefreshFailed,
  onRefreshRequested,
  onRefreshSucceeded,
  onRefreshUnreachable,
  REFRESH_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  RETRY_DELAYS_MS,
  type RefreshRuntime,
  shouldRefresh,
} from "./refreshState";

const NOW = 1_700_000_100_000;
const READY: RefreshRuntime = { status: "ready", generation: 1, attempts: 0 };

function context(overrides: Partial<Parameters<typeof shouldRefresh>[0]> = {}) {
  return {
    runtime: READY,
    hasToken: true,
    connectivity: "online" as const,
    status: "active" as const,
    nowMs: NOW,
    ...overrides,
  };
}

describe("shouldRefresh", () => {
  it("refreshes a ready, online, active session", () => {
    expect(shouldRefresh(context())).toEqual({ refresh: true });
  });

  it("sends only one request at a time", () => {
    // Two concurrent calls would spend the same rotating token twice.
    expect(
      shouldRefresh(context({ runtime: { ...READY, status: "in-flight", requestId: "r1" } })),
    ).toEqual({ refresh: false, reason: "in-flight" });
  });

  it("never refreshes a broken chain", () => {
    // Once the token may have been consumed, waiting does not make it valid.
    expect(shouldRefresh(context({ runtime: { ...READY, status: "broken" } }))).toEqual({
      refresh: false,
      reason: "broken",
    });
  });

  it("does not refresh while offline", () => {
    expect(shouldRefresh(context({ connectivity: "offline" }))).toEqual({
      refresh: false,
      reason: "offline",
    });
  });

  it("refreshes when connectivity is merely unknown", () => {
    expect(shouldRefresh(context({ connectivity: "unknown" }))).toEqual({ refresh: true });
  });

  it("does not refresh without a token", () => {
    expect(shouldRefresh(context({ hasToken: false }))).toEqual({
      refresh: false,
      reason: "no-token",
    });
  });

  it.each(["arrived", "stopped", "expired", "error"] as const)(
    "does not refresh a %s session",
    (status) => {
      expect(shouldRefresh(context({ status }))).toEqual({ refresh: false, reason: "terminal" });
    },
  );

  it("waits out the interval between refreshes", () => {
    const waiting = { ...READY, nextAttemptAtMs: NOW + 10_000 };

    expect(shouldRefresh(context({ runtime: waiting }))).toEqual({
      refresh: false,
      reason: "too-soon",
    });
    expect(shouldRefresh(context({ runtime: waiting, nowMs: NOW + 10_000 }))).toEqual({
      refresh: true,
    });
  });

  it("does not refresh more often than the interval, however many callbacks arrive", () => {
    const runtime = onRefreshSucceeded(READY, NOW);

    for (let tick = 0; tick < 20; tick += 1) {
      const decision = shouldRefresh(context({ runtime, nowMs: NOW + tick * 1_000 }));
      expect(decision).toEqual({ refresh: false, reason: "too-soon" });
    }
    expect(shouldRefresh(context({ runtime, nowMs: NOW + REFRESH_INTERVAL_MS }))).toEqual({
      refresh: true,
    });
    expect(runtime.status).toBe("ready");
  });
});

describe("refresh transitions", () => {
  it("bumps the generation when a request goes out", () => {
    const inFlight = onRefreshRequested(READY, "r1", NOW);

    expect(inFlight.status).toBe("in-flight");
    expect(inFlight.generation).toBe(2);
    expect(inFlight.requestId).toBe("r1");
    expect(inFlight.nextAttemptAtMs).toBe(NOW + REQUEST_TIMEOUT_MS);
  });

  it("schedules the next refresh on success and clears the failure count", () => {
    const done = onRefreshSucceeded({ ...READY, attempts: 3 }, NOW);

    expect(done.status).toBe("ready");
    expect(done.attempts).toBe(0);
    expect(done.nextAttemptAtMs).toBe(NOW + REFRESH_INTERVAL_MS);
  });

  describe("failure", () => {
    const inFlight: RefreshRuntime = {
      status: "in-flight",
      generation: 2,
      requestId: "r1",
      attempts: 0,
    };

    it("keeps the token when nothing left the device", () => {
      // Offline means the request was never sent, so the token is still valid.
      const offline = onRefreshFailed(inFlight, "offline");

      expect(offline.status).toBe("stale");
      expect(offline.attempts).toBe(0);
    });

    it("breaks the chain when the server rejected the token", () => {
      expect(onRefreshFailed(inFlight, "rejected").status).toBe("broken");
    });

    it("breaks the chain after an ambiguous timeout rather than gambling", () => {
      // The server may or may not have consumed the token. Retrying blindly is a
      // coin flip that, when it loses, silently ends live data for the trip.
      const ambiguous = onRefreshFailed(inFlight, "ambiguous");

      expect(ambiguous.status).toBe("broken");
      expect(shouldRefresh(context({ runtime: ambiguous }))).toEqual({
        refresh: false,
        reason: "broken",
      });
    });

    it("retries with the same token only when the request never arrived", () => {
      const unreachable = onRefreshUnreachable(inFlight, NOW);

      expect(unreachable.status).toBe("ready");
      expect(unreachable.attempts).toBe(1);
      expect(unreachable.nextAttemptAtMs).toBe(NOW + RETRY_DELAYS_MS[0]);
    });

    it("backs off further with each unreachable attempt", () => {
      let runtime = inFlight;
      const delays: number[] = [];
      for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt += 1) {
        runtime = onRefreshUnreachable(runtime, NOW);
        delays.push((runtime.nextAttemptAtMs ?? 0) - NOW);
      }

      expect(delays).toEqual([...RETRY_DELAYS_MS]);
    });

    it("gives up on live data after the last unreachable attempt", () => {
      let runtime = inFlight;
      for (let attempt = 0; attempt < MAX_CONSECUTIVE_FAILURES; attempt += 1) {
        runtime = onRefreshUnreachable(runtime, NOW);
      }

      expect(runtime.status).toBe("stale");
    });
  });
});

describe("isCurrentGeneration", () => {
  const inFlight: RefreshRuntime = {
    status: "in-flight",
    generation: 4,
    requestId: "r4",
    attempts: 0,
  };

  it("accepts the reply the session is waiting for", () => {
    expect(isCurrentGeneration(inFlight, { generation: 4, requestId: "r4" })).toBe(true);
  });

  it("rejects a reply from a generation a replan superseded", () => {
    expect(isCurrentGeneration(inFlight, { generation: 3, requestId: "r3" })).toBe(false);
  });

  it("rejects a reply whose request the session never made", () => {
    expect(isCurrentGeneration(inFlight, { generation: 4, requestId: "somewhere-else" })).toBe(
      false,
    );
  });

  it("rejects every reply once the session moved on", () => {
    const moved = onRefreshSucceeded(inFlight, NOW);

    expect(isCurrentGeneration(moved, { generation: 4, requestId: "r4" })).toBe(false);
  });
});
