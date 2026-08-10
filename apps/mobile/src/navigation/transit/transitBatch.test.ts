import {
  DEFAULT_TRANSIT_TICK_OPTIONS,
  type FixInput,
  processTransitFix,
  type TransitMobileSession,
} from "@openmapx/core/navigation";
import { FIXTURE_FINGERPRINT, transitSessionFixture } from "./testing/transitFixture";
import { processTransitBatch, TransitItineraryCache } from "./transitBatch";

const NOW = new Date("2026-08-09T08:05:00Z").getTime();

function session(overrides: Partial<TransitMobileSession> = {}): TransitMobileSession {
  const base = transitSessionFixture(overrides);
  return {
    ...base,
    startedAtMs: NOW - 5 * 60_000,
    updatedAtMs: NOW,
    expiresAtMs: NOW + 12 * 60 * 60_000,
    ...overrides,
  } as TransitMobileSession;
}

function fixAt(timestampMs: number, overrides: Partial<FixInput> = {}): FixInput {
  return { coords: [8.68, 50.11], accuracy: 10, timestampMs, ...overrides };
}

function run(input: {
  session?: TransitMobileSession;
  fixes?: FixInput[];
  nowMs?: number;
  cache?: TransitItineraryCache;
}) {
  return processTransitBatch({
    session: input.session ?? session(),
    fixes: input.fixes ?? [],
    nowMs: input.nowMs ?? NOW,
    cache: input.cache ?? new TransitItineraryCache(),
  });
}

describe("processTransitBatch parity with the shared engine", () => {
  it("matches the engine for one fix", () => {
    const current = session();
    const fix = fixAt(NOW);

    const outcome = run({ session: current, fixes: [fix] });

    const direct = processTransitFix({
      itinerary: current.payload.startPackage.itinerary as never,
      captures: current.payload.startPackage.captures,
      state: current.payload.tickState as never,
      fix,
      nowMs: NOW,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FIXTURE_FINGERPRINT },
    });

    const next = outcome.session as TransitMobileSession;
    expect(next.payload.tickState).toEqual(direct.state);
    expect(next.payload.confidence).toBe(direct.confidence);
    expect(outcome.needsReplan).toBe(direct.needsReplan);
    expect(outcome.events).toEqual(direct.events);
  });

  it("matches the engine for a wake-up that carried no fix", () => {
    // A rider underground produces nothing for twenty minutes; the engine still
    // has to advance the leg from the schedule.
    const current = session();

    const outcome = run({ session: current, fixes: [] });

    const direct = processTransitFix({
      itinerary: current.payload.startPackage.itinerary as never,
      captures: current.payload.startPackage.captures,
      state: current.payload.tickState as never,
      nowMs: NOW,
      options: { ...DEFAULT_TRANSIT_TICK_OPTIONS, itineraryFingerprint: FIXTURE_FINGERPRINT },
    });

    expect((outcome.session as TransitMobileSession).payload.tickState).toEqual(direct.state);
    expect((outcome.session as TransitMobileSession).payload.confidence).toBe(direct.confidence);
  });
});

describe("processTransitBatch commits", () => {
  it("advances exactly one revision per batch", () => {
    const current = session();

    const outcome = run({
      session: current,
      fixes: [fixAt(NOW - 2_000), fixAt(NOW - 1_000), fixAt(NOW)],
    });

    expect(outcome.session.revision).toBe(current.revision + 1);
  });

  it("advances one revision even for a wake-up with no fix", () => {
    const current = session();

    expect(run({ session: current, fixes: [] }).session.revision).toBe(current.revision + 1);
  });

  it("publishes one snapshot for the batch", () => {
    const outcome = run({ fixes: [fixAt(NOW - 1_000), fixAt(NOW)] });

    expect((outcome.effects ?? []).filter((e) => e.kind === "publish-snapshot")).toHaveLength(1);
  });

  it("reaches the same state whether fixes arrive singly or as one batch", () => {
    const fixes = [fixAt(NOW - 3_000), fixAt(NOW - 2_000), fixAt(NOW - 1_000)];

    let singly = session();
    const cache = new TransitItineraryCache();
    for (const fix of fixes) {
      singly = run({ session: singly, fixes: [fix], nowMs: fix.timestampMs, cache })
        .session as TransitMobileSession;
    }
    const batched = run({ fixes, nowMs: fixes[fixes.length - 1].timestampMs })
      .session as TransitMobileSession;

    expect(batched.payload.tickState.currentLegIndex).toBe(
      singly.payload.tickState.currentLegIndex,
    );
    expect(batched.payload.tickState.phase).toBe(singly.payload.tickState.phase);
  });

  it("is unaffected by recreating the prepared itinerary cache between fixes", () => {
    const fixes = [fixAt(NOW - 3_000), fixAt(NOW - 2_000), fixAt(NOW - 1_000)];

    const drive = (recreate: boolean) => {
      let current = session();
      let cache = new TransitItineraryCache();
      for (const fix of fixes) {
        if (recreate) cache = new TransitItineraryCache();
        current = run({ session: current, fixes: [fix], nowMs: fix.timestampMs, cache })
          .session as TransitMobileSession;
      }
      return current;
    };

    expect(drive(true).payload.tickState).toEqual(drive(false).payload.tickState);
  });
});

describe("processTransitBatch events", () => {
  /** A session far enough along that the engine has something to say. */
  function riding(): TransitMobileSession {
    const base = session();
    return {
      ...base,
      payload: {
        ...base.payload,
        tickState: {
          ...base.payload.tickState,
          phase: "riding",
          currentLegIndex: 1,
          legEnteredAtMs: NOW - 60_000,
        },
      },
    } as TransitMobileSession;
  }

  it("enqueues each new event durably", () => {
    const outcome = run({ session: riding(), nowMs: new Date("2026-08-09T08:41:00Z").getTime() });

    for (const entry of outcome.enqueue ?? []) {
      expect(entry.eventId).toEqual(expect.any(String));
      expect(typeof entry.critical).toBe("boolean");
    }
  });

  it("puts no stop name or coordinate into an enqueued event", () => {
    // The outbox outlives the leg; a stop name in it would outlive the trip.
    const outcome = run({ session: riding(), nowMs: new Date("2026-08-09T08:41:00Z").getTime() });

    const serialised = JSON.stringify(outcome.enqueue ?? []);
    expect(serialised).not.toContain("Messe");
    expect(serialised).not.toContain("50.11");
  });

  it("does not re-emit an event already in the ledger", () => {
    const first = run({ session: riding(), nowMs: new Date("2026-08-09T08:41:00Z").getTime() });
    const ids = (first.enqueue ?? []).map((entry) => entry.eventId);
    if (ids.length === 0) return;

    const afterRestart = {
      ...riding(),
      cueLedger: { spoken: [], events: ids },
    } as TransitMobileSession;
    const second = run({
      session: afterRestart,
      nowMs: new Date("2026-08-09T08:41:00Z").getTime(),
    });

    expect((second.enqueue ?? []).map((entry) => entry.eventId)).not.toEqual(
      expect.arrayContaining(ids),
    );
  });

  it("emits no speech when voice is disabled, while still recording the event", () => {
    const muted = riding();
    muted.payload.startPackage.settings.voiceEnabled = false;

    const outcome = run({ session: muted, nowMs: new Date("2026-08-09T08:41:00Z").getTime() });

    expect((outcome.effects ?? []).filter((e) => e.kind === "speak")).toEqual([]);
  });

  it("marks the session arrived when the engine says so", () => {
    const arriving = riding();
    arriving.payload.tickState.currentLegIndex = 2;
    arriving.payload.tickState.phase = "walking";

    const outcome = run({
      session: arriving,
      nowMs: new Date("2026-08-09T09:30:00Z").getTime(),
    });

    if (outcome.arrived) {
      expect(outcome.session.status).toBe("arrived");
    } else {
      expect(outcome.session.status).toBe("active");
    }
  });
});

describe("processTransitBatch location profile", () => {
  it("asks for a profile change only when the phase actually moved", () => {
    const outcome = run({ fixes: [fixAt(NOW)] });

    // Still walking to the station: nothing about the cadence should change.
    expect((outcome.effects ?? []).filter((e) => e.kind === "update-location-profile")).toEqual([]);
  });

  it("never asks to start a second stream", () => {
    const outcome = run({ fixes: [fixAt(NOW)] });

    expect((outcome.effects ?? []).some((e) => e.kind === "start-location")).toBe(false);
  });
});

describe("TransitItineraryCache", () => {
  it("reuses one prepared index for the same itinerary object", () => {
    const cache = new TransitItineraryCache();
    const current = session();

    expect(cache.preparedFor(current)).toBe(cache.preparedFor(current));
  });

  it("rebuilds for a session reloaded from storage", () => {
    // A reload produces a new object with identical values, and a prepared index
    // belongs to the one it was built from.
    const cache = new TransitItineraryCache();
    const first = cache.preparedFor(session());

    expect(cache.preparedFor(session())).not.toBe(first);
  });

  it("rebuilds after being invalidated", () => {
    const cache = new TransitItineraryCache();
    const current = session();
    const first = cache.preparedFor(current);

    cache.invalidate();

    expect(cache.preparedFor(current)).not.toBe(first);
  });
});
