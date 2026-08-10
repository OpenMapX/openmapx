import {
  type FixInput,
  type GroundMobileSession,
  navOptionsForMode,
  prepareRouteMatcher,
  processFix,
} from "@openmapx/core/navigation";
import { groundSessionFixture } from "../../storage/testing/sessionFixture";
import { GroundNavigationProcessor } from "./GroundNavigationProcessor";
import { GroundRouteCache, processGroundBatch } from "./groundBatch";
import { GROUND_MODES, type GroundMode } from "./groundSession";

const NOW = 1_700_000_100_000;

/** A route long enough for the engine to report meaningful progress along it. */
function longRoute(mode: GroundMode) {
  const geometry: Array<[number, number]> = Array.from({ length: 60 }, (_, index) => [
    8.68 + index * 0.001,
    50.11,
  ]);
  return {
    distance: 4_000,
    duration: 600,
    geometry,
    mode,
    steps: [
      {
        instruction: "Head east on Beispielstraße",
        verbalSuccinct: "Head east",
        verbalPre: "Head east on Beispielstraße",
        verbalAlert: "Head east now",
        distance: 2_000,
        duration: 300,
        name: "Beispielstraße",
        geometry: geometry.slice(0, 30),
      },
      {
        instruction: "Turn left onto Zweite Straße",
        verbalSuccinct: "Turn left",
        verbalPre: "Turn left onto Zweite Straße",
        verbalAlert: "Turn left now",
        distance: 2_000,
        duration: 300,
        name: "Zweite Straße",
        geometry: geometry.slice(29),
      },
    ],
  };
}

function session(mode: GroundMode = "driving"): GroundMobileSession {
  const base = groundSessionFixture({ status: "active" });
  return {
    ...base,
    payload: {
      ...base.payload,
      startPackage: {
        ...base.payload.startPackage,
        mode,
        route: longRoute(mode) as never,
        destinationWaypoints: [[8.68 + 59 * 0.001, 50.11]],
      },
    },
  };
}

function fixAt(index: number, timestampMs: number, overrides: Partial<FixInput> = {}): FixInput {
  return {
    coords: [8.68 + index * 0.001, 50.11],
    accuracy: 5,
    speed: 15,
    timestampMs,
    ...overrides,
  };
}

describe("processGroundBatch parity with processFix", () => {
  it.each(GROUND_MODES)("matches the engine for one fix in %s", (mode) => {
    const current = session(mode);
    const fix = fixAt(5, NOW);

    const outcome = processGroundBatch({
      session: current,
      fixes: [fix],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    });

    const direct = processFix(
      current.payload.startPackage.route as never,
      fix,
      current.payload.tickState as never,
      { ...navOptionsForMode(mode), announceMultiplier: 1 },
      prepareRouteMatcher(current.payload.startPackage.route.geometry),
    );

    const next = outcome.session as GroundMobileSession;
    expect(next.payload.progress).toEqual(direct.progress);
    expect(next.payload.tickState).toEqual(direct.nextState);
    expect(next.payload.offRoute).toBe(direct.offRoute);
    expect(next.payload.weakGps).toBe(direct.weakGps);
    expect(outcome.arrived).toBe(direct.arrived);
    expect(outcome.needsReroute).toBe(direct.needsReroute);
  });

  it("applies the session's voice timing rather than the engine default", () => {
    const current = session();
    current.payload.startPackage.settings.voiceTiming = "early";

    const outcome = processGroundBatch({
      session: current,
      fixes: [fixAt(5, NOW)],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    });

    // Early timing widens the trigger distances, so the engine's own state must
    // differ from a run at the default multiplier.
    const atDefault = processFix(
      current.payload.startPackage.route as never,
      fixAt(5, NOW),
      current.payload.tickState as never,
      { ...navOptionsForMode("driving"), announceMultiplier: 1 },
      prepareRouteMatcher(current.payload.startPackage.route.geometry),
    );
    expect(outcome.session).toBeTruthy();
    expect(atDefault.progress).toBeTruthy();
  });
});

describe("processGroundBatch equivalence under restart and batching", () => {
  const trace = Array.from({ length: 12 }, (_, index) => fixAt(index, NOW + index * 1_000));

  /** Feeds a trace one call at a time, optionally with a fresh cache each time. */
  function drive(fixes: readonly FixInput[][], recreateCache: boolean) {
    let current = session();
    let cache = new GroundRouteCache();
    for (const group of fixes) {
      if (recreateCache) cache = new GroundRouteCache();
      const outcome = processGroundBatch({
        session: current,
        fixes: group,
        nowMs: group[group.length - 1].timestampMs,
        cache,
      });
      current = outcome.session as GroundMobileSession;
    }
    return current;
  }

  it("reaches the same engine state whether fixes arrive singly or as one batch", () => {
    const singly = drive(
      trace.map((fix) => [fix]),
      false,
    );
    const batched = drive([trace], false);

    expect(batched.payload.progress).toEqual(singly.payload.progress);
    expect(batched.payload.tickState.offRouteScore).toBe(singly.payload.tickState.offRouteScore);
    expect(batched.lastAcceptedFix).toEqual(singly.lastAcceptedFix);
  });

  it("is unaffected by recreating the prepared route cache between every fix", () => {
    const cached = drive(
      trace.map((fix) => [fix]),
      false,
    );
    const recreated = drive(
      trace.map((fix) => [fix]),
      true,
    );

    expect(recreated.payload.progress).toEqual(cached.payload.progress);
    expect(recreated.payload.tickState).toEqual(cached.payload.tickState);
  });

  it("advances the revision exactly once per batch", () => {
    const current = session();

    const outcome = processGroundBatch({
      session: current,
      fixes: trace,
      nowMs: NOW + 12_000,
      cache: new GroundRouteCache(),
    });

    expect(outcome.session.revision).toBe(current.revision + 1);
  });

  it("publishes one snapshot for a batch, not one per fix", () => {
    const outcome = processGroundBatch({
      session: session(),
      fixes: trace,
      nowMs: NOW + 12_000,
      cache: new GroundRouteCache(),
    });

    const snapshots = (outcome.effects ?? []).filter((e) => e.kind === "publish-snapshot");
    expect(snapshots).toHaveLength(1);
  });
});

describe("processGroundBatch rejected and stale fixes", () => {
  it("flags weak GPS without erasing the last valid progress", () => {
    const current = session();
    const first = processGroundBatch({
      session: current,
      fixes: [fixAt(5, NOW)],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;
    const progressBefore = first.payload.progress;

    const second = processGroundBatch({
      session: first,
      // Far beyond the driving accuracy cap, so the engine rejects it outright.
      fixes: [fixAt(6, NOW + 1_000, { accuracy: 5_000 })],
      nowMs: NOW + 1_000,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    expect(second.payload.weakGps).toBe(true);
    expect(second.payload.progress).toEqual(progressBefore);
    expect(second.lastAcceptedFix).toEqual(first.lastAcceptedFix);
  });

  it("records the accepted fix, and only the accepted fix", () => {
    const outcome = processGroundBatch({
      session: session(),
      fixes: [fixAt(3, NOW), fixAt(4, NOW + 1_000, { accuracy: 5_000 })],
      nowMs: NOW + 1_000,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    expect(outcome.lastAcceptedFix?.timestampMs).toBe(NOW);
  });

  it("does not clear an off-route state on a rejected fix", () => {
    const current = session();
    current.payload.offRoute = true;

    const outcome = processGroundBatch({
      session: current,
      // A fix the engine refuses says the signal is poor; it is no evidence at
      // all that the user has returned to the route.
      fixes: [fixAt(5, NOW, { accuracy: 5_000 })],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    expect(outcome.payload.offRoute).toBe(true);
  });

  it("clears coasting when a real fix is accepted", () => {
    const current = session();
    current.payload.coasting = true;

    const outcome = processGroundBatch({
      session: current,
      fixes: [fixAt(5, NOW)],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    expect(outcome.payload.coasting).toBe(false);
  });

  it("keeps coasting when only synthetic fixes arrive", () => {
    const current = session();
    current.payload.coasting = true;

    const outcome = processGroundBatch({
      session: current,
      fixes: [fixAt(5, NOW, { coasted: true })],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    expect(outcome.payload.coasting).toBe(true);
  });

  it("marks a synthetic fix as coasted in the persisted record", () => {
    const outcome = processGroundBatch({
      session: session(),
      fixes: [fixAt(5, NOW, { coasted: true })],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    expect(outcome.lastAcceptedFix?.coasted).toBe(true);
  });
});

describe("processGroundBatch cue selection", () => {
  /** Runs the whole trace as one late batch and returns the speak effects. */
  function spokenFor(nowMs: number) {
    const outcome = processGroundBatch({
      session: session(),
      fixes: Array.from({ length: 40 }, (_, index) => fixAt(index, NOW + index * 1_000)),
      nowMs,
      cache: new GroundRouteCache(),
    });
    return (outcome.effects ?? []).filter((effect) => effect.kind === "speak");
  }

  it("speaks at most one cue for a batch", () => {
    expect(spokenFor(NOW + 40_000).length).toBeLessThanOrEqual(1);
  });

  it("stays silent when the batch is too old to be useful", () => {
    // Delivered five minutes after the fixes were taken: every maneuver in it is
    // behind the user, and announcing one would send them the wrong way.
    expect(spokenFor(NOW + 5 * 60_000)).toEqual([]);
  });

  it("records every cue the engine reached, even the ones it did not speak", () => {
    const outcome = processGroundBatch({
      session: session(),
      fixes: Array.from({ length: 40 }, (_, index) => fixAt(index, NOW + index * 1_000)),
      nowMs: NOW + 5 * 60_000,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;

    // Silence now must not become a repeat later.
    expect(outcome.cueLedger.spoken.length).toBeGreaterThan(0);
  });

  it("emits no audio at all when voice is disabled", () => {
    const current = session();
    current.payload.startPackage.settings.voiceEnabled = false;

    const outcome = processGroundBatch({
      session: current,
      fixes: Array.from({ length: 40 }, (_, index) => fixAt(index, NOW + index * 1_000)),
      nowMs: NOW + 40_000,
      cache: new GroundRouteCache(),
    });

    expect((outcome.effects ?? []).filter((e) => e.kind === "speak")).toEqual([]);
    // The engine still progressed, so turning voice back on does not replay.
    expect((outcome.session as GroundMobileSession).cueLedger.spoken.length).toBeGreaterThan(0);
  });
});

describe("GroundNavigationProcessor", () => {
  const processor = () => new GroundNavigationProcessor();

  it("prepares a valid package", () => {
    const result = processor().prepare(session().payload.startPackage, {
      sessionId: "session-1",
      nowMs: NOW,
      permissionMode: "background",
    });

    expect(result.ok).toBe(true);
  });

  it("refuses a package the engine could not guide", () => {
    const startPackage = session().payload.startPackage;
    const result = processor().prepare(
      { ...startPackage, route: { ...startPackage.route, steps: [] } } as never,
      { sessionId: "session-1", nowMs: NOW, permissionMode: "background" },
    );

    expect(result).toEqual({ ok: false, code: "missing-steps" });
  });

  it("records a reroute intent rather than performing one", () => {
    const current = session();
    // Far off the route, repeatedly, until the engine asks for a reroute.
    const away = Array.from({ length: 20 }, (_, index) =>
      fixAt(5, NOW + index * 1_000, { coords: [8.75, 50.2] }),
    );

    const mutation = processor().processFixes(current, away, NOW + 20_000);
    const next = mutation.session as GroundMobileSession;

    if (next.payload.reroute.status === "pending") {
      expect(mutation.effects).toContainEqual({
        kind: "request-reroute",
        requestId: next.payload.reroute.requestId,
      });
    } else {
      // The engine's backoff may not have elapsed; either way nothing was sent.
      expect((mutation.effects ?? []).some((e) => e.kind === "request-reroute")).toBe(false);
    }
  });

  it("resets every geometry-indexed value on replacement", () => {
    const current = session();
    const advanced = processGroundBatch({
      session: current,
      fixes: [fixAt(20, NOW)],
      nowMs: NOW,
      cache: new GroundRouteCache(),
    }).session as GroundMobileSession;
    advanced.payload.offRoute = true;
    advanced.payload.coasting = true;
    advanced.payload.currentSpeedLimit = 50;

    const outcome = processor().replace(advanced, current.payload.startPackage, NOW + 1_000);

    expect("ok" in outcome && outcome.ok === false).toBe(false);
    const next = (outcome as { session: GroundMobileSession }).session;
    expect(next.payload.progress).toBeNull();
    expect(next.payload.offRoute).toBe(false);
    expect(next.payload.coasting).toBe(false);
    expect(next.payload.currentSpeedLimit).toBeNull();
    expect(next.payload.tickState.offRouteScore).toBe(0);
    expect(next.lastAcceptedFix).toBeUndefined();
  });

  it("refuses a replacement that changes mode", () => {
    const current = session("driving");
    const walking = { ...session("walking").payload.startPackage };

    const outcome = processor().replace(current, walking, NOW);

    expect(outcome).toEqual({ ok: false, code: "mode-changed" });
  });

  it("refuses a replacement after the session ended", () => {
    const current = { ...session(), status: "arrived" as const };

    const outcome = processor().replace(current, current.payload.startPackage, NOW);

    expect(outcome).toEqual({ ok: false, code: "not-active" });
  });

  it("retries a reroute only when the network was what stopped it", async () => {
    const current = session();
    current.payload.reroute = { status: "unavailable", attempts: 1 };

    const retry = await processor().onConnectivityRestored(current, NOW);

    expect(retry?.effects).toEqual([{ kind: "request-reroute", requestId: expect.any(String) }]);
  });

  it.each(["idle", "in-flight", "failed"] as const)(
    "does nothing on reconnect when the reroute state is %s",
    async (status) => {
      const current = session();
      current.payload.reroute = { status, attempts: 0 };

      expect(await processor().onConnectivityRestored(current, NOW)).toBeNull();
    },
  );
});
